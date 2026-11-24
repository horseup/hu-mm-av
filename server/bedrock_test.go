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

func TestBedrockTranscribeSendsSignedConverseRequest(t *testing.T) {
	audio := []byte("RIFF....WAVEfmt fake audio")
	var gotPath, gotAuth, gotToken string
	var got converseRequest
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotAuth, gotToken = r.URL.Path, r.Header.Get("Authorization"), r.Header.Get("X-Amz-Security-Token")
		body, _ := io.ReadAll(r.Body)
		if err := json.Unmarshal(body, &got); err != nil {
			t.Errorf("request body is not JSON: %v", err)
		}
		if !strings.Contains(string(body), base64.StdEncoding.EncodeToString(audio)) {
			t.Errorf("audio bytes are not base64 in the body")
		}
		_, _ = w.Write([]byte(`{"output":{"message":{"content":[{"text":" Hallo Team, kurzes Update. "}]}}}`))
	}))
	defer srv.Close()

	b := &bedrockTranscriber{
		httpClient: srv.Client(), endpoint: srv.URL, region: "eu-west-1", modelID: "mistral.voxtral-mini-3b-2507",
		creds:        aws.Credentials{AccessKeyID: "AKIDEXAMPLE", SecretAccessKey: "secret", SessionToken: "token"},
		languageHint: "German", now: func() time.Time { return time.Date(2026, 11, 24, 12, 0, 0, 0, time.UTC) },
	}
	text, err := b.Transcribe(context.Background(), audio, "wav")
	if err != nil {
		t.Fatalf("Transcribe: %v", err)
	}
	if text != "Hallo Team, kurzes Update." {
		t.Errorf("text = %q, want trimmed transcript", text)
	}
	if gotPath != "/model/mistral.voxtral-mini-3b-2507/converse" {
		t.Errorf("path = %q", gotPath)
	}
	if !strings.HasPrefix(gotAuth, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20261124/eu-west-1/bedrock/aws4_request") {
		t.Errorf("Authorization = %q, want SigV4 for bedrock in eu-west-1", gotAuth)
	}
	if gotToken != "token" {
		t.Errorf("session token header = %q", gotToken)
	}
	if len(got.Messages) != 1 || got.Messages[0].Content[0].Audio == nil || got.Messages[0].Content[0].Audio.Format != "wav" {
		t.Fatalf("audio block missing or wrong format: %+v", got.Messages)
	}
	prompt := got.Messages[0].Content[1].Text
	if !strings.Contains(prompt, "Never translate") || !strings.Contains(prompt, "most likely speaks German") || !strings.Contains(prompt, "exact words") {
		t.Errorf("prompt = %q, want no-translate instruction, language hint and exact-words rule", prompt)
	}
	if got.InferenceConfig.Temperature != 0 {
		t.Errorf("temperature = %v, want 0", got.InferenceConfig.Temperature)
	}
}

func TestBedrockTranscribeReturnsServiceError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
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
		`"Bitte tragt es ein."`:     "Bitte tragt es ein.",
		"„Bitte tragt es ein.“":     "Bitte tragt es ein.",
		` Er sagte "ja" und ging. `: `Er sagte "ja" und ging.`,
		`"Eins" und "zwei"`:         `"Eins" und "zwei"`,
		"[no speech]":               "",
		" [No speech]. ":            "",
		"No speech":                 "",
		"[00:00] Hallo Team.":       "Hallo Team.",
	}
	for in, want := range cases {
		if got := cleanTranscript(in); got != want {
			t.Errorf("cleanTranscript(%q) = %q, want %q", in, got, want)
		}
	}
}
