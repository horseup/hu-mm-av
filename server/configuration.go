package main

import (
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
)

const (
	defaultRegion      = "eu-west-1"
	defaultModelID     = "mistral.voxtral-mini-3b-2507"
	defaultMaxDuration = 300
)

// configuration mirrors settings_schema in plugin.json. Keys match case-insensitively.
type configuration struct {
	EnableTranscription bool
	AWSRegion           string
	BedrockModelID      string
	AWSAccessKeyID      string
	AWSSecretAccessKey  string
	LanguageHint        string
	MaxDurationSeconds  int
}

func (c *configuration) region() string {
	if r := strings.TrimSpace(c.AWSRegion); r != "" {
		return r
	}
	return defaultRegion
}

func (c *configuration) modelID() string {
	if m := strings.TrimSpace(c.BedrockModelID); m != "" {
		return m
	}
	return defaultModelID
}

func (c *configuration) maxDurationSeconds() int {
	if c.MaxDurationSeconds > 0 {
		return c.MaxDurationSeconds
	}
	return defaultMaxDuration
}

// credentials prefers the System Console keys and falls back to the server's AWS_* environment variables.
func (c *configuration) credentials() (aws.Credentials, bool) {
	if id, secret := strings.TrimSpace(c.AWSAccessKeyID), strings.TrimSpace(c.AWSSecretAccessKey); id != "" && secret != "" {
		return aws.Credentials{AccessKeyID: id, SecretAccessKey: secret, Source: "plugin settings"}, true
	}
	id, secret := os.Getenv("AWS_ACCESS_KEY_ID"), os.Getenv("AWS_SECRET_ACCESS_KEY")
	if id == "" || secret == "" {
		return aws.Credentials{}, false
	}
	return aws.Credentials{AccessKeyID: id, SecretAccessKey: secret, SessionToken: os.Getenv("AWS_SESSION_TOKEN"), Source: "environment"}, true
}

// transcriptionReady reports whether transcription is switched on and has credentials to work with.
func (c *configuration) transcriptionReady() bool {
	_, ok := c.credentials()
	return c.EnableTranscription && ok
}
