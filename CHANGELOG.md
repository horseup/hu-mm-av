# Changelog

## Unreleased

## v0.2.0 (2026-11-25)

- The UI is in English, and in German for users whose Mattermost language is Deutsch. It used to be German only. Other languages can be added; see CONTRIBUTING.md.
- The "Fallback language" setting now defaults to English. It is used only when the model can't name the spoken language. If you relied on the old default German, set it in the plugin settings before updating.
- A transcript is no longer dropped when the speaker says a phrase from the transcription prompt, such as "transcribe this voice message". Answers in which the model reads the prompt back are still removed.
- The repository is now `horseup/mattermost-plugin-voice-messages`. Old links redirect.
- New: release workflow, changelog, and issue and pull request templates. The README now covers installing from a release.

## v0.1.4 (2026-11-25)

- Transcripts are written in the language spoken. Before, an English voice message could come out in German. The model now first names the language, then transcribes in it, so every chunk takes two requests.
- The default model is now Voxtral Small (`mistral.voxtral-small-24b-2507`). Allow it in the IAM policy before updating, or transcripts fail with 403.
- "Most likely language" is renamed "Fallback language".
- One retry when Bedrock throttles or fails. Answers that are not a transcript (bracketed notes, the prompt read back, chat refusals) are dropped.

## v0.1.3 (2026-11-24)

- Recordings are rewritten as a regular `.m4a` before upload, so players that read the length from the file header show it correctly. This fixes the progress bar in the Android app. The audio bytes are unchanged.

## v0.1.2 (2026-11-24)

- Hold ⌥⇧V (Alt+Shift+V) to record and let go to send; Esc cancels. A short tap starts a hands-free recording.

## v0.1.1 (2026-11-24)

- No more made-up transcripts for audio without speech. Noise, music and tones give an empty transcript, the browser no longer sends steady tones, and `[00:00]` timestamps are removed.

## v0.1.0 (2026-11-24)

- First public pre-release: hold-to-record voice messages, live transcripts with Voxtral on Amazon Bedrock, waveform player with speed control, AAC recording that plays in the mobile apps.
