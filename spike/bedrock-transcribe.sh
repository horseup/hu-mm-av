#!/usr/bin/env bash
# Spike: transcribe one audio file with Voxtral on Amazon Bedrock (Converse API).
# Usage: spike/bedrock-transcribe.sh <file> [model-id] [region]
# Prints the transcript, wall-clock latency and token usage. Use fictional audio only.
set -euo pipefail
FILE="$1"
MODEL="${2:-mistral.voxtral-mini-3b-2507}"
REGION="${3:-eu-west-1}"
EXT="${FILE##*.}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

python3 -I - "$FILE" "$EXT" > "$TMP/messages.json" <<'EOF'
import base64, json, sys
path, ext = sys.argv[1], sys.argv[2].lower()
with open(path, 'rb') as f:
    b64 = base64.b64encode(f.read()).decode()
print(json.dumps([{"role": "user", "content": [
    {"audio": {"format": ext, "source": {"bytes": b64}}},
    {"text": "Transkribiere diese Sprachnachricht wortgetreu in ihrer Sprache. Gib nur den transkribierten Text aus, ohne Kommentar."}
]}]))
EOF

START=$(python3 -c 'import time; print(time.time())')
aws bedrock-runtime converse --region "$REGION" --model-id "$MODEL" \
  --messages "file://$TMP/messages.json" \
  --inference-config '{"temperature":0,"maxTokens":2048}' \
  --output json > "$TMP/out.json"
END=$(python3 -c 'import time; print(time.time())')

python3 -I - "$TMP/out.json" "$START" "$END" "$MODEL" <<'EOF'
import json, sys
d = json.load(open(sys.argv[1]))
text = "".join(c.get("text", "") for c in d["output"]["message"]["content"])
u = d.get("usage", {})
print(f"model={sys.argv[4]} latency={float(sys.argv[3]) - float(sys.argv[2]):.2f}s "
      f"in={u.get('inputTokens')} out={u.get('outputTokens')} server_ms={d.get('metrics', {}).get('latencyMs')}")
print(text.strip())
EOF
