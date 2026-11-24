package main

import (
	"net/http"
	"sync"

	"github.com/mattermost/mattermost/server/public/plugin"
)

type Plugin struct {
	plugin.MattermostPlugin

	configLock    sync.RWMutex
	configuration *configuration

	router  http.Handler
	limiter *rateLimiter

	// newTranscriber builds the speech-to-text client from the current configuration. Tests replace it.
	newTranscriber func(cfg *configuration) (transcriber, error)
}

func (p *Plugin) OnActivate() error {
	p.limiter = newRateLimiter(chunkRequestsPerMinute)
	if p.newTranscriber == nil {
		p.newTranscriber = func(cfg *configuration) (transcriber, error) { return newBedrockTranscriber(cfg) }
	}
	p.router = p.routes()
	return nil
}

func (p *Plugin) OnConfigurationChange() error {
	cfg := new(configuration)
	if err := p.API.LoadPluginConfiguration(cfg); err != nil {
		return err
	}
	p.configLock.Lock()
	p.configuration = cfg
	p.configLock.Unlock()
	return nil
}

func (p *Plugin) getConfiguration() *configuration {
	p.configLock.RLock()
	defer p.configLock.RUnlock()
	if p.configuration == nil {
		return &configuration{}
	}
	return p.configuration
}

func (p *Plugin) ServeHTTP(_ *plugin.Context, w http.ResponseWriter, r *http.Request) {
	p.router.ServeHTTP(w, r)
}

func (p *Plugin) logError(msg string, err error) {
	p.API.LogError(msg, "error", err.Error())
}
