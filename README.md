# hu-mm-av

Telegram-style voice messages for [Mattermost](https://mattermost.com). Hold the mic to record, release to send, and watch the transcript appear while you talk. Round video messages are planned.

**Status: v0.1, in testing.** Tested on Mattermost 11.7 Team Edition. See [docs/SCOPE.md](docs/SCOPE.md) and [docs/SPIKE.md](docs/SPIKE.md).

## Features

- **Recording (desktop app and web).** Press and hold the mic in the composer, then release to send. Slide left to cancel. Drag up to lock for hands-free recording; then ✕ cancels, stop lets you listen back, and send sends. Shortcuts while locked: Esc cancels, ⌘S / Ctrl+S stops and plays back, Enter sends.
- **Keyboard.** Hold **⌥⇧V** (Alt+Shift+V) to record and let go to send; Esc while holding cancels. A short tap starts a hands-free recording; tap again or press Enter to send. The composer with focus gets the recording (a thread or the channel); with none focused, the channel composer does. Switching to another window while holding locks the recording instead of sending it.
- **Live transcript.** While you talk, audio goes to the server in chunks cut at pauses, and the text appears above the waveform about a second behind you. When you send, the transcript is already in the message. That's why mobile users see it, and why the post never shows "Edited".
- **Player.** A waveform you can click to seek, 1×/1.5×/2× speed, one message playing at a time, and the transcript under a chevron.
- **Small files.** The browser's own encoder records AAC (`.m4a`), so the plugin ships no encoder, and the files play everywhere, including the Mattermost mobile apps.
- **Mobile.** The mobile apps play voice messages and show the transcript as the message text. They cannot record: Mattermost mobile does not run plugin UI.

## Install

1. Build the bundle with `make bundle` (needs only Docker; there are no releases yet), then upload `dist/de.horseup.mm-av-<version>.tar.gz` under **System Console → Plugins → Plugin Management**.
2. Enable the plugin and open its settings:
   - **AWS region / Model ID:** the defaults (`eu-west-1`, `mistral.voxtral-mini-3b-2507`) are what was tested. Voxtral did not respond in eu-central-1.
   - **AWS access key ID / secret:** or leave both empty, and the server uses `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and `AWS_SESSION_TOKEN` from its environment.
   - **Most likely language:** helps with short clips. Other languages are still transcribed as spoken, never translated.
3. Give the key only this permission:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": "bedrock:InvokeModel",
    "Resource": "arn:aws:bedrock:eu-west-1::foundation-model/mistral.voxtral-mini-3b-2507"
  }]
}
```

4. Recommended: set Bedrock data retention to `none` (zero data retention) for the account or project; see the [AWS docs](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html).

### What leaves your server

Only the speech-to-text request: 16 kHz WAV chunks of 3–15 s, sent to Amazon Bedrock in the region you configure. The voice file itself stays in Mattermost's file storage. Chunks without speech are never sent.

### Cost

Voxtral Mini is billed per token at $0.00005 per 1K in eu-west-1. Audio counts as about 375 tokens per 30 s window, and short chunks seem to be billed a full window. 400 minutes a month come to roughly $0.10–0.20.

## Development

```bash
docker compose -f dev/docker-compose.yml -p hu-mm-av up -d   # Mattermost 11.7 on http://localhost:8065
./dev/seed.sh                                                # dev users and a team
aws configure export-credentials --format env-no-export > dev/.env.aws   # optional: credentials for transcription (gitignored)
make test           # Go tests, in Docker
make deploy-local   # build, bundle and install on the local server
```

Layout: `server/` (Go: HTTP endpoints, Bedrock client with SigV4 signing), `webapp/main.js` (plain JS, no build step), `public/pcm-tap.js` (AudioWorklet), `spike/` (scripts from the feasibility spike).

## License

[MIT](LICENSE). The server binary includes third-party Go modules under their own licenses. See [NOTICE](NOTICE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); every release bundle also ships their license and NOTICE files in `third_party/`.

Security reports: see [SECURITY.md](SECURITY.md). Contributions: see [CONTRIBUTING.md](CONTRIBUTING.md).

Mattermost is a trademark of Mattermost, Inc. This project is not affiliated with or endorsed by Mattermost, Amazon or Mistral AI.
