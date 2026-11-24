# Builds run in Docker, so the host needs no Go toolchain.
GO_IMAGE ?= golang:1.27.4-alpine
PLUGIN_ID := $(shell python3 -c 'import json;print(json.load(open("plugin.json"))["id"])')
VERSION := $(shell python3 -c 'import json;print(json.load(open("plugin.json"))["version"])')
BUNDLE := dist/$(PLUGIN_ID)-$(VERSION).tar.gz
MM_CONTAINER ?= hu-mm-av-mattermost-1
GO := docker run --rm -v "$(CURDIR)/server:/src" -v hu-mm-av-gomod:/go/pkg/mod -v hu-mm-av-gocache:/root/.cache/go-build -w /src $(GO_IMAGE)

.PHONY: tidy test server bundle deploy-local clean

tidy:
	$(GO) go mod tidy

test:
	$(GO) go test ./...

# Stripped, static binaries for the two Linux targets Mattermost servers run on.
server:
	$(GO) sh -c 'for arch in amd64 arm64; do CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath -ldflags "-s -w" -o dist/plugin-linux-$$arch . || exit 1; done'

bundle: server
	rm -rf dist/pkg && mkdir -p dist/pkg/$(PLUGIN_ID)/server/dist dist/pkg/$(PLUGIN_ID)/webapp
	cp plugin.json dist/pkg/$(PLUGIN_ID)/
	cp -R assets public dist/pkg/$(PLUGIN_ID)/
	cp server/dist/plugin-linux-* dist/pkg/$(PLUGIN_ID)/server/dist/
	cp webapp/main.js dist/pkg/$(PLUGIN_ID)/webapp/
	COPYFILE_DISABLE=1 tar --no-xattrs -C dist/pkg -czf $(BUNDLE) $(PLUGIN_ID)
	@ls -l $(BUNDLE) | awk '{print "bundle: " $$9 " (" $$5 " bytes)"}'

# Installs the bundle on the local dev server from dev/docker-compose.yml.
deploy-local: bundle
	docker cp $(BUNDLE) $(MM_CONTAINER):/tmp/plugin.tar.gz
	docker exec $(MM_CONTAINER) mmctl --local plugin add /tmp/plugin.tar.gz --force
	docker exec $(MM_CONTAINER) mmctl --local plugin enable $(PLUGIN_ID)

clean:
	rm -rf dist server/dist
