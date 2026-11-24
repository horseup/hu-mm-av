// Spike: hold-to-record voice messages in the Mattermost composer. Plain JS, no build step.
// Tests the composer slot, pointer gestures, native AAC recording, 16 kHz WAV for STT,
// and a custom_hu_voice post with file attachments. Not production code.
(function () {
    'use strict';
    const PLUGIN_ID = 'de.horseup.mm-av-spike';
    const React = window.React;
    const h = React.createElement;
    const MIME_CANDIDATES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus'];
    const MIN_MS = 500; // shorter press = tap, show hint
    const SLIDE_PX = 60;
    const S = window.__humm = window.__humm || {events: []};
    const log = (e, x) => { S.events.push({t: Date.now(), e, ...(x || {})}); console.log('[humm]', e, x || ''); };

    const csrf = () => (document.cookie.match(/MMCSRF=([^;]+)/) || [])[1] || '';
    async function api(path, opts = {}) {
        const res = await fetch('/api/v4' + path, {credentials: 'include', ...opts,
            headers: {'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf(), ...(opts.headers || {})}});
        if (!res.ok) throw new Error(`${path} ${res.status} ${await res.text()}`);
        return res.json();
    }
    const fmt = (ms) => { const s = Math.round(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

    async function openSource() {
        if (S.fakeAudioUrl) { // test hook: play a file into the recorder instead of the mic
            const ctx = new AudioContext();
            const buf = await ctx.decodeAudioData(await (await fetch(S.fakeAudioUrl, {credentials: 'include'})).arrayBuffer());
            const src = ctx.createBufferSource(); src.buffer = buf;
            const dest = ctx.createMediaStreamDestination(); src.connect(dest); src.start();
            return {stream: dest.stream, close: () => { try { src.stop(); } catch (e) { /* already stopped */ } ctx.close(); }};
        }
        const stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
        return {stream, close: () => stream.getTracks().forEach((t) => t.stop())};
    }

    async function startRecording() {
        const source = await openSource();
        const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
        const recorder = new MediaRecorder(source.stream, {mimeType: mime, audioBitsPerSecond: 64000});
        const chunks = [];
        recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
        const stopped = new Promise((resolve) => { recorder.onstop = () => resolve(new Blob(chunks, {type: recorder.mimeType})); });
        recorder.start(250);
        const startedAt = performance.now();
        log('rec.start', {mime: recorder.mimeType});
        return {mime: recorder.mimeType, startedAt,
            stop: async () => { if (recorder.state !== 'inactive') recorder.stop(); const blob = await stopped; source.close(); return {blob, ms: performance.now() - startedAt}; }};
    }

    // Decode the recording and resample to 16 kHz mono 16-bit PCM WAV (what Voxtral on Bedrock accepts).
    async function toWav16k(blob) {
        const decoded = await new AudioContext().decodeAudioData(await blob.arrayBuffer());
        const off = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
        const src = off.createBufferSource(); src.buffer = decoded; src.connect(off.destination); src.start();
        const pcm = (await off.startRendering()).getChannelData(0);
        const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
        const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
        out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
        str(36, 'data'); out.setUint32(40, pcm.length * 2, true);
        for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
        return new Blob([out], {type: 'audio/wav'});
    }

    async function sendVoice(blob, ms, mime, draft) {
        const t0 = performance.now();
        // The 16 kHz WAV is for transcription only. It stays in memory (window.__humm.lastWav) until the
        // plugin server exists; it is never attached to the post, so a voice message carries one file.
        const wav = await toWav16k(blob);
        S.lastWav = wav;
        const ts = Date.now();
        const fd = new FormData();
        fd.append('channel_id', draft.channelId);
        fd.append('files', new File([blob], `voice-${ts}.m4a`, {type: mime}));
        const up = await api('/files', {method: 'POST', body: fd});
        const post = await api('/posts', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
            channel_id: draft.channelId, root_id: draft.rootId || '', type: 'custom_hu_voice',
            message: `🎤 Sprachnachricht (${fmt(ms)})`, file_ids: up.file_infos.map((f) => f.id),
            props: {hu_voice: {duration_ms: Math.round(ms), mime, spike: true}}})});
        S.last = {postId: post.id, fileIds: up.file_infos.map((f) => f.id), m4aBytes: blob.size, wavBytes: wav.size, ms, mime, sendMs: performance.now() - t0};
        log('sent', S.last);
    }

    function MicButton(props) {
        const [mode, setModeState] = React.useState('idle'); // idle | recording | cancel | locked | preview | hint
        const [elapsed, setElapsed] = React.useState(0);
        const modeRef = React.useRef('idle');
        const recRef = React.useRef(null);
        const originRef = React.useRef(null);
        const previewRef = React.useRef(null);
        const setMode = (m) => { modeRef.current = m; setModeState(m); log('mode', {m}); };

        React.useEffect(() => {
            if (mode !== 'recording' && mode !== 'cancel' && mode !== 'locked') return undefined;
            const id = setInterval(() => recRef.current && recRef.current.then((r) => setElapsed(performance.now() - r.startedAt)), 200);
            return () => clearInterval(id);
        }, [mode]);

        const discard = async () => { const r = recRef.current && await recRef.current; recRef.current = null; if (r) await r.stop(); setMode('idle'); };
        const stopAndSend = async () => {
            const r = await recRef.current; recRef.current = null;
            const {blob, ms} = await r.stop();
            if (ms < MIN_MS) { setMode('hint'); setTimeout(() => modeRef.current === 'hint' && setMode('idle'), 1500); return; }
            setMode('idle');
            await sendVoice(blob, ms, r.mime, props.draft).catch((e) => log('send.error', {message: String(e)}));
        };
        const stopToPreview = async () => {
            const r = await recRef.current; recRef.current = null;
            const res = await r.stop();
            previewRef.current = {...res, mime: r.mime, url: URL.createObjectURL(res.blob)};
            setMode('preview');
        };

        const onPointerDown = (e) => {
            if (modeRef.current !== 'idle' && modeRef.current !== 'hint') return;
            e.preventDefault();
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
            originRef.current = {x: e.clientX, y: e.clientY};
            recRef.current = startRecording();
            recRef.current.catch((err) => { log('rec.error', {message: String(err)}); recRef.current = null; setMode('idle'); });
            setElapsed(0);
            setMode('recording');
        };
        const onPointerMove = (e) => {
            const o = originRef.current; const m = modeRef.current;
            if (!o || (m !== 'recording' && m !== 'cancel')) return;
            const dx = e.clientX - o.x; const dy = e.clientY - o.y;
            if (dy < -SLIDE_PX) { originRef.current = null; setMode('locked'); } else if (dx < -SLIDE_PX) { if (m !== 'cancel') setMode('cancel'); } else if (m === 'cancel') setMode('recording');
        };
        const onPointerUp = () => {
            originRef.current = null;
            const m = modeRef.current;
            if (m === 'cancel') discard(); else if (m === 'recording') stopAndSend();
        };

        const btnStyle = {border: 0, background: mode === 'recording' ? '#d24b4e' : 'transparent', color: mode === 'recording' ? '#fff' : 'inherit',
            borderRadius: 4, padding: '4px 6px', cursor: 'pointer', touchAction: 'none', userSelect: 'none'};
        const chip = (text, color) => h('span', {style: {fontSize: 12, marginLeft: 6, color}}, text);
        const small = (label, onClick) => h('button', {type: 'button', onClick, style: {marginLeft: 6, fontSize: 12}}, label);

        return h('span', {style: {display: 'inline-flex', alignItems: 'center'}, 'data-humm-mode': mode},
            h('button', {type: 'button', 'aria-label': 'Sprachnachricht aufnehmen', 'data-humm': 'mic', style: btnStyle,
                onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp}, '🎤'),
            mode === 'recording' && chip(`● ${fmt(elapsed)}  ← verwerfen · ↑ sperren`, '#d24b4e'),
            mode === 'cancel' && chip('Loslassen zum Verwerfen', '#888'),
            mode === 'hint' && chip('Gedrückt halten zum Aufnehmen', '#888'),
            mode === 'locked' && h('span', null, chip(`🔒 ● ${fmt(elapsed)}`, '#d24b4e'),
                small('Anhören', stopToPreview), small('Senden', stopAndSend), small('Verwerfen', discard)),
            mode === 'preview' && h('span', null,
                h('audio', {controls: true, src: previewRef.current.url, style: {height: 28, verticalAlign: 'middle', marginLeft: 6}}),
                small('Senden', async () => { const p = previewRef.current; setMode('idle'); await sendVoice(p.blob, p.ms, p.mime, props.draft); }),
                small('Verwerfen', () => setMode('idle'))));
    }

    // Inline player for custom_hu_voice posts. File infos live in the store (entities.files), not in
    // post.metadata. Only one voice message plays at a time.
    let currentAudio = null;
    const RATES = [1, 1.5, 2];
    function VoicePost(props) {
        const post = props.post;
        const ids = post.file_ids || [];
        const files = window.ReactRedux.useSelector((st) => ids.map((id) => st.entities.files.files[id]).filter(Boolean), window.ReactRedux.shallowEqual);
        const file = files.find((f) => (f.mime_type || '').startsWith('audio/') && !f.name.endsWith('.stt.wav'));
        const fileId = file ? file.id : ids[0];
        const knownSec = (((post.props || {}).hu_voice || {}).duration_ms || 0) / 1000;
        const audioRef = React.useRef(null);
        const [playing, setPlaying] = React.useState(false);
        const [pos, setPos] = React.useState(0);
        const [dur, setDur] = React.useState(knownSec);
        const [rate, setRate] = React.useState(1);

        React.useEffect(() => {
            const a = audioRef.current;
            if (!a) return undefined;
            const on = {
                play: () => setPlaying(true),
                pause: () => setPlaying(false),
                ended: () => { setPlaying(false); setPos(0); },
                timeupdate: () => setPos(a.currentTime),
                loadedmetadata: () => { if (isFinite(a.duration) && a.duration > 0) setDur(a.duration); },
            };
            Object.entries(on).forEach(([k, fn]) => a.addEventListener(k, fn));
            return () => Object.entries(on).forEach(([k, fn]) => a.removeEventListener(k, fn));
        }, [fileId]);

        if (!fileId) return h('div', {'data-humm': 'voice-post'}, post.message);
        const toggle = () => {
            const a = audioRef.current;
            if (!a.paused) { a.pause(); return; }
            if (currentAudio && currentAudio !== a) currentAudio.pause();
            currentAudio = a;
            a.playbackRate = rate;
            a.play().catch((e) => log('play.error', {message: String(e)}));
        };
        const seek = (e) => {
            const a = audioRef.current; const d = dur || a.duration;
            if (!d) return;
            const r = e.currentTarget.getBoundingClientRect();
            a.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * d;
            setPos(a.currentTime);
        };
        const cycleRate = () => {
            const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
            setRate(next); audioRef.current.playbackRate = next;
        };
        const pct = dur ? Math.min(100, (pos / dur) * 100) : 0;
        const fg = 'rgba(var(--center-channel-color-rgb), 0.64)';

        return h('div', {'data-humm': 'voice-post', style: {display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 360}},
            h('audio', {ref: audioRef, preload: 'metadata', src: `/api/v4/files/${fileId}`}),
            h('div', {style: {display: 'flex', alignItems: 'center', gap: 10}},
                h('button', {type: 'button', 'data-humm': 'play', 'aria-label': playing ? 'Pause' : 'Abspielen', onClick: toggle,
                    style: {width: 36, height: 36, borderRadius: '50%', border: 0, flex: 'none', cursor: 'pointer',
                        background: 'var(--button-bg)', color: 'var(--button-color)', fontSize: 14, lineHeight: '36px', padding: 0}},
                playing ? '❚❚' : '▶'),
                h('div', {'data-humm': 'seek', onClick: seek, style: {flex: 1, height: 16, display: 'flex', alignItems: 'center', cursor: 'pointer'}},
                    h('div', {style: {position: 'relative', width: '100%', height: 4, borderRadius: 2, background: 'rgba(var(--center-channel-color-rgb), 0.16)'}},
                        h('div', {style: {position: 'absolute', left: 0, top: 0, bottom: 0, width: `${pct}%`, borderRadius: 2, background: 'var(--button-bg)'}}))),
                h('span', {'data-humm': 'time', style: {fontSize: 12, color: fg, fontVariantNumeric: 'tabular-nums', flex: 'none'}},
                    playing || pos > 0 ? fmt(pos * 1000) : fmt(dur * 1000)),
                h('button', {type: 'button', 'data-humm': 'rate', onClick: cycleRate, 'aria-label': 'Wiedergabegeschwindigkeit',
                    style: {border: `1px solid ${fg}`, borderRadius: 10, background: 'transparent', color: fg, fontSize: 11, padding: '0 6px', cursor: 'pointer', flex: 'none'}},
                `${rate}×`)),
            h('div', {style: {fontSize: 13, color: fg}}, post.message));
    }

    // Hide the core file tiles under voice posts on desktop/web. Mobile apps don't run plugin code and keep them.
    const STYLE_ID = 'humm-style';
    const CSS = '.post__body:has([data-humm=voice-post]) > .post-image__columns { display: none; }';

    window.registerPlugin(PLUGIN_ID, {
        initialize(registry) {
            registry.registerPostEditorActionComponent(MicButton);
            registry.registerPostTypeComponent('custom_hu_voice', VoicePost);
            if (!document.getElementById(STYLE_ID)) {
                const style = document.createElement('style'); style.id = STYLE_ID; style.textContent = CSS;
                document.head.appendChild(style);
            }
            log('init');
        },
        uninitialize() {
            const style = document.getElementById(STYLE_ID); if (style) style.remove();
            if (currentAudio) currentAudio.pause();
        },
    });
}());
