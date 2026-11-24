package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
)

const (
	voicePostType          = "custom_hu_voice"
	maxChunkBytes          = 2 << 20 // ~60 s of 16 kHz mono WAV; Bedrock rejects larger requests
	maxChunks              = 200
	maxPeaks               = 128
	chunkTTLSeconds        = 30 * 60
	chunkRequestsPerMinute = 90
	transcribeTimeout      = 25 * time.Second
)

var sessionPattern = regexp.MustCompile(`^[A-Za-z0-9]{8,32}$`)

func (p *Plugin) routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/v1/config", p.requireUser(p.handleConfig))
	mux.HandleFunc("POST /api/v1/stt/chunk", p.requireUser(p.handleChunk))
	mux.HandleFunc("POST /api/v1/voice", p.requireUser(p.handleVoice))
	return mux
}

type userHandler func(w http.ResponseWriter, r *http.Request, userID string)

// requireUser only lets requests through that Mattermost authenticated (it sets Mattermost-User-Id).
func (p *Plugin) requireUser(next userHandler) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		userID := r.Header.Get("Mattermost-User-Id")
		if userID == "" {
			writeError(w, http.StatusUnauthorized, "not authenticated")
			return
		}
		next(w, r, userID)
	}
}

func (p *Plugin) handleConfig(w http.ResponseWriter, _ *http.Request, _ string) {
	cfg := p.getConfiguration()
	writeJSON(w, http.StatusOK, map[string]any{
		"transcription":    cfg.transcriptionReady(),
		"max_duration_sec": cfg.maxDurationSeconds(),
	})
}

// handleChunk transcribes one ~5–20 s WAV chunk while the user is still recording and keeps the text
// for handleVoice, so the transcript is complete the moment the message is sent.
func (p *Plugin) handleChunk(w http.ResponseWriter, r *http.Request, userID string) {
	cfg := p.getConfiguration()
	if !cfg.transcriptionReady() {
		writeError(w, http.StatusServiceUnavailable, "transcription is not configured")
		return
	}
	q := r.URL.Query()
	channelID, session := q.Get("channel_id"), q.Get("session")
	seq, err := strconv.Atoi(q.Get("seq"))
	if !model.IsValidId(channelID) || !sessionPattern.MatchString(session) || err != nil || seq < 0 || seq >= maxChunks {
		writeError(w, http.StatusBadRequest, "invalid channel_id, session or seq")
		return
	}
	if !p.API.HasPermissionToChannel(userID, channelID, model.PermissionCreatePost) {
		writeError(w, http.StatusForbidden, "no permission to post in this channel")
		return
	}
	if !p.limiter.allow(userID) {
		writeError(w, http.StatusTooManyRequests, "too many requests")
		return
	}
	audio, err := io.ReadAll(io.LimitReader(r.Body, maxChunkBytes+1))
	if err != nil || len(audio) > maxChunkBytes || !isWAV(audio) {
		writeError(w, http.StatusBadRequest, "body must be a WAV file of at most 2 MB")
		return
	}

	stt, err := p.newTranscriber(cfg)
	if err != nil {
		p.logError("Could not create transcriber", err)
		writeError(w, http.StatusServiceUnavailable, "transcription is not configured")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), transcribeTimeout)
	defer cancel()
	text, err := stt.Transcribe(ctx, audio, "wav")
	if err != nil {
		p.logError("Transcription failed", err)
		writeError(w, http.StatusBadGateway, "transcription failed")
		return
	}
	if appErr := p.API.KVSetWithExpiry(chunkKey(userID, session, seq), []byte(text), chunkTTLSeconds); appErr != nil {
		p.logError("Could not store chunk transcript", appErr)
		writeError(w, http.StatusInternalServerError, "could not store transcript")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"seq": seq, "text": text})
}

type voiceRequest struct {
	ChannelID  string `json:"channel_id"`
	RootID     string `json:"root_id"`
	FileID     string `json:"file_id"`
	DurationMs int    `json:"duration_ms"`
	Peaks      []int  `json:"peaks"`
	Session    string `json:"session"`
	Chunks     int    `json:"chunks"`
}

// handleVoice turns an uploaded audio file into a voice post. The browser uploads the file itself through
// the normal files API, so the file belongs to the user; this checks it, adds the transcript and posts.
func (p *Plugin) handleVoice(w http.ResponseWriter, r *http.Request, userID string) {
	var req voiceRequest
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	cfg := p.getConfiguration()
	if msg := req.validate(cfg.maxDurationSeconds()); msg != "" {
		writeError(w, http.StatusBadRequest, msg)
		return
	}
	if !p.API.HasPermissionToChannel(userID, req.ChannelID, model.PermissionCreatePost) {
		writeError(w, http.StatusForbidden, "no permission to post in this channel")
		return
	}
	info, appErr := p.API.GetFileInfo(req.FileID)
	if appErr != nil || info.CreatorId != userID || info.PostId != "" || info.ChannelId != req.ChannelID || !strings.HasPrefix(info.MimeType, "audio/") {
		writeError(w, http.StatusForbidden, "file must be your own, unattached audio upload in this channel")
		return
	}
	if req.RootID != "" {
		root, appErr := p.API.GetPost(req.RootID)
		if appErr != nil || root.ChannelId != req.ChannelID {
			writeError(w, http.StatusBadRequest, "root post is not in this channel")
			return
		}
	}

	transcript, status := p.collectTranscript(userID, req.Session, req.Chunks, cfg.transcriptionReady())
	hv := map[string]any{
		"duration_ms":       req.DurationMs,
		"mime":              info.MimeType,
		"peaks":             req.Peaks,
		"transcript":        transcript,
		"transcript_status": status,
	}
	if status != "none" {
		hv["stt_model"] = cfg.modelID()
	}
	post := &model.Post{
		UserId:    userID,
		ChannelId: req.ChannelID,
		RootId:    req.RootID,
		Type:      voicePostType,
		Message:   voiceMessage(req.DurationMs, transcript),
		FileIds:   model.StringArray{req.FileID},
	}
	post.AddProp("hu_voice", hv)
	created, appErr := p.API.CreatePost(post)
	if appErr != nil {
		p.logError("Could not create voice post", appErr)
		writeError(w, http.StatusInternalServerError, "could not create post")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"post_id": created.Id, "transcript_status": status})
}

func (req *voiceRequest) validate(maxDurationSec int) string {
	switch {
	case !model.IsValidId(req.ChannelID):
		return "invalid channel_id"
	case req.RootID != "" && !model.IsValidId(req.RootID):
		return "invalid root_id"
	case !model.IsValidId(req.FileID):
		return "invalid file_id"
	case req.DurationMs <= 0 || req.DurationMs > (maxDurationSec+5)*1000:
		return "invalid duration"
	case len(req.Peaks) > maxPeaks:
		return "too many peaks"
	case req.Chunks < 0 || req.Chunks > maxChunks:
		return "invalid chunk count"
	case req.Chunks > 0 && !sessionPattern.MatchString(req.Session):
		return "invalid session"
	}
	for _, v := range req.Peaks {
		if v < 0 || v > 100 {
			return "peaks must be 0–100"
		}
	}
	return ""
}

// collectTranscript joins the chunk texts stored during recording and removes them.
func (p *Plugin) collectTranscript(userID, session string, chunks int, enabled bool) (string, string) {
	if !enabled || chunks == 0 {
		return "", "none"
	}
	parts := make([]string, 0, chunks)
	missing := 0
	for seq := 0; seq < chunks; seq++ {
		key := chunkKey(userID, session, seq)
		v, appErr := p.API.KVGet(key)
		if appErr != nil || v == nil {
			missing++
			continue
		}
		if t := strings.TrimSpace(string(v)); t != "" {
			parts = append(parts, t)
		}
		_ = p.API.KVDelete(key)
	}
	text := strings.Join(parts, " ")
	switch {
	case missing == chunks:
		return "", "failed"
	case text == "":
		return "", "none"
	case missing > 0:
		return text, "partial"
	default:
		return text, "done"
	}
}

// voiceMessage is the plain message text, which is what mobile apps show.
func voiceMessage(durationMs int, transcript string) string {
	secs := (durationMs + 500) / 1000
	msg := fmt.Sprintf("🎤 %d:%02d", secs/60, secs%60)
	if transcript != "" {
		msg += " · " + transcript
	}
	return msg
}

func chunkKey(userID, session string, seq int) string {
	return fmt.Sprintf("stt_%s_%s_%03d", userID, session, seq)
}

func isWAV(b []byte) bool {
	return len(b) > 44 && bytes.Equal(b[0:4], []byte("RIFF")) && bytes.Equal(b[8:12], []byte("WAVE"))
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// rateLimiter is a per-user sliding window for chunk requests.
type rateLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string][]time.Time
	now    func() time.Time
}

func newRateLimiter(perMinute int) *rateLimiter {
	return &rateLimiter{limit: perMinute, window: time.Minute, hits: map[string][]time.Time{}, now: time.Now}
}

func (l *rateLimiter) allow(key string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	recent := l.hits[key][:0]
	for _, t := range l.hits[key] {
		if now.Sub(t) < l.window {
			recent = append(recent, t)
		}
	}
	if len(recent) >= l.limit {
		l.hits[key] = recent
		return false
	}
	l.hits[key] = append(recent, now)
	return true
}
