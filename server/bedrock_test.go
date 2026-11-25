package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
)

// fakeBedrock answers the language question with detected and every other prompt with transcript, and records
// the prompts it was sent.
func fakeBedrock(t *testing.T, detected, transcript string, audio []byte) (*httptest.Server, *[]string, *[]string) {
	t.Helper()
	var prompts, auths []string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/model/mistral.voxtral-small-24b-2507/converse" {
			t.Errorf("path = %q", r.URL.Path)
		}
		if r.Header.Get("X-Amz-Security-Token") != "token" {
			t.Errorf("session token header = %q", r.Header.Get("X-Amz-Security-Token"))
		}
		auths = append(auths, r.Header.Get("Authorization"))
		body, _ := io.ReadAll(r.Body)
		var got converseRequest
		if err := json.Unmarshal(body, &got); err != nil {
			t.Errorf("request body is not JSON: %v", err)
		}
		if !strings.Contains(string(body), base64.StdEncoding.EncodeToString(audio)) {
			t.Errorf("audio bytes are not base64 in the body")
		}
		if len(got.Messages) != 1 || got.Messages[0].Content[0].Audio == nil || got.Messages[0].Content[0].Audio.Format != "wav" {
			t.Fatalf("audio block missing or wrong format: %+v", got.Messages)
		}
		if got.InferenceConfig.Temperature != 0 {
			t.Errorf("temperature = %v, want 0", got.InferenceConfig.Temperature)
		}
		prompt := got.Messages[0].Content[1].Text
		prompts = append(prompts, prompt)
		answer := transcript
		if prompt == detectPrompt {
			answer = detected
		}
		out, _ := json.Marshal(map[string]any{"output": map[string]any{"message": map[string]any{"content": []map[string]string{{"text": answer}}}}})
		_, _ = w.Write(out)
	}))
	t.Cleanup(srv.Close)
	return srv, &prompts, &auths
}

func testTranscriber(srv *httptest.Server, hint string) *bedrockTranscriber {
	return &bedrockTranscriber{
		httpClient: srv.Client(), endpoint: srv.URL, region: "eu-west-1", modelID: "mistral.voxtral-small-24b-2507",
		creds:        aws.Credentials{AccessKeyID: "AKIDEXAMPLE", SecretAccessKey: "secret", SessionToken: "token"},
		languageHint: hint, now: func() time.Time { return time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC) },
	}
}

func TestBedrockTranscribeAsksForTheLanguageThenTranscribesInIt(t *testing.T) {
	audio := []byte("RIFF....WAVEfmt fake audio")
	srv, prompts, auths := fakeBedrock(t, "English", " Hi team, quick update. ", audio)

	text, err := testTranscriber(srv, "German").Transcribe(context.Background(), audio, "wav")
	if err != nil {
		t.Fatalf("Transcribe: %v", err)
	}
	if text != "Hi team, quick update." {
		t.Errorf("text = %q, want trimmed transcript", text)
	}
	if len(*prompts) != 2 || (*prompts)[0] != detectPrompt {
		t.Fatalf("prompts = %q, want the language question first, then the transcription", *prompts)
	}
	second := (*prompts)[1]
	if !strings.Contains(second, "The speaker speaks English; write the transcript in English.") || strings.Contains(second, "German") {
		t.Errorf("second prompt = %q, want the detected language and not the fallback", second)
	}
	if !strings.Contains(second, "Never translate") || !strings.Contains(second, "exact words") || !strings.Contains(second, noSpeechMarker) {
		t.Errorf("second prompt = %q, want no-translate, exact-words and no-speech rules", second)
	}
	for _, a := range *auths {
		if !strings.HasPrefix(a, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261124/eu-west-1/bedrock/aws4_request") {
			t.Errorf("Authorization = %q, want SigV4 for bedrock in eu-west-1", a)
		}
	}
}

func TestBedrockTranscribeSkipsAudioWithoutSpeech(t *testing.T) {
	srv, prompts, _ := fakeBedrock(t, "None", "I'm going to go ahead and get started.", []byte("x"))
	text, err := testTranscriber(srv, "German").Transcribe(context.Background(), []byte("x"), "wav")
	if err != nil || text != "" {
		t.Fatalf("Transcribe = %q, %v; want empty transcript", text, err)
	}
	if len(*prompts) != 1 {
		t.Errorf("sent %d requests, want only the language question", len(*prompts))
	}
}

func TestBedrockTranscribeFallsBackToTheConfiguredLanguage(t *testing.T) {
	srv, prompts, _ := fakeBedrock(t, "Klingon, probably.", "Hallo zusammen.", []byte("x"))
	if _, err := testTranscriber(srv, "German").Transcribe(context.Background(), []byte("x"), "wav"); err != nil {
		t.Fatal(err)
	}
	if len(*prompts) != 2 || !strings.Contains((*prompts)[1], "write the transcript in German.") || strings.Contains((*prompts)[1], "Klingon") {
		t.Errorf("prompts = %q, want the fallback language and never the raw answer", *prompts)
	}

	srv, prompts, _ = fakeBedrock(t, "?", "Hallo zusammen.", []byte("x"))
	if _, err := testTranscriber(srv, "").Transcribe(context.Background(), []byte("x"), "wav"); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains((*prompts)[1], "in the language that is spoken") {
		t.Errorf("prompt without any language = %q", (*prompts)[1])
	}
}

func TestParseLanguage(t *testing.T) {
	cases := []struct {
		answer   string
		language string
		speech   bool
	}{
		{"German", "German", true},
		{" english.", "English", true},
		{"The language spoken in this audio is English", "English", true},
		{"None", "", false},
		{"none.", "", false},
		{"There is no speech in this audio.", "", false},
		{"Klingon", "", true},
		{"", "", true},
	}
	for _, c := range cases {
		if l, sp := parseLanguage(c.answer); l != c.language || sp != c.speech {
			t.Errorf("parseLanguage(%q) = %q, %v; want %q, %v", c.answer, l, sp, c.language, c.speech)
		}
	}
}

func TestBedrockTranscribeReturnsServiceError(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		w.WriteHeader(http.StatusBadRequest)
		_, _ = w.Write([]byte(`{"message":"This model doesn't support the audio format"}`))
	}))
	defer srv.Close()
	b := &bedrockTranscriber{httpClient: srv.Client(), endpoint: srv.URL, region: "eu-west-1", modelID: "m",
		creds: aws.Credentials{AccessKeyID: "a", SecretAccessKey: "b"}, now: time.Now}
	_, err := b.Transcribe(context.Background(), []byte("x"), "m4a")
	if err == nil || !strings.Contains(err.Error(), "400") || !strings.Contains(err.Error(), "audio format") {
		t.Fatalf("err = %v, want status and service message", err)
	}
	if calls != 1 {
		t.Errorf("sent %d requests, want no retry for a 400", calls)
	}
}

func TestBedrockRetriesOnceWhenThrottled(t *testing.T) {
	retryDelay = time.Millisecond
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		body, _ := io.ReadAll(r.Body)
		switch {
		case calls == 1:
			w.WriteHeader(http.StatusTooManyRequests)
			_, _ = w.Write([]byte(`{"message":"Too many requests"}`))
		case strings.Contains(string(body), "Which language"):
			_, _ = w.Write([]byte(`{"output":{"message":{"content":[{"text":"German"}]}}}`))
		default:
			_, _ = w.Write([]byte(`{"output":{"message":{"content":[{"text":"Hallo zusammen."}]}}}`))
		}
	}))
	defer srv.Close()
	text, err := testTranscriber(srv, "").Transcribe(context.Background(), []byte("x"), "wav")
	if err != nil || text != "Hallo zusammen." || calls != 3 {
		t.Fatalf("Transcribe = %q, %v after %d requests; want the transcript after one retry", text, err, calls)
	}
}

func TestCredentialsPreferSettingsThenEnvironment(t *testing.T) {
	t.Setenv("AWS_ACCESS_KEY_ID", "envid")
	t.Setenv("AWS_SECRET_ACCESS_KEY", "envsecret")
	t.Setenv("AWS_SESSION_TOKEN", "envtoken")

	c := &configuration{AWSAccessKeyID: "setid", AWSSecretAccessKey: "setsecret"}
	if creds, ok := c.credentials(); !ok || creds.AccessKeyID != "setid" || creds.SessionToken != "" {
		t.Errorf("settings credentials not preferred: %+v", creds)
	}
	c = &configuration{}
	if creds, ok := c.credentials(); !ok || creds.AccessKeyID != "envid" || creds.SessionToken != "envtoken" {
		t.Errorf("environment credentials not used: %+v", creds)
	}
	t.Setenv("AWS_ACCESS_KEY_ID", "")
	if _, ok := c.credentials(); ok {
		t.Errorf("credentials reported without any configured")
	}
}

func TestCleanTranscriptStripsWrappingQuotes(t *testing.T) {
	cases := map[string]string{
		`"Bitte tragt es ein."`:              "Bitte tragt es ein.",
		"„Bitte tragt es ein.“":              "Bitte tragt es ein.",
		` Er sagte "ja" und ging. `:          `Er sagte "ja" und ging.`,
		`"Eins" und "zwei"`:                  `"Eins" und "zwei"`,
		"[no speech]":                        "",
		" [No speech]. ":                     "",
		"No speech":                          "",
		"[00:00] Hallo Team.":                "Hallo Team.",
		"[keine Rede]":                       "",
		"[Musik].":                           "",
		"[Name] kommt morgen.":               "[Name] kommt morgen.",
		"I'm sorry, I can't help with that.": "",
		"I'm sorry, I can't make it today.":  "I'm sorry, I can't make it today.",
		"The speaker speaks English; write the transcript in English. Keep the speaker's exact words":        "",
		"Transcribe this voice message verbatim. The speaker speaks German; write the transcript in German.": "",
		"Keep the speaker’s exact words, grammar and form of address. Output only the transcript.":           "",
		"Can you transcribe this voice message for me?":                                                      "Can you transcribe this voice message for me?",
		"Transcribe this voice message and send it to Anna, please.":                                         "Transcribe this voice message and send it to Anna, please.",
		"The speaker speaks too fast, please slow down.":                                                     "The speaker speaks too fast, please slow down.",
	}
	for in, want := range cases {
		if got := cleanTranscript(in); got != want {
			t.Errorf("cleanTranscript(%q) = %q, want %q", in, got, want)
		}
	}
}
