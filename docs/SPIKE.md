# Spike results (2026-11-24)

Tested on a local Mattermost 11.7.11 Team Edition (`dev/docker-compose.yml`), with the stub plugin in `spike/stub-plugin` (one 4.6 KB tarball, no build step) and `spike/bedrock-transcribe.sh`. All audio was fictional German speech from macOS TTS.

## Verdict

v1 is feasible as scoped, with three design changes:

1. Speech-to-text is **Voxtral Mini 3B on Amazon Bedrock in eu-west-1 (Ireland)**, through the Converse API.
2. Transcription audio is **16 kHz mono WAV built from raw PCM captured while recording**, not decoded from the AAC.
3. Long messages are split into **chunks of about 30 s, transcribed in parallel**.

## Results

| Check | Result |
| --- | --- |
| Composer slot | `registerPostEditorActionComponent` renders inside the formatting bar. If a user collapses the bar ("Aa" toggle), the mic disappears. |
| Gestures (synthetic pointer events in Chromium) | Tap under 500 ms shows a "hold to record" hint. Hold and release sends. Slide left discards. Drag up locks; then listen back and send. All work. |
| Recording format | Mattermost Desktop 6.4.0 runs Electron 45.2.1 / Chromium 156, which records `audio/mp4;codecs=mp4a.40.2` natively. Output is fragmented MP4 (AAC, 64 kbps), and ffprobe reads its duration: 17 s = 126 KB. |
| Send path | Decode, build the WAV, upload two files and create the `custom_hu_voice` post: 97 ms. |
| iOS playback | iOS 27.2 Simulator Safari (AVFoundation) loads the browser-recorded fMP4, shows the right duration (16.34 s) and plays it. The Mattermost mobile app itself was not tested. |
| Custom post renderer | It renders, but `post.metadata.files` is missing in its props (read file IDs from the store), and core still draws the file tiles below it, so v1 must hide them for this post type. |
| Edited marker | Server source (`app/post.go`): changing `message` sets `EditAt`, so the post shows "Edited". Changing only `props` does not. |

## Speech-to-text

| Test | Result |
| --- | --- |
| Amazon Transcribe | Ruled out. By default it stores voice inputs for service improvement, possibly outside the region, unless an AWS Organizations AI opt-out policy is attached, and this account cannot attach one. |
| Voxtral in eu-central-1 (Frankfurt) | Unusable today. It is not in the Converse model list ("invalid model identifier"). The OpenAI-compatible `bedrock-mantle` endpoint lists it, but WAV requests hung for 60 s and for 120 s. |
| Voxtral formats (Converse) | Only `mp3` and `wav`. `m4a` and `aac` are rejected. |
| Request size | A 60 s WAV (1.9 MB) works; 90 s (2.9 MB) fails with "length limit exceeded". |
| Voxtral Mini, 16 s clip | 1.2 s round trip, essentially verbatim ("3,5 kg", "14:30 Uhr") |
| Voxtral Small, same clip | 2.2 s, and it paraphrased ("kurze Info" for "kurzes Update", "der Hufschmied" for "die Hufschmiedin"). Not better here. |
| Voxtral Mini, 54 s clip | 2.8 s. Errors: "lammet" (lahmt), "Pferden" (Verden), "Ecke" (App). Numbers and times were right. |
| Voxtral Mini, WAV decoded from the Chromium AAC | Worse ("kurzes App", "Hofschmiedin"). This is why v1 captures raw PCM for STT. |
| Repeated audio | A clip that repeats the same sentence seven times came back as one sentence. The model drops repeats, which is one more reason for chunks. |

Tokens: about 375 input tokens per 30 s audio window (about 750 per minute), plus about 35 for the prompt. Output is about 4.4 tokens per second of speech.

## Cost (eu-west-1 list prices, AWS Price List API)

Voxtral Mini 3B standard: $0.00005 per 1K input tokens and $0.00005 per 1K output tokens. For 200 messages of 2 minutes (400 minutes) a month:

- input ≈ 307K tokens, about $0.015
- output ≈ 106K tokens, about $0.005
- total **about $0.02 a month**

## Still open

- Real human speech, recorded with a microphone in Mattermost Desktop. TTS is cleaner than real voices.
- Playback in the Mattermost mobile apps on a real phone. The test server is local only.
- The composer slot hides with the formatting bar. Options: accept it and rely on the keyboard shortcut, or mount next to the send button through the DOM (undocumented, so it may break on upgrades).
- Edited marker: show the "Edited" label once the transcript lands, or create the post only after transcription (about 1–3 s of delay).
- Firefox records WebM only. Not tested.
