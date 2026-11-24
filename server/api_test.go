package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/mock"
)

var (
	userID    = model.NewId()
	channelID = model.NewId()
	fileID    = model.NewId()
)

type fakeSTT struct {
	text  string
	err   error
	calls int
}

func (f *fakeSTT) Transcribe(context.Context, []byte, string) (string, error) {
	f.calls++
	return f.text, f.err
}

func newTestPlugin(t *testing.T, api *plugintest.API, stt transcriber) *Plugin {
	t.Helper()
	t.Setenv("AWS_ACCESS_KEY_ID", "test")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "test")
	p := &Plugin{newTranscriber: func(*configuration) (transcriber, error) { return stt, nil }}
	p.SetAPI(api)
	p.configuration = &configuration{EnableTranscription: true, LanguageHint: "German"}
	if err := p.OnActivate(); err != nil {
		t.Fatal(err)
	}
	return p
}

func do(p *Plugin, method, target, user, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, target, strings.NewReader(body))
	if user != "" {
		r.Header.Set("Mattermost-User-Id", user)
	}
	w := httptest.NewRecorder()
	p.ServeHTTP(nil, w, r)
	return w
}

func wav() string { return "RIFF\x00\x00\x00\x00WAVEfmt " + strings.Repeat("\x00", 64) }

func TestEndpointsRequireAuthenticatedUser(t *testing.T) {
	p := newTestPlugin(t, &plugintest.API{}, &fakeSTT{})
	for _, path := range []string{"/api/v1/stt/chunk", "/api/v1/voice"} {
		if w := do(p, http.MethodPost, path, "", ""); w.Code != http.StatusUnauthorized {
			t.Errorf("%s without user: status %d, want 401", path, w.Code)
		}
	}
}

func TestChunkTranscribesAndStoresText(t *testing.T) {
	api := &plugintest.API{}
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionCreatePost).Return(true)
	api.On("KVSetWithExpiry", chunkKey(userID, "abcdefgh12", 3), []byte("Hallo Team"), int64(chunkTTLSeconds)).Return(nil)
	stt := &fakeSTT{text: "Hallo Team"}
	p := newTestPlugin(t, api, stt)

	w := do(p, http.MethodPost, "/api/v1/stt/chunk?channel_id="+channelID+"&session=abcdefgh12&seq=3", userID, wav())
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	var res struct {
		Seq  int    `json:"seq"`
		Text string `json:"text"`
	}
	_ = json.Unmarshal(w.Body.Bytes(), &res)
	if res.Seq != 3 || res.Text != "Hallo Team" || stt.calls != 1 {
		t.Errorf("response %+v, calls %d", res, stt.calls)
	}
	api.AssertExpectations(t)
}

func TestChunkRejectsBadInput(t *testing.T) {
	api := &plugintest.API{}
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionCreatePost).Return(true)
	stt := &fakeSTT{text: "x"}
	p := newTestPlugin(t, api, stt)

	cases := map[string]struct {
		query, body string
		want        int
	}{
		"bad session": {"channel_id=" + channelID + "&session=x&seq=0", wav(), http.StatusBadRequest},
		"bad seq":     {"channel_id=" + channelID + "&session=abcdefgh12&seq=999", wav(), http.StatusBadRequest},
		"not a wav":   {"channel_id=" + channelID + "&session=abcdefgh12&seq=0", "ftypM4A audio", http.StatusBadRequest},
	}
	for name, c := range cases {
		if w := do(p, http.MethodPost, "/api/v1/stt/chunk?"+c.query, userID, c.body); w.Code != c.want {
			t.Errorf("%s: status %d, want %d", name, w.Code, c.want)
		}
	}
	if stt.calls != 0 {
		t.Errorf("transcriber called %d times for invalid input", stt.calls)
	}
}

func TestChunkChecksChannelPermission(t *testing.T) {
	api := &plugintest.API{}
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionCreatePost).Return(false)
	stt := &fakeSTT{text: "x"}
	p := newTestPlugin(t, api, stt)
	if w := do(p, http.MethodPost, "/api/v1/stt/chunk?channel_id="+channelID+"&session=abcdefgh12&seq=0", userID, wav()); w.Code != http.StatusForbidden {
		t.Errorf("status %d, want 403", w.Code)
	}
	if stt.calls != 0 {
		t.Errorf("transcriber called without permission")
	}
}

func voiceBody(chunks int) string {
	b, _ := json.Marshal(voiceRequest{ChannelID: channelID, FileID: fileID, DurationMs: 12400, Peaks: []int{10, 80, 40}, Session: "abcdefgh12", Chunks: chunks})
	return string(b)
}

func TestVoiceRejectsSomeoneElsesFile(t *testing.T) {
	api := &plugintest.API{}
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionCreatePost).Return(true)
	api.On("GetFileInfo", fileID).Return(&model.FileInfo{Id: fileID, CreatorId: model.NewId(), ChannelId: channelID, MimeType: "audio/mp4"}, nil)
	p := newTestPlugin(t, api, &fakeSTT{})
	if w := do(p, http.MethodPost, "/api/v1/voice", userID, voiceBody(0)); w.Code != http.StatusForbidden {
		t.Errorf("status %d, want 403", w.Code)
	}
	api.AssertNotCalled(t, "CreatePost", mock.Anything)
}

func TestVoiceCreatesPostWithJoinedTranscript(t *testing.T) {
	api := &plugintest.API{}
	api.On("HasPermissionToChannel", userID, channelID, model.PermissionCreatePost).Return(true)
	api.On("GetFileInfo", fileID).Return(&model.FileInfo{Id: fileID, CreatorId: userID, ChannelId: channelID, MimeType: "audio/mp4"}, nil)
	api.On("KVGet", chunkKey(userID, "abcdefgh12", 0)).Return([]byte("Hallo Team,"), nil)
	api.On("KVGet", chunkKey(userID, "abcdefgh12", 1)).Return([]byte("kurzes Update."), nil)
	api.On("KVDelete", mock.Anything).Return(nil)
	var created *model.Post
	api.On("CreatePost", mock.AnythingOfType("*model.Post")).Run(func(args mock.Arguments) {
		created = args.Get(0).(*model.Post)
	}).Return(&model.Post{Id: model.NewId()}, nil)
	p := newTestPlugin(t, api, &fakeSTT{})

	w := do(p, http.MethodPost, "/api/v1/voice", userID, voiceBody(2))
	if w.Code != http.StatusOK {
		t.Fatalf("status %d: %s", w.Code, w.Body.String())
	}
	if created == nil {
		t.Fatal("CreatePost not called")
	}
	if created.Type != voicePostType || created.UserId != userID || len(created.FileIds) != 1 || created.FileIds[0] != fileID {
		t.Errorf("post = %+v", created)
	}
	if created.Message != "🎤 0:12 · Hallo Team, kurzes Update." {
		t.Errorf("message = %q", created.Message)
	}
	hv, _ := created.GetProp("hu_voice").(map[string]any)
	if hv["transcript"] != "Hallo Team, kurzes Update." || hv["transcript_status"] != "done" {
		t.Errorf("hu_voice props = %+v", hv)
	}
}

func TestCollectTranscriptStatuses(t *testing.T) {
	api := &plugintest.API{}
	api.On("KVGet", chunkKey(userID, "abcdefgh12", 0)).Return([]byte("eins"), nil)
	api.On("KVGet", chunkKey(userID, "abcdefgh12", 1)).Return(nil, nil)
	api.On("KVDelete", mock.Anything).Return(nil)
	p := newTestPlugin(t, api, &fakeSTT{})

	if text, status := p.collectTranscript(userID, "abcdefgh12", 2, true); text != "eins" || status != "partial" {
		t.Errorf("one of two chunks: %q %q, want partial", text, status)
	}
	if _, status := p.collectTranscript(userID, "abcdefgh12", 0, true); status != "none" {
		t.Errorf("no chunks: %q, want none", status)
	}
	if _, status := p.collectTranscript(userID, "abcdefgh12", 2, false); status != "none" {
		t.Errorf("disabled: %q, want none", status)
	}
}

func TestRateLimiterBlocksBurst(t *testing.T) {
	l := newRateLimiter(2)
	if !l.allow("u") || !l.allow("u") || l.allow("u") {
		t.Error("third request within a minute should be blocked")
	}
	if !l.allow("other") {
		t.Error("limits are per user")
	}
}
