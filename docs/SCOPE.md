# hu-mm-av: scope

Telegram-style voice messages for Mattermost, with automatic transcription. Round video messages follow in phase 2.

Status: spike done 2026-11-24, see [SPIKE.md](SPIKE.md). Developed and tested against Mattermost 11.7.11 Team Edition.

## Decisions

| Topic | Decision |
| --- | --- |
| Clients | Desktop app and web record. The mobile apps only play back: the audio attachment plus the transcript as message text. No mobile fork. |
| v1 | Voice and automatic transcription. Round video is phase 2. |
| Recording | Press and hold the mic in the composer, release to send. Slide away to cancel. Drag up to lock for hands-free recording; when locked, the sender can listen back before sending. A keyboard shortcut can be held to record. |
| Transcription | Starts automatically after sending. The transcript is written into the post message so mobile users see it. On desktop it sits collapsed under the player. |
| Speech-to-text | Voxtral Mini 3B on Amazon Bedrock in eu-west-1 (Ireland), through the Converse API, about $0.02 a month at 400 minutes. The browser captures raw PCM while recording and sends 16 kHz WAV chunks of about 30 s, transcribed in parallel. Amazon Transcribe and Frankfurt were ruled out in the spike ([SPIKE.md](SPIKE.md)). The provider sits behind an interface, so an OpenAI-compatible EU endpoint can replace it through config. |
| Repo | `horseup/hu-mm-av`, public, MIT. No deployment secrets or internal data. All configuration goes through the System Console. |
| Stack | Go server plugin and a TypeScript/React webapp plugin. Server plugins must be Go, because the Mattermost plugin RPC has no Rust path. The webapp uses React provided by the host, so it is not bundled. Start fresh from `mattermost-plugin-starter-template`. MIT ideas from voice-notes (waveform player) and VoiceClips (circle player) are borrowed with attribution. |

### Performance and footprint

- Record with the browser's native `MediaRecorder` to AAC in MP4 (`.m4a`), with no JS or WASM encoder. Chromium 156 reports `audio/mp4;codecs=mp4a.40.2` as supported. Still to check: Mattermost Desktop's own Chromium. iOS and Android play AAC natively.
- Compute waveform peaks in the browser while recording (`AnalyserNode`) and store them in post props, so the server never decodes audio.
- Build the Go binary for `linux-amd64` and `linux-arm64` only, stripped (`-ldflags "-s -w"`). Sign AWS requests with SigV4 and the minimal SDK modules, not the full SDK.

## Feasibility findings

- Desktop and web: the webapp registry has what v1 needs. `registerPostEditorActionComponent` adds a composer toolbar button, and `registerPostTypeComponent` renders `custom_*` post types. There are also file upload and websocket hooks.
- Mobile: plugins cannot add UI. From reading the source (`app/components/post_list/post/body/body.tsx`), mobile renders a `custom_*` post as its message text plus standard file tiles. Audio plays in the app from server 10.7 and mobile 2.27. Not tested yet.
- Mattermost Agents plugin: its inter-plugin bridge offers completions only, not transcription, so this plugin calls speech-to-text itself.
- Upstream: community draft PR mattermost-mobile#10265 adds voice notes to the mobile composer as regular AAC `.m4a` attachments. It is unreviewed and marked stale. If it lands, its format matches ours.

## Existing plugins reviewed

| Plugin | State | Why not the base |
| --- | --- | --- |
| streamer45/mattermost-plugin-voice | Last release v0.3.0; issue #65 reports recording broken on 10.x | Broken on current webapp |
| osbren-corp/mattermost-plugin-voice-notes | MIT, v1.1.1 (2026-08-02), Mattermost 10+, webapp-only, MP3 | No server part; encodes in JS. Native AAC is smaller and faster |
| gluckdev/MattermostVoiceClips | MIT, v0.6.0, voice and round video, Go server, claims 7.x to 10.x, 1 star | WebM first (iOS playback risk); unproven on 11.7; its README's mobile recording claim does not match the mobile app |
| BerziOnline/mattermost-plugin-mediaforge | Apache-2.0, v0.1.2, ffmpeg on the server | Compression plugin; needs ffmpeg on the host |

## Architecture sketch

1. **Webapp.** The mic button opens the recorder (`MediaRecorder` plus a level meter), which handles the gestures. On send it uploads to the plugin endpoint `POST /plugins/hu-mm-av/api/v1/voice` (multipart audio plus duration and peaks).
2. **Server.** It checks `create_post` permission, then stores the file with `UploadFile`. It creates a `custom_hu_voice` post with `file_ids`, the placeholder message `🎤 0:42` and props `{duration, peaks, transcript_status: "pending"}`. Then it queues transcription on a bounded worker pool.
3. **Transcription.** The worker calls the provider and writes the transcript into the message and props. On failure it sets `transcript_status: "failed"` and shows a retry button on desktop.
4. **Renderer.** Desktop shows the waveform player (seek, 1×/1.5×/2×) with the transcript collapsed under it. Mobile shows the message text and the audio tile.
5. **Later option.** Auto-transcribe any audio attachment, so voice recorded on mobile through the OS or the upstream PR also gets a transcript.

## Phases

| Phase | Work | Estimate |
| --- | --- | --- |
| Spike | Done 2026-11-24, see [SPIKE.md](SPIKE.md) | 1 day |
| v1 voice | Recorder and all four gestures, upload and post, player, transcription, System Console settings, de/en strings, tests | 4–5 days |
| v1 release | iOS and Android check in the real Mattermost apps, GitHub Actions release tarball, README for other admins | 1 day |
| Phase 2 | Round video: front camera, square crop, circle player, MP4 (H.264 + AAC) | 3–5 days |

## Costs

200 voice messages of about 2 minutes each come to 400 audio minutes a month. With Voxtral Mini 3B on Bedrock eu-west-1, measured token counts and list prices from the AWS Price List API put that at **about $0.02 a month**. [SPIKE.md](SPIKE.md) has the breakdown.

The pre-spike comparison was Amazon Transcribe ($2.40–4.00 a month) and Voxtral Small (about $0.10). EC2 with self-hosted Whisper was rejected because it runs all the time.

## Open questions and risks

- **Bedrock data retention.** Bedrock does not share content with model providers. Retention mode `none` (zero data retention) can be set per account or per project through the API; there is no console setting. Check `allowed_modes` for Voxtral and set `none` before production ([data retention](https://docs.aws.amazon.com/bedrock/latest/userguide/data-retention.html), [data protection](https://docs.aws.amazon.com/bedrock/latest/userguide/data-protection.html)).
- **Silent omissions.** Voxtral drops repeated content, even inside a 30 s chunk. Flag a transcript that is unusually short for its audio length instead of trusting it.
- **Accuracy varies between runs** at temperature 0, and every test so far used TTS. Real voices need testing.
- **Composer slot.** The mic sits in the formatting bar and disappears when a user collapses it.
- **Firefox** cannot record MP4, so it falls back to WebM/Opus, which the iOS app may not play. Options: accept it, block recording in Firefox, or transcode on the server.
- **Edited marker.** Writing the transcript into the message marks the post "Edited". The alternative is to create the post only after transcription, about 1–3 s later.
- **AWS credentials.** They live either in plugin settings in the Mattermost config or in environment variables on the host. Use an IAM user scoped to `bedrock:InvokeModel` on Voxtral. Decide before the production install.
- **Plugin API drift.** Webapp plugin APIs can change between major versions, as when the original voice plugin broke at 10.x. Use only documented registry methods and run CI against the latest Mattermost.

## Sources

- [Mattermost webapp plugin registry](https://github.com/mattermost/mattermost/blob/master/webapp/channels/src/plugins/registry.ts)
- [Mattermost mobile post body](https://github.com/mattermost/mattermost-mobile/blob/main/app/components/post_list/post/body/body.tsx)
- [Mattermost mobile plugins docs](https://developers.mattermost.com/integrate/plugins/components/mobile)
- [Share files in messages (audio playback on mobile)](https://docs.mattermost.com/end-user-guide/collaborate/share-files-in-messages)
- [Agents LLM bridge](https://github.com/mattermost/mattermost-plugin-agents/blob/master/docs/llm_bridge.md)
- [mattermost-mobile#10265](https://github.com/mattermost/mattermost-mobile/pull/10265), [#9833](https://github.com/mattermost/mattermost-mobile/issues/9833)
- [streamer45/mattermost-plugin-voice](https://github.com/streamer45/mattermost-plugin-voice)
- [osbren-corp/mattermost-plugin-voice-notes](https://github.com/osbren-corp/mattermost-plugin-voice-notes), [forum post](https://forum.mattermost.com/t/voice-notes-a-lightweight-voice-messages-plugin-webapp-only-70-kb/26044)
- [gluckdev/MattermostVoiceClips](https://github.com/gluckdev/MattermostVoiceClips)
- [BerziOnline/mattermost-plugin-mediaforge](https://github.com/BerziOnline/mattermost-plugin-mediaforge)
- [Bedrock Voxtral Small model card](https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-mistral-ai-voxtral-small-24b-2507.html), [re:Post audio modality report](https://repost.aws/questions/QUvp_Dp2giQ3aBO8nS8uG1Fg/voxtral-model-error-when-processing-audio-for-eu-west-1)
- AWS Price List API: `offers/v1.0/aws/AmazonBedrock/current/eu-west-1/index.json` (and `transcribe`/`eu-central-1` for the pre-spike comparison)
