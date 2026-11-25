# Spike results (2026-11-24)

This records the spike as run. The v0.1 implementation differs in places: live 3–15 s chunks instead of ~30 s, and posts created by the server. See [SCOPE.md](SCOPE.md) → Architecture.

Tested on a local Mattermost 11.7.11 Team Edition (`dev/docker-compose.yml`), with the stub plugin in `spike/stub-plugin` (one 4.6 KB tarball, no build step) and `spike/bedrock-transcribe.sh`. All audio was fictional German speech from macOS TTS.

## Verdict

v1 looks feasible as scoped. Three checks are still pending: a real microphone in Mattermost Desktop, real voices, and the real mobile apps (see "Still open"). Design changes:

1. Speech-to-text is **Voxtral Mini 3B on Amazon Bedrock in eu-west-1 (Ireland)**, through the Converse API. Mini was preferred over Small on one clip only.
2. Transcription audio is **16 kHz mono WAV** (Voxtral accepts only wav or mp3). Capturing raw PCM while recording is the plan, but its accuracy benefit is not proven: errors showed up on direct WAVs too.
3. Long messages are split into **chunks of about 30 s, transcribed in parallel**. That keeps requests under the size limit and holds latency at 1–3 s. It does not prevent dropped repeats.

Recording ran in the Claude desktop app's built-in Chromium 156 browser on macOS, with a TTS file fed in as the source. Mattermost Desktop uses the same Chromium major version, but the microphone path itself never ran.

## Results

| Check | Result |
| --- | --- |
| Composer slot | `registerPostEditorActionComponent` renders inside the formatting bar. If a user collapses the bar ("Aa" toggle), the mic disappears. |
| Gestures (Chromium) | With synthetic pointer events: a tap under 500 ms shows a "hold to record" hint, hold and release sends, slide left discards, and drag up locks, then you can listen back and send. Real mouse drags confirmed slide-to-cancel and drag-to-lock once the pointer leaves the button. |
| Recording format | Mattermost Desktop 6.4.0 runs Electron 45.2.1 / Chromium 156, which records `audio/mp4;codecs=mp4a.40.2` natively. Output is fragmented MP4 (AAC, 64 kbps), and ffprobe reads its duration: 17 s = 126 KB. |
| Send path | Decode, build the WAV, upload two files and create the `custom_hu_voice` post: 97 ms. |
| iOS playback | iOS 27.2 Simulator Safari (AVFoundation) loads the browser-recorded fMP4, shows the right duration (16.34 s) and plays it. The Mattermost mobile app itself was not tested. |
| Custom post renderer | `post.metadata.files` is missing in the renderer's props; file infos come from the store (`entities.files.files`). Core still draws the file tiles, so the stub hides them with `.post__body:has([data-humm=voice-post]) > .post-image__columns`. The stub player (play/pause, seek, 1×/1.5×/2×, one message at a time) plays the fMP4 in Chromium: the server sends `audio/mp4` with range support. |
| Edited marker | Server source (`app/post.go`): changing `message` sets `EditAt`; changing only `props` does not. On desktop the custom renderer shows no "Edited" label (only a `post--edited` class), so it would only show on mobile. |
| Transcript row | Under the player: a chevron "Transkript" toggle, collapsed by default, which remembers its state while the list re-renders. It also has "wird erstellt …" (pending) and "nicht verfügbar" (failed) states. `spike/transcribe-post.sh` fills `props.hu_voice.transcript` the way the v1 server will: 0.7–1.4 s per post. |
| Recorder UI | An overlay covers the composer while recording. Holding shows timer, "‹ Nach links: abbrechen" and live level bars, kept left of the red mic circle, with a lock hint above it. Slid left shows red "Loslassen zum Verwerfen" and a trash circle. Locked shows ✕, timer, level bars, stop-to-listen and send. Preview shows ✕, play, progress and send. Esc cancels and Enter sends; the animations respect reduced motion. |

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
| Voxtral Mini, WAV decoded from the Chromium AAC | "kurzes App" and "Hofschmiedin". A later run on the direct WAV also got "Appointement" and "Hofschmiedin", so output varies between runs at temperature 0. AAC is not shown to be the cause. |
| Translation | With "transcribe in its language", Voxtral translated a 3 s German clip into English. Fixed with an explicit prompt (verbatim, never translate) plus an optional language hint: German in 4/4 runs, and an English clip stays English. |
| Repeated audio | A clip that repeats the same sentence came back as one sentence, both at 115 s and inside a 30 s chunk. The model silently drops repeats, and chunking does not prevent it. |
| Bedrock data handling | Content is not shared with model providers. Retention mode `none` (zero data retention) can be set per account or project through the API. Training use and in-region processing are not stated on the current pages. Set `none` and check Voxtral's `allowed_modes` before production. |

Tokens: about 375 input tokens per 30 s audio window (about 750 per minute), plus about 35 for the prompt. Output is about 4.4 tokens per second of speech.

## Cost (eu-west-1 list prices, AWS Price List API)

Voxtral Mini 3B standard: $0.00005 per 1K input tokens and $0.00005 per 1K output tokens. For 200 messages of 2 minutes (400 minutes) a month:

- input ≈ 307K tokens, about $0.015
- output ≈ 106K tokens, about $0.005
- total **about $0.02 a month**

## Follow-up: the transcript came out in the wrong language (v0.1.4)

In production, English voice messages were transcribed in German. The prompt said "the speaker most likely speaks German" (the default hint). Voxtral on Bedrock takes audio only inside a chat message; Bedrock offers no transcription endpoint or language parameter for it. In that mode the model writes in the language the prompt points to, not the language spoken.

Tested on 24 synthetic clips (macOS voices, 12 English incl. 4 with a German accent, 12 German), then 45 clips including sentence-sized pieces of three 16–35 s messages and three noise or silence clips. "Kept" means the answer is in the spoken language.

| Setup | Kept | Notes |
| --- | --- | --- |
| Mini, v0.1.3 prompt with "most likely German" | 8/24 | English came back in German, or as `[no speech]`. One German clip looped the same sentence for 2048 tokens. |
| Mini, no hint | 13–20/22–24 | German came back in English. Short clips got chat answers ("I'm sorry, I can't send you the bill"). |
| Small, v0.1.3 prompt | 11/24 | Same as Mini: English into German. |
| Small, no hint | 13/24 | All German turned into English. |
| Small, language and transcript in one answer | 12/27 | Answered "None: [no speech]" for every English clip. |
| Mini, name the language first, then transcribe in it | 16–21/27 | Invented whole sentences on noise. |
| **Small, name the language first, then transcribe in it** | **44/45** | Word error rate 0.07. v0.1.4 uses this. |

Remaining misses with the v0.1.4 setup:

- A single "Ja." is heard as English "Yeah."
- A sentence that names a language is judged by that word: "My German is not very good, so I will write in English" and "But the transcript was in German, although I was speaking English" were both named German. Even with English set, the second came back as `[no speech]`, so that chunk is missing from the message.
- Shorter transcription prompts ("Transcribe this audio. The speaker speaks German.") translated German into English. The long prompt with its rules is better (word error rate 0.07 against 0.19–0.30).

Latency per chunk: about 0.2 s for the language and 1.0 s for the transcript (server time), against 0.3 s for Mini's single call. Both Voxtral models are marked Legacy on Bedrock, with end of life on 30 March 2027.

## Still open

- Real human speech, recorded with a microphone in Mattermost Desktop. TTS is cleaner than real voices, and the microphone permission flow was never exercised.
- Silent omissions: flag transcripts that are unusually short for their audio length.
- Playback in the Mattermost mobile apps on a real phone. The test server is local only.
- The composer slot hides with the formatting bar. Options: accept it and rely on the keyboard shortcut, or mount next to the send button through the DOM (undocumented, so it may break on upgrades).
- Edited marker: show the "Edited" label once the transcript lands, or create the post only after transcription (about 1–3 s of delay).
- Firefox records WebM only. Not tested.
