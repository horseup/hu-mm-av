# hu-mm-av

Telegram-style voice messages for [Mattermost](https://mattermost.com): hold the mic to record, release to send, and get an automatic transcript. Round video messages are planned.

**Status: spike, not usable yet.** See [docs/SCOPE.md](docs/SCOPE.md) for the plan.

## What it will do

- Desktop app and web: press and hold the mic in the composer to record, then release to send. Slide away to cancel, or drag up to lock for hands-free recording. In locked mode you can listen back before sending, and a keyboard shortcut also records.
- Voice messages are recorded as AAC (`.m4a`) by the browser's own encoder, so the plugin ships no encoder and the files play everywhere, including the Mattermost mobile apps.
- Transcripts are written into the message text, so mobile users see them too. The speech-to-text provider is configurable: AWS (Amazon Transcribe, Bedrock) or an OpenAI-compatible endpoint.
- Mobile apps can play messages but not record them: Mattermost mobile does not run plugin UI.

## Development

```bash
docker compose -f dev/docker-compose.yml -p hu-mm-av up -d   # Mattermost on http://localhost:8065
```

## License

[MIT](LICENSE)
