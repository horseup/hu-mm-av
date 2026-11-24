package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/aws/aws-sdk-go-v2/aws"
	v4 "github.com/aws/aws-sdk-go-v2/aws/signer/v4"
)

// transcriber turns one audio chunk into text.
type transcriber interface {
	Transcribe(ctx context.Context, audio []byte, format string) (string, error)
}

// bedrockTranscriber calls the Bedrock Converse API with an audio content block. It signs requests with
// SigV4 directly instead of pulling in the full AWS SDK, which keeps the plugin binary small.
type bedrockTranscriber struct {
	httpClient   *http.Client
	endpoint     string // https://bedrock-runtime.<region>.amazonaws.com unless overridden in tests
	region       string
	modelID      string
	creds        aws.Credentials
	languageHint string
	now          func() time.Time
}

func newBedrockTranscriber(cfg *configuration) (*bedrockTranscriber, error) {
	creds, ok := cfg.credentials()
	if !ok {
		return nil, errors.New("no AWS credentials configured")
	}
	return &bedrockTranscriber{
		httpClient:   &http.Client{Timeout: 30 * time.Second},
		endpoint:     fmt.Sprintf("https://bedrock-runtime.%s.amazonaws.com", cfg.region()),
		region:       cfg.region(),
		modelID:      cfg.modelID(),
		creds:        creds,
		languageHint: strings.TrimSpace(cfg.LanguageHint),
		now:          time.Now,
	}, nil
}

// transcriptionPrompt asks for a verbatim transcript. In testing, Voxtral translated short German clips into
// English without "never translate". Passing the previous chunk's text as context made it worse: the model
// continued that text instead of transcribing the new audio, so chunks are transcribed on their own.
func transcriptionPrompt(languageHint string) string {
	var b strings.Builder
	b.WriteString("Transcribe this voice message verbatim, in the language that is spoken.")
	if languageHint != "" {
		b.WriteString(" The speaker most likely speaks " + languageHint + ".")
	}
	b.WriteString(" Keep the speaker's exact words, grammar and form of address. Never translate, correct, summarize" +
		" or add anything, and do not add quotation marks. If there is no clearly spoken human speech (silence, noise," +
		" music, tones, breathing), output exactly " + noSpeechMarker + " and nothing else. Output only the transcript.")
	return b.String()
}

// noSpeechMarker is what the model is told to answer for audio without speech. Without it, Voxtral invented a
// complete German sentence for a plain 440 Hz tone.
const noSpeechMarker = "[no speech]"

// timestampPattern matches "[00:00]"-style timestamps Voxtral sometimes puts in front of lines.
var timestampPattern = regexp.MustCompile(`\[\d{1,2}:\d{2}(?::\d{2})?\]\s*`)

// cleanTranscript trims whitespace and quotation marks the model sometimes wraps the whole answer in, and turns
// the no-speech marker into an empty transcript.
func cleanTranscript(s string) string {
	s = strings.TrimSpace(timestampPattern.ReplaceAllString(s, ""))
	if strings.EqualFold(strings.Trim(s, " .\"'"), strings.Trim(noSpeechMarker, "[]")) || strings.Contains(strings.ToLower(s), noSpeechMarker) {
		return ""
	}
	for _, q := range [][2]string{{`"`, `"`}, {"„", "“"}, {"“", "”"}, {"«", "»"}, {"»", "«"}} {
		if len(s) > len(q[0])+len(q[1]) && strings.HasPrefix(s, q[0]) && strings.HasSuffix(s, q[1]) &&
			!strings.Contains(s[len(q[0]):len(s)-len(q[1])], q[0]) {
			s = strings.TrimSpace(s[len(q[0]) : len(s)-len(q[1])])
		}
	}
	return s
}

type converseRequest struct {
	Messages        []converseMessage `json:"messages"`
	InferenceConfig inferenceConfig   `json:"inferenceConfig"`
}

type converseMessage struct {
	Role    string            `json:"role"`
	Content []converseContent `json:"content"`
}

type converseContent struct {
	Audio *audioBlock `json:"audio,omitempty"`
	Text  string      `json:"text,omitempty"`
}

type audioBlock struct {
	Format string      `json:"format"`
	Source audioSource `json:"source"`
}

type audioSource struct {
	Bytes []byte `json:"bytes"` // encoding/json writes []byte as base64, which is what the REST API expects
}

type inferenceConfig struct {
	Temperature float64 `json:"temperature"`
	MaxTokens   int     `json:"maxTokens"`
}

type converseResponse struct {
	Output struct {
		Message struct {
			Content []struct {
				Text string `json:"text"`
			} `json:"content"`
		} `json:"message"`
	} `json:"output"`
	Message string `json:"message"` // set on errors
}

func (b *bedrockTranscriber) Transcribe(ctx context.Context, audio []byte, format string) (string, error) {
	body, err := json.Marshal(converseRequest{
		Messages: []converseMessage{{
			Role: "user",
			Content: []converseContent{
				{Audio: &audioBlock{Format: format, Source: audioSource{Bytes: audio}}},
				{Text: transcriptionPrompt(b.languageHint)},
			},
		}},
		InferenceConfig: inferenceConfig{Temperature: 0, MaxTokens: 2048},
	})
	if err != nil {
		return "", err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		b.endpoint+"/model/"+url.PathEscape(b.modelID)+"/converse", bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	sum := sha256.Sum256(body)
	if err := v4.NewSigner().SignHTTP(ctx, b.creds, req, hex.EncodeToString(sum[:]), "bedrock", b.region, b.now()); err != nil {
		return "", fmt.Errorf("sign request: %w", err)
	}

	res, err := b.httpClient.Do(req)
	if err != nil {
		return "", fmt.Errorf("bedrock request: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", fmt.Errorf("read bedrock response: %w", err)
	}

	var out converseResponse
	_ = json.Unmarshal(raw, &out)
	if res.StatusCode != http.StatusOK {
		msg := out.Message
		if msg == "" {
			msg = http.StatusText(res.StatusCode)
		}
		return "", fmt.Errorf("bedrock %d: %s", res.StatusCode, msg)
	}
	var text strings.Builder
	for _, c := range out.Output.Message.Content {
		text.WriteString(c.Text)
	}
	return cleanTranscript(text.String()), nil
}
