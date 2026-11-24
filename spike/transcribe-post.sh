#!/usr/bin/env bash
# Spike: do what the v1 server will do for one voice post on the local dev server.
# Downloads the post's m4a, converts it to 16 kHz mono WAV in ~30 s chunks, transcribes the chunks
# in parallel with Voxtral on Bedrock, then writes the transcript into props.hu_voice and the message.
# Usage: MM_TOKEN=<dev token> spike/transcribe-post.sh <post_id> [model-id] [region]
set -euo pipefail
POST="$1"
MODEL="${2:-mistral.voxtral-mini-3b-2507}"
REGION="${3:-eu-west-1}"
MM="${MM_URL:-http://localhost:8065}"
: "${MM_TOKEN:?set MM_TOKEN to a token for the local dev server}"
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
auth=(-H "Authorization: Bearer $MM_TOKEN")

curl -sf "${auth[@]}" "$MM/api/v4/posts/$POST" > "$TMP/post.json"
FILE_ID=$(python3 -I - "$TMP/post.json" "$MM" "$MM_TOKEN" <<'EOF'
import json, sys, urllib.request
post = json.load(open(sys.argv[1]))
for fid in post.get("file_ids") or []:
    req = urllib.request.Request(f"{sys.argv[2]}/api/v4/files/{fid}/info", headers={"Authorization": f"Bearer {sys.argv[3]}"})
    info = json.load(urllib.request.urlopen(req))
    if info.get("mime_type", "").startswith("audio/") and not info["name"].endswith(".stt.wav"):
        print(fid); break
EOF
)
[ -n "$FILE_ID" ] || { echo "no audio file on post $POST" >&2; exit 1; }

curl -sf "${auth[@]}" -o "$TMP/in.m4a" "$MM/api/v4/files/$FILE_ID"
ffmpeg -loglevel error -i "$TMP/in.m4a" -ac 1 -ar 16000 -f segment -segment_time 30 "$TMP/chunk-%03d.wav"

START=$(python3 -c 'import time; print(time.time())')
for c in "$TMP"/chunk-*.wav; do
  ( "$HERE/bedrock-transcribe.sh" "$c" "$MODEL" "$REGION" | tail -n +2 > "$c.txt" ) &
done
wait
END=$(python3 -c 'import time; print(time.time())')

python3 -I - "$TMP" "$TMP/post.json" "$START" "$END" > "$TMP/patch.json" <<'EOF'
import glob, json, sys
tmp, post = sys.argv[1], json.load(open(sys.argv[2]))
parts = [open(p).read().strip() for p in sorted(glob.glob(f"{tmp}/chunk-*.wav.txt"))]
text = " ".join(p for p in parts if p)
hv = dict((post.get("props") or {}).get("hu_voice") or {})
hv.update({"transcript": text, "transcript_status": "done" if text else "failed"})
props = dict(post.get("props") or {}); props["hu_voice"] = hv
secs = round(hv.get("duration_ms", 0) / 1000)
message = f"🎤 {secs // 60}:{secs % 60:02d} · {text}" if text else post["message"]
print(json.dumps({"message": message, "props": props}))
print(f"chunks={len(parts)} stt_wall={float(sys.argv[4]) - float(sys.argv[3]):.2f}s chars={len(text)}", file=sys.stderr)
EOF
curl -sf "${auth[@]}" -X PUT -H 'Content-Type: application/json' --data-binary "@$TMP/patch.json" "$MM/api/v4/posts/$POST/patch" > /dev/null
echo "updated $POST"
