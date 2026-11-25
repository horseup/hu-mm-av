# Contributing

Thanks for helping. Bug reports, translations and pull requests are welcome. Open pull requests against the `development` branch, which is the default.

## Set up

You need Docker. Go and Node.js run inside containers, so you don't have to install them.

```bash
docker compose -f dev/docker-compose.yml up -d   # Mattermost 11.7 on http://localhost:8065
./dev/seed.sh                                    # dev users and a team (credentials are in the script)
make deploy-local                                # build, bundle and install the plugin on it
```

Sign in at http://localhost:8065 as `devadmin`. Browsers allow the microphone on `localhost` without HTTPS.

Transcripts need AWS credentials; everything else works without them. To test with transcripts, use your own AWS account with Bedrock access to Voxtral in `eu-west-1` (see the README), and put temporary credentials in `dev/.env.aws`, which git ignores:

```bash
aws configure export-credentials --format env-no-export > dev/.env.aws
docker compose -f dev/docker-compose.yml up -d   # restarts Mattermost with the credentials
```

Temporary credentials expire, often after an hour or less. When Bedrock answers "security token … expired", export them again.

## Test

```bash
make test     # Go tests and the webapp's MP4 tests
make bundle   # builds dist/de.horseup.mm-av-<version>.tar.gz
```

CI runs both on every pull request. For UI changes, also check them by hand on the local server: recording by mouse and by keyboard, the locked mode, the player, and the transcript.

## Layout

- `server/`: Go plugin. HTTP endpoints for chunks and posts (`api.go`), the Bedrock client with SigV4 signing and the transcript filters (`bedrock.go`).
- `webapp/main.js`: the whole webapp in plain JavaScript, with no build step. React, ReactDOM and react-intl come from Mattermost. `webapp/mp4.test.mjs` tests the MP4 rewrite.
- `public/pcm-tap.js`: the AudioWorklet that taps 16 kHz PCM for live transcripts.
- `spike/`: scripts from the speech-to-text evaluation, including `language-eval.py`.

## Guidelines

- Keep the webapp free of dependencies.
- Use only documented Mattermost plugin APIs. Voice plugins that relied on webapp internals broke on upgrades.
- Use synthetic or your own voice in tests and examples, never recordings of other people, and no personal data in issues or logs.
- Changes to the transcription prompt need a before and after run of `spike/language-eval.py` on clips in at least English and German. Write the numbers in the pull request.
- Add a line under "Unreleased" in [CHANGELOG.md](CHANGELOG.md) for anything users will notice.

## Translations

The plugin's UI text is in the `TEXT` and `TRANSLATIONS` blocks at the top of `webapp/main.js`. To add a language, copy the `de` block, name it after the Mattermost language code (for example `fr`), and translate every value. Keep the keys. Mattermost then shows it to users who chose that language.

## Releases (maintainers)

1. Move the "Unreleased" notes in `CHANGELOG.md` to a new `## vX.Y.Z (date)` section.
2. Set the same version in `plugin.json`, and update the version in the README's `mmctl` example.
3. Merge to `development`, then tag that commit `vX.Y.Z` and push the tag. The release workflow builds the bundle, checks that the tag matches `plugin.json`, and publishes the GitHub release with its checksum and the changelog section. A tag with a suffix, such as `v0.3.0-rc.1`, becomes a pre-release.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
