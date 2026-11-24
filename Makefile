# Builds run in Docker, so the host needs no Go toolchain.
GO_IMAGE ?= golang:1.27.4-alpine
PLUGIN_ID := $(shell python3 -c 'import json;print(json.load(open("plugin.json"))["id"])')
VERSION := $(shell python3 -c 'import json;print(json.load(open("plugin.json"))["version"])')
BUNDLE := dist/$(PLUGIN_ID)-$(VERSION).tar.gz
MM_CONTAINER ?= hu-mm-av-mattermost-1
GO_RUN := docker run --rm -v hu-mm-av-gomod:/go/pkg/mod -v hu-mm-av-gocache:/root/.cache/go-build -v hu-mm-av-gobin:/go/bin
GO := $(GO_RUN) -v "$(CURDIR)/server:/src" -w /src $(GO_IMAGE)
GO_LICENSES := github.com/google/go-licenses/v2@v2.0.1

.PHONY: tidy test server notices bundle deploy-local clean

tidy:
	$(GO) go mod tidy

test:
	$(GO) go test ./...

# Stripped, static binaries for the two Linux targets Mattermost servers run on.
server:
	$(GO) sh -c 'for arch in amd64 arm64; do CGO_ENABLED=0 GOOS=linux GOARCH=$$arch go build -trimpath -ldflags "-s -w" -o dist/plugin-linux-$$arch . || exit 1; done'

# Regenerates THIRD_PARTY_NOTICES.md from the modules that end up in the binary.
notices:
	$(GO) sh -c 'go install $(GO_LICENSES) >/dev/null 2>&1; GOOS=linux GOARCH=amd64 go-licenses report . 2>/dev/null' | python3 scripts/notices.py > THIRD_PARTY_NOTICES.md

bundle: server
	rm -rf dist/pkg && mkdir -p dist/pkg/$(PLUGIN_ID)/server/dist dist/pkg/$(PLUGIN_ID)/webapp
	cp plugin.json LICENSE NOTICE THIRD_PARTY_NOTICES.md dist/pkg/$(PLUGIN_ID)/
	# License and NOTICE files of every Go dependency in the binary.
	$(GO_RUN) -v "$(CURDIR):/repo" -w /repo/server $(GO_IMAGE) sh -c 'go install $(GO_LICENSES) >/dev/null 2>&1; GOOS=linux GOARCH=amd64 go-licenses save . --save_path=/repo/dist/pkg/$(PLUGIN_ID)/third_party --ignore github.com/horseup/hu-mm-av 2>/dev/null; chown -R $(shell id -u):$(shell id -g) /repo/dist/pkg'
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
