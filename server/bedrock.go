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

// Voxtral on Bedrock only takes audio inside a chat message, and in that mode it writes in whatever language
// the prompt points it to, not the language that is spoken. Told "the speaker most likely speaks German", it turned
// English speech into German; told nothing, Voxtral Small turned German into English. So Transcribe asks twice:
// first which language is spoken, then for a transcript in exactly that language. With Small this kept the spoken
// language in 24 of 27 test clips; one call doing both answered "no speech" for every English clip.
const detectPrompt = "Which language is spoken in this audio? Answer with the English name of the language only, one word." +
	" If there is no clearly spoken human speech (silence, noise, music, tones, breathing), answer None."

// transcriptionPrompt asks for a verbatim transcript in the given language, or in the spoken language when it is
// empty. Without "never translate", Voxtral translated short German clips into English. Passing the previous
// chunk's text as context made it continue that text instead of transcribing the new audio, so chunks are
// transcribed on their own.
func transcriptionPrompt(language string) string {
	var b strings.Builder
	if language != "" {
		b.WriteString("Transcribe this voice message verbatim. The speaker speaks " + language + "; write the transcript in " + language + ".")
	} else {
		b.WriteString("Transcribe this voice message verbatim, in the language that is spoken.")
	}
	b.WriteString(" Keep the speaker's exact words, grammar and form of address. Never translate, correct, summarize" +
		" or add anything, and do not add quotation marks. If there is no clearly spoken human speech (silence, noise," +
		" music, tones, breathing), output exactly " + noSpeechMarker + " and nothing else. Output only the transcript.")
	return b.String()
}

// knownLanguages maps the lower-case English names the model may answer with to the name used in the prompt. Only
// names from this list ever reach the second prompt, never the model's raw answer.
var knownLanguages = func() map[string]string {
	m := map[string]string{}
	for _, l := range []string{"English", "German", "French", "Spanish", "Portuguese", "Italian", "Dutch", "Hindi",
		"Polish", "Czech", "Slovak", "Hungarian", "Romanian", "Bulgarian", "Greek", "Turkish", "Russian", "Ukrainian",
		"Swedish", "Danish", "Norwegian", "Finnish", "Icelandic", "Croatian", "Serbian", "Slovenian", "Lithuanian",
		"Latvian", "Estonian", "Arabic", "Hebrew", "Persian", "Chinese", "Japanese", "Korean", "Vietnamese", "Thai",
		"Indonesian", "Malay"} {
		m[strings.ToLower(l)] = l
	}
	return m
}()

var wordPattern = regexp.MustCompile(`[A-Za-z]+`)

// parseLanguage reads the answer to detectPrompt. The model answers "German", but sometimes a sentence ("The
// language spoken in this audio is English"), so it takes the last known language name in the answer. speech is
// false when the model says there is none; language is empty when the answer names no known language.
func parseLanguage(answer string) (language string, speech bool) {
	if strings.Contains(strings.ToLower(answer), "no speech") {
		return "", false
	}
	for _, w := range wordPattern.FindAllString(answer, -1) {
		lw := strings.ToLower(w)
		if lw == "none" {
			return "", false
		}
		if l, ok := knownLanguages[lw]; ok {
			language = l
		}
	}
	return language, true
}

// noSpeechMarker is what the model is told to answer for audio without speech. Without it, Voxtral invented a
// complete German sentence for a plain 440 Hz tone.
const noSpeechMarker = "[no speech]"

// timestampPattern matches "[00:00]"-style timestamps Voxtral sometimes puts in front of lines.
var timestampPattern = regexp.MustCompile(`\[\d{1,2}:\d{2}(?::\d{2})?\]\s*`)

// markerPattern matches an answer that is only a short bracketed note, such as the no-speech marker in another
// language ("[keine Rede]", which Mini answered for a German-accented English clip) or "[Musik]".
var markerPattern = regexp.MustCompile(`^\[[^\]]{1,40}\]\.?$`)

// notTranscripts are answers that are the model talking, not the speaker: the prompt read back, or a chat
// refusal. Both came back for noise in testing.
var notTranscripts = []*regexp.Regexp{
	regexp.MustCompile(`(?i)write the transcript in|transcribe this voice message|never translate, correct`),
	regexp.MustCompile(`(?i)^(i'm|i am) sorry, (but )?i (can't|cannot) (help|assist) with (that|this)\.?$`),
}

// cleanTranscript trims whitespace and quotation marks the model sometimes wraps the whole answer in, and turns
// the no-speech marker, other bracketed notes and answers that are not a transcript into an empty transcript.
func cleanTranscript(s string) string {
	s = strings.TrimSpace(timestampPattern.ReplaceAllString(s, ""))
	if strings.EqualFold(strings.Trim(s, " .\"'"), strings.Trim(noSpeechMarker, "[]")) || strings.Contains(strings.ToLower(s), noSpeechMarker) ||
		markerPattern.MatchString(s) {
		return ""
	}
	for _, re := range notTranscripts {
		if re.MatchString(strings.Trim(s, `"“”„«» `)) {
			return ""
		}
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

// Transcribe names the spoken language first, then asks for a transcript in it (see detectPrompt). When the answer
// names no known language, it falls back to the configured language; with none configured, the prompt asks for
// the spoken language as before.
func (b *bedrockTranscriber) Transcribe(ctx context.Context, audio []byte, format string) (string, error) {
	answer, err := b.converse(ctx, audio, format, detectPrompt, 20)
	if err != nil {
		return "", err
	}
	language, speech := parseLanguage(answer)
	if !speech {
		return "", nil
	}
	if language == "" {
		language = b.languageHint
	}
	text, err := b.converse(ctx, audio, format, transcriptionPrompt(language), 2048)
	if err != nil {
		return "", err
	}
	return cleanTranscript(text), nil
}

// converse sends one audio block with one instruction and returns the model's text.
func (b *bedrockTranscriber) converse(ctx context.Context, audio []byte, format, prompt string, maxTokens int) (string, error) {
	body, err := json.Marshal(converseRequest{
		Messages: []converseMessage{{
			Role: "user",
			Content: []converseContent{
				{Audio: &audioBlock{Format: format, Source: audioSource{Bytes: audio}}},
				{Text: prompt},
			},
		}},
		InferenceConfig: inferenceConfig{Temperature: 0, MaxTokens: maxTokens},
	})
	if err != nil {
		return "", err
	}

	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		if attempt > 0 {
			select {
			case <-ctx.Done():
				return "", lastErr
			case <-time.After(retryDelay):
			}
		}
		text, retry, err := b.send(ctx, body)
		if err == nil {
			return text, nil
		}
		lastErr = err
		if !retry {
			break
		}
	}
	return "", lastErr
}

// retryDelay is the pause before the one retry after a throttled, failed or unreachable request.
var retryDelay = 400 * time.Millisecond

// send makes one signed Converse request. retry is true for errors worth one more try: no response, 429 and 5xx.
func (b *bedrockTranscriber) send(ctx context.Context, body []byte) (text string, retry bool, err error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost,
		b.endpoint+"/model/"+url.PathEscape(b.modelID)+"/converse", bytes.NewReader(body))
	if err != nil {
		return "", false, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	sum := sha256.Sum256(body)
	if err := v4.NewSigner().SignHTTP(ctx, b.creds, req, hex.EncodeToString(sum[:]), "bedrock", b.region, b.now()); err != nil {
		return "", false, fmt.Errorf("sign request: %w", err)
	}

	res, err := b.httpClient.Do(req)
	if err != nil {
		return "", ctx.Err() == nil, fmt.Errorf("bedrock request: %w", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return "", true, fmt.Errorf("read bedrock response: %w", err)
	}

	var out converseResponse
	_ = json.Unmarshal(raw, &out)
	if res.StatusCode != http.StatusOK {
		msg := out.Message
		if msg == "" {
			msg = http.StatusText(res.StatusCode)
		}
		return "", res.StatusCode == http.StatusTooManyRequests || res.StatusCode >= 500, fmt.Errorf("bedrock %d: %s", res.StatusCode, msg)
	}
	var sb strings.Builder
	for _, c := range out.Output.Message.Content {
		sb.WriteString(c.Text)
	}
	return sb.String(), false, nil
}
