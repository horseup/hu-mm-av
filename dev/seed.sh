#!/usr/bin/env sh
# Seeds the local dev Mattermost (dev/docker-compose.yml) with an admin, a second
# user and a team. Dev-only credentials for http://localhost:8065; never reuse them.
set -eu
C="${MM_CONTAINER:-hu-mm-av-mattermost-1}"
PASS="${MM_DEV_PASSWORD:-DevOnly-Voice-2026!}"
mm() { docker exec "$C" mmctl --local "$@"; }

mm user create --email admin@example.test --username devadmin --password "$PASS" --system-admin 2>/dev/null || true
mm user create --email listener@example.test --username listener --password "$PASS" 2>/dev/null || true
mm team create --name dev --display-name "Dev" 2>/dev/null || true
mm team users add dev devadmin listener
mm config set PluginSettings.EnableUploads true
echo "Seeded. Sign in at http://localhost:8065 as devadmin or listener (password: \$MM_DEV_PASSWORD or the dev default in this file)."
