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
            return {stream: dest.stream, ctx, node: src, close: () => { try { src.stop(); } catch (e) { /* already stopped */ } ctx.close(); }};
        }
        const stream = await navigator.mediaDevices.getUserMedia({audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true}});
        const ctx = new AudioContext();
        return {stream, ctx, node: ctx.createMediaStreamSource(stream), close: () => { stream.getTracks().forEach((t) => t.stop()); ctx.close(); }};
    }

    async function startRecording() {
        const source = await openSource();
        const analyser = source.ctx.createAnalyser(); analyser.fftSize = 1024;
        source.node.connect(analyser);
        const frame = new Float32Array(analyser.fftSize);
        const level = () => { analyser.getFloatTimeDomainData(frame); let s = 0; for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i]; return Math.min(1, Math.sqrt(s / frame.length) * 5); };
        const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
        const recorder = new MediaRecorder(source.stream, {mimeType: mime, audioBitsPerSecond: 64000});
        const chunks = [];
        recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
        const stopped = new Promise((resolve) => { recorder.onstop = () => resolve(new Blob(chunks, {type: recorder.mimeType})); });
        recorder.start(250);
        const startedAt = performance.now();
        log('rec.start', {mime: recorder.mimeType});
        return {mime: recorder.mimeType, startedAt, level,
            stop: async () => { if (recorder.state !== 'inactive') recorder.stop(); const blob = await stopped; source.close(); return {blob, ms: performance.now() - startedAt}; }};
    }

    const decodeAudio = async (arrayBuffer) => {
        const ctx = new AudioContext();
        try { return await ctx.decodeAudioData(arrayBuffer); } finally { ctx.close(); }
    };

    // Waveform: loudness per bar (0–100), RMS per bucket scaled to the loudest bar, with a gentle curve so
    // quiet speech still shows. Stored in props.hu_voice.peaks at send time; computed on demand otherwise.
    const PEAK_BARS = 48;
    function computePeaks(buffer, n = PEAK_BARS) {
        const ch = buffer.getChannelData(0);
        const size = Math.max(1, Math.floor(ch.length / n));
        const out = [];
        for (let b = 0; b < n; b++) {
            const start = b * size; const end = Math.min(ch.length, start + size);
            let s = 0; for (let i = start; i < end; i++) s += ch[i] * ch[i];
            out.push(Math.sqrt(s / Math.max(1, end - start)));
        }
        const max = Math.max(...out, 1e-6);
        return out.map((v) => Math.round(Math.pow(v / max, 0.7) * 100));
    }

    // Resample decoded audio to 16 kHz mono 16-bit PCM WAV (what Voxtral on Bedrock accepts).
    async function toWav16k(decoded) {
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
        const decoded = await decodeAudio(await blob.arrayBuffer());
        const wav = await toWav16k(decoded);
        const peaks = computePeaks(decoded);
        S.lastWav = wav;
        const ts = Date.now();
        const fd = new FormData();
        fd.append('channel_id', draft.channelId);
        fd.append('files', new File([blob], `voice-${ts}.m4a`, {type: mime}));
        const up = await api('/files', {method: 'POST', body: fd});
        const post = await api('/posts', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
            channel_id: draft.channelId, root_id: draft.rootId || '', type: 'custom_hu_voice',
            message: `🎤 Sprachnachricht (${fmt(ms)})`, file_ids: up.file_infos.map((f) => f.id),
            props: {hu_voice: {duration_ms: Math.round(ms), mime, peaks, spike: true}}})});
        S.last = {postId: post.id, fileIds: up.file_infos.map((f) => f.id), m4aBytes: blob.size, wavBytes: wav.size, ms, mime, sendMs: performance.now() - t0};
        log('sent', S.last);
    }

    // ---- Recorder UI -------------------------------------------------------------------------------
    // While recording, an overlay covers the composer (like Telegram's input bar turning into the
    // recorder). Holding: timer, live level bars, "slide left to cancel", lock hint above the mic.
    // Locked: ✕ cancel, timer + levels, stop-to-listen, send. Preview: ✕, play/pause + progress, send.
    const RED = '#d24b4e';
    const ICON = {
        mic: {fill: 'M12 15a3.5 3.5 0 0 0 3.5-3.5v-6a3.5 3.5 0 0 0-7 0v6A3.5 3.5 0 0 0 12 15zm6-3.5h-1.6a4.4 4.4 0 0 1-8.8 0H6a6 6 0 0 0 5.2 5.94V20h1.6v-2.56A6 6 0 0 0 18 11.5z'},
        x: {stroke: 'M6 6l12 12M18 6L6 18'},
        lock: {stroke: 'M8 11V8a4 4 0 0 1 8 0v3M6 11h12v9H6z'},
        send: {fill: 'M3 11.4L21 3l-8.4 18-2.1-7.5z'},
        stop: {fill: 'M7 7h10v10H7z'},
        trash: {stroke: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3'},
        chevL: {stroke: 'M15 6l-6 6 6 6'},
        chevU: {stroke: 'M6 15l6-6 6 6'},
        play: {fill: 'M8 5v14l11-7z'},
        pause: {fill: 'M7 5h4v14H7zM13 5h4v14h-4z'},
    };
    const icon = (name, size = 18) => {
        const d = ICON[name];
        return h('svg', {width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: {display: 'block', flex: 'none'}},
            d.fill ? h('path', {d: d.fill, fill: 'currentColor'}) :
                h('path', {d: d.stroke, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round'}));
    };
    const muted = 'rgba(var(--center-channel-color-rgb), 0.64)';
    const circleBtn = (bg, color, size = 32) => ({width: size, height: size, borderRadius: '50%', border: 0, padding: 0, flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: bg, color});

    // Re-measure an element's viewport rect while active (layout can shift, e.g. the window resizes).
    function useRect(el, active) {
        const [rect, setRect] = React.useState(null);
        React.useEffect(() => {
            if (!active || !el) { setRect(null); return undefined; }
            const measure = () => { const r = el.getBoundingClientRect(); setRect((p) => (p && p.left === r.left && p.top === r.top && p.width === r.width && p.height === r.height ? p : {left: r.left, top: r.top, width: r.width, height: r.height})); };
            measure();
            const id = setInterval(measure, 250); window.addEventListener('resize', measure);
            return () => { clearInterval(id); window.removeEventListener('resize', measure); };
        }, [el, active]);
        return rect;
    }

    function LevelBars({levels, color}) {
        return h('div', {'data-humm': 'levels', style: {flex: 1, minWidth: 0, height: 24, display: 'flex', alignItems: 'center', gap: 2, overflow: 'hidden', justifyContent: 'flex-end'}},
            levels.map((v, i) => h('div', {key: i, style: {width: 3, flex: 'none', borderRadius: 2, background: color, height: `${Math.max(3, Math.round(v * 22))}px`, opacity: 0.35 + v * 0.65}})));
    }

    function Timer({ms, blink}) {
        return h('span', {style: {display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none', fontVariantNumeric: 'tabular-nums', fontSize: 14, color: 'var(--center-channel-color)'}},
            h('span', {'data-humm-anim': 'blink', style: {width: 8, height: 8, borderRadius: '50%', background: RED, animation: blink ? 'humm-blink 1s ease-in-out infinite' : 'none'}}), fmt(ms));
    }

    // Bars fill with the accent colour as playback passes them; clicking a bar seeks there.
    function Waveform({peaks, progress, onSeek, height = 28}) {
        const loading = !(peaks && peaks.length);
        const bars = loading ? new Array(PEAK_BARS).fill(14) : peaks;
        const n = bars.length;
        const seek = (e) => { if (!onSeek) return; const r = e.currentTarget.getBoundingClientRect(); onSeek(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))); };
        return h('div', {'data-humm': 'seek', role: 'slider', 'aria-label': 'Position', 'aria-valuemin': 0, 'aria-valuemax': 100,
            'aria-valuenow': Math.round(progress * 100), onClick: seek,
            style: {flex: 'none', width: n * 5 - 2, height, display: 'flex', alignItems: 'center', gap: 2, cursor: onSeek ? 'pointer' : 'default', opacity: loading ? 0.5 : 1}},
        bars.map((v, i) => h('div', {key: i, style: {width: 3, flex: 'none', borderRadius: 2, height: Math.max(3, Math.round((v / 100) * height)),
            background: (i + 0.5) / n <= progress ? 'var(--button-bg)' : 'rgba(var(--center-channel-color-rgb), 0.24)'}})));
    }

    // Smooth progress while playing (timeupdate alone fires only about 4 times a second).
    function usePlaybackPosition(audioRef, playing, setPos) {
        React.useEffect(() => {
            if (!playing) return undefined;
            let raf = 0;
            const tick = () => { if (audioRef.current) setPos(audioRef.current.currentTime); raf = requestAnimationFrame(tick); };
            raf = requestAnimationFrame(tick);
            return () => cancelAnimationFrame(raf);
        }, [playing]);
    }

    function PreviewPlayer({url, ms, peaks}) {
        const ref = React.useRef(null);
        const [playing, setPlaying] = React.useState(false);
        const [pos, setPos] = React.useState(0);
        React.useEffect(() => {
            const a = ref.current;
            const on = {play: () => setPlaying(true), pause: () => setPlaying(false), ended: () => { setPlaying(false); setPos(0); }, timeupdate: () => setPos(a.currentTime)};
            Object.entries(on).forEach(([k, fn]) => a.addEventListener(k, fn));
            return () => { a.pause(); Object.entries(on).forEach(([k, fn]) => a.removeEventListener(k, fn)); };
        }, [url]);
        usePlaybackPosition(ref, playing, setPos);
        const dur = ms / 1000;
        const toggle = () => { const a = ref.current; if (a.paused) a.play(); else a.pause(); };
        const onSeek = (ratio) => { ref.current.currentTime = ratio * dur; setPos(ratio * dur); };
        return h('div', {style: {flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10}},
            h('audio', {ref, src: url, preload: 'auto'}),
            h('button', {type: 'button', 'data-humm': 'preview-play', 'aria-label': playing ? 'Pause' : 'Anhören', onClick: toggle, style: circleBtn('rgba(var(--center-channel-color-rgb), 0.08)', 'var(--center-channel-color)')}, icon(playing ? 'pause' : 'play', 16)),
            h(Waveform, {peaks, progress: dur ? Math.min(1, pos / dur) : 0, onSeek}),
            h('span', {style: {fontSize: 12, color: muted, fontVariantNumeric: 'tabular-nums', flex: 'none'}}, fmt((playing || pos > 0 ? pos : dur) * 1000)));
    }

    function MicButton(props) {
        const [mode, setModeState] = React.useState('idle'); // idle | recording | cancel | locked | preview | hint
        const [elapsed, setElapsed] = React.useState(0);
        const [levels, setLevels] = React.useState([]);
        const [btnEl, setBtnEl] = React.useState(null);
        const modeRef = React.useRef('idle');
        const recRef = React.useRef(null);
        const originRef = React.useRef(null);
        const previewRef = React.useRef(null);
        const setMode = (m) => { modeRef.current = m; setModeState(m); log('mode', {m}); };
        const active = mode !== 'idle';
        const editorEl = btnEl && btnEl.closest('.AdvancedTextEditor__body');
        const editorRect = useRect(editorEl, active && mode !== 'hint');
        const micRect = useRect(btnEl, active);

        // Timer and level bars while recording.
        React.useEffect(() => {
            if (mode !== 'recording' && mode !== 'cancel' && mode !== 'locked') return undefined;
            let raf = 0; let rec = null; let frameNo = 0; const hist = [];
            if (recRef.current) recRef.current.then((r) => { rec = r; }).catch(() => {});
            const tick = () => {
                if (rec && frameNo++ % 3 === 0) {
                    hist.push(rec.level()); if (hist.length > 320) hist.shift();
                    setLevels(hist.slice()); setElapsed(performance.now() - rec.startedAt);
                }
                raf = requestAnimationFrame(tick);
            };
            raf = requestAnimationFrame(tick);
            return () => cancelAnimationFrame(raf);
        }, [mode]);

        const discard = async () => { const p = recRef.current; recRef.current = null; setMode('idle'); setLevels([]); const r = p && await p.catch(() => null); if (r) await r.stop(); };
        const stopAndSend = async () => {
            const r = await recRef.current; recRef.current = null;
            const {blob, ms} = await r.stop();
            setLevels([]);
            if (ms < MIN_MS) { setMode('hint'); setTimeout(() => modeRef.current === 'hint' && setMode('idle'), 1500); return; }
            setMode('idle');
            await sendVoice(blob, ms, r.mime, props.draft).catch((e) => log('send.error', {message: String(e)}));
        };
        const stopToPreview = async () => {
            const r = await recRef.current; recRef.current = null;
            const res = await r.stop();
            let peaks = null;
            try { peaks = computePeaks(await decodeAudio(await res.blob.arrayBuffer())); } catch (e) { log('peaks.error', {message: String(e)}); }
            previewRef.current = {...res, mime: r.mime, url: URL.createObjectURL(res.blob), peaks};
            setLevels([]); setMode('preview');
        };
        const sendPreview = async () => { const p = previewRef.current; setMode('idle'); URL.revokeObjectURL(p.url); await sendVoice(p.blob, p.ms, p.mime, props.draft).catch((e) => log('send.error', {message: String(e)})); };
        const discardPreview = () => { const p = previewRef.current; if (p) URL.revokeObjectURL(p.url); previewRef.current = null; setMode('idle'); };

        // Esc cancels, Enter sends, while locked or previewing.
        React.useEffect(() => {
            if (mode !== 'locked' && mode !== 'preview') return undefined;
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (mode === 'locked') discard(); else discardPreview(); }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); if (mode === 'locked') stopAndSend(); else sendPreview(); }
            };
            window.addEventListener('keydown', onKey, true);
            return () => window.removeEventListener('keydown', onKey, true);
        }, [mode]);

        const onPointerDown = (e) => {
            if (modeRef.current !== 'idle' && modeRef.current !== 'hint') return;
            e.preventDefault();
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
            originRef.current = {x: e.clientX, y: e.clientY};
            recRef.current = startRecording();
            recRef.current.catch((err) => { log('rec.error', {message: String(err)}); recRef.current = null; setMode('idle'); });
            setElapsed(0); setLevels([]);
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

        // --- overlay contents per mode ---
        let bar = null;
        if (mode === 'recording') {
            bar = [h(Timer, {key: 't', ms: elapsed, blink: true}),
                h('span', {key: 'c', 'data-humm': 'slide-hint', style: {display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none', fontSize: 13, color: muted}},
                    h('span', {'data-humm-anim': 'nudge', style: {animation: 'humm-nudge 1.2s ease-in-out infinite'}}, icon('chevL', 16)), 'Nach links: abbrechen'),
                h(LevelBars, {key: 'l', levels, color: RED})];
        } else if (mode === 'cancel') {
            bar = [h('span', {key: 'c', style: {display: 'inline-flex', alignItems: 'center', gap: 8, color: RED, fontSize: 14, fontWeight: 600}}, icon('trash', 18), 'Loslassen zum Verwerfen'),
                h('span', {key: 's', style: {flex: 1}}), h(Timer, {key: 't', ms: elapsed, blink: false})];
        } else if (mode === 'locked') {
            bar = [h('button', {key: 'x', type: 'button', 'data-humm': 'cancel', 'aria-label': 'Aufnahme verwerfen', title: 'Verwerfen (Esc)', onClick: discard, style: circleBtn('rgba(var(--center-channel-color-rgb), 0.08)', 'var(--center-channel-color)')}, icon('x', 16)),
                h(Timer, {key: 't', ms: elapsed, blink: true}), h(LevelBars, {key: 'l', levels, color: RED}),
                h('button', {key: 'p', type: 'button', 'data-humm': 'listen', 'aria-label': 'Stoppen und anhören', title: 'Stoppen und anhören', onClick: stopToPreview, style: circleBtn('rgba(var(--center-channel-color-rgb), 0.08)', RED)}, icon('stop', 14)),
                h('button', {key: 's', type: 'button', 'data-humm': 'send', 'aria-label': 'Senden', title: 'Senden (Enter)', onClick: stopAndSend, style: circleBtn('var(--button-bg)', 'var(--button-color)', 36)}, icon('send', 18))];
        } else if (mode === 'preview') {
            bar = [h('button', {key: 'x', type: 'button', 'data-humm': 'cancel', 'aria-label': 'Aufnahme verwerfen', title: 'Verwerfen (Esc)', onClick: discardPreview, style: circleBtn('rgba(var(--center-channel-color-rgb), 0.08)', 'var(--center-channel-color)')}, icon('x', 16)),
                h(PreviewPlayer, {key: 'pp', url: previewRef.current.url, ms: previewRef.current.ms, peaks: previewRef.current.peaks}),
                h('button', {key: 's', type: 'button', 'data-humm': 'send', 'aria-label': 'Senden', title: 'Senden (Enter)', onClick: sendPreview, style: circleBtn('var(--button-bg)', 'var(--button-color)', 36)}, icon('send', 18))];
        }

        const overlays = [];
        // While holding, the red mic orb sits over the button (mid-bar, not at the edge), so content stops left of it.
        const holding = mode === 'recording' || mode === 'cancel';
        const orbPad = holding && micRect && editorRect ? Math.max(12, Math.round(editorRect.left + editorRect.width - (micRect.left + micRect.width / 2 - 36))) : 12;
        if (bar && editorRect) {
            overlays.push(h('div', {key: 'bar', 'data-humm': 'recorder', 'data-humm-mode-bar': mode, style: {position: 'fixed', zIndex: 1000,
                left: editorRect.left, top: editorRect.top, width: editorRect.width, height: editorRect.height, boxSizing: 'border-box',
                display: 'flex', alignItems: 'center', gap: 12, padding: `0 ${orbPad}px 0 12px`, borderRadius: 4,
                background: 'var(--center-channel-bg)', border: '1px solid rgba(var(--center-channel-color-rgb), 0.16)',
                boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)', pointerEvents: mode === 'locked' || mode === 'preview' ? 'auto' : 'none'}}, bar));
        }
        if ((mode === 'recording' || mode === 'cancel') && micRect) {
            const cx = micRect.left + micRect.width / 2; const cy = micRect.top + micRect.height / 2;
            overlays.push(h('div', {key: 'orb', 'data-humm-anim': 'pulse', style: {position: 'fixed', zIndex: 1001, pointerEvents: 'none', left: cx - 24, top: cy - 24, width: 48, height: 48, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: mode === 'cancel' ? 'rgba(var(--center-channel-color-rgb), 0.48)' : RED,
                animation: mode === 'recording' ? 'humm-pulse 1.4s ease-out infinite' : 'none'}}, icon(mode === 'cancel' ? 'trash' : 'mic', 22)));
            if (mode === 'recording') {
                overlays.push(h('div', {key: 'lock', 'data-humm': 'lock-hint', style: {position: 'fixed', zIndex: 1001, pointerEvents: 'none', left: cx - 18, top: cy - 24 - 76, width: 36, height: 68, borderRadius: 18,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-around', padding: '6px 0', boxSizing: 'border-box',
                    background: 'var(--center-channel-bg)', color: muted, border: '1px solid rgba(var(--center-channel-color-rgb), 0.16)', boxShadow: '0 2px 6px rgba(0, 0, 0, 0.12)'}},
                icon('lock', 16), h('span', {'data-humm-anim': 'rise', style: {animation: 'humm-rise 1.2s ease-in-out infinite'}}, icon('chevU', 16))));
            }
        }
        if (mode === 'hint' && micRect) {
            overlays.push(h('div', {key: 'hint', 'data-humm': 'hold-hint', style: {position: 'fixed', zIndex: 1001, pointerEvents: 'none', left: micRect.left + micRect.width / 2, top: micRect.top - 8,
                transform: 'translate(-50%, -100%)', whiteSpace: 'nowrap', fontSize: 12, padding: '4px 8px', borderRadius: 4,
                background: 'var(--center-channel-color)', color: 'var(--center-channel-bg)'}}, 'Zum Aufnehmen gedrückt halten'));
        }

        return h('span', {style: {display: 'inline-flex', alignItems: 'center'}, 'data-humm-mode': mode},
            h('button', {type: 'button', ref: setBtnEl, className: 'humm-mic', 'aria-label': 'Sprachnachricht aufnehmen (gedrückt halten)', title: 'Gedrückt halten zum Aufnehmen', 'data-humm': 'mic',
                onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp}, icon('mic', 18)),
            overlays.length ? window.ReactDOM.createPortal(overlays, document.body) : null);
    }

    // Inline player for custom_hu_voice posts. File infos live in the store (entities.files), not in
    // post.metadata. Only one voice message plays at a time.
    let currentAudio = null;
    const peakCache = new Map(); // fileId -> peaks, for posts without stored peaks
    const RATES = [1, 1.5, 2];
    function VoicePost(props) {
        const post = props.post;
        const ids = post.file_ids || [];
        const files = window.ReactRedux.useSelector((st) => ids.map((id) => st.entities.files.files[id]).filter(Boolean), window.ReactRedux.shallowEqual);
        const file = files.find((f) => (f.mime_type || '').startsWith('audio/') && !f.name.endsWith('.stt.wav'));
        const fileId = file ? file.id : ids[0];
        const hv = (post.props || {}).hu_voice || {};
        const knownSec = (hv.duration_ms || 0) / 1000;
        const audioRef = React.useRef(null);
        const [playing, setPlaying] = React.useState(false);
        const [pos, setPos] = React.useState(0);
        const [dur, setDur] = React.useState(knownSec);
        const [rate, setRate] = React.useState(1);
        const propPeaks = hv.peaks;
        const [peaks, setPeaks] = React.useState(propPeaks || peakCache.get(fileId) || null);
        usePlaybackPosition(audioRef, playing, setPos);

        // Older posts (and audio from other clients) have no stored peaks: decode once and cache.
        React.useEffect(() => {
            if (propPeaks) { setPeaks(propPeaks); return undefined; }
            if (!fileId) return undefined;
            if (peakCache.has(fileId)) { setPeaks(peakCache.get(fileId)); return undefined; }
            let alive = true;
            (async () => {
                try {
                    const res = await fetch(`/api/v4/files/${fileId}`, {credentials: 'include', headers: {'X-Requested-With': 'XMLHttpRequest'}});
                    const p = computePeaks(await decodeAudio(await res.arrayBuffer()));
                    peakCache.set(fileId, p);
                    if (alive) setPeaks(p);
                } catch (e) { log('peaks.error', {message: String(e)}); }
            })();
            return () => { alive = false; };
        }, [fileId, propPeaks]);

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
        const onSeek = (ratio) => {
            const a = audioRef.current; const d = dur || a.duration;
            if (!d) return;
            a.currentTime = ratio * d;
            setPos(a.currentTime);
        };
        const cycleRate = () => {
            const next = RATES[(RATES.indexOf(rate) + 1) % RATES.length];
            setRate(next); audioRef.current.playbackRate = next;
        };
        const progress = dur ? Math.min(1, pos / dur) : 0;
        const fg = 'rgba(var(--center-channel-color-rgb), 0.64)';

        return h('div', {'data-humm': 'voice-post', style: {display: 'flex', flexDirection: 'column', gap: 4, maxWidth: 420}},
            h('audio', {ref: audioRef, preload: 'metadata', src: `/api/v4/files/${fileId}`}),
            h('div', {style: {display: 'flex', alignItems: 'center', gap: 10}},
                h('button', {type: 'button', 'data-humm': 'play', 'aria-label': playing ? 'Pause' : 'Abspielen', onClick: toggle,
                    style: {width: 36, height: 36, borderRadius: '50%', border: 0, flex: 'none', cursor: 'pointer',
                        background: 'var(--button-bg)', color: 'var(--button-color)', padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center'}},
                icon(playing ? 'pause' : 'play', 16)),
                h(Waveform, {peaks, progress, onSeek}),
                h('span', {'data-humm': 'time', style: {fontSize: 12, color: fg, fontVariantNumeric: 'tabular-nums', flex: 'none'}},
                    playing || pos > 0 ? fmt(pos * 1000) : fmt(dur * 1000)),
                h('button', {type: 'button', 'data-humm': 'rate', onClick: cycleRate, 'aria-label': 'Wiedergabegeschwindigkeit',
                    style: {border: `1px solid ${fg}`, borderRadius: 10, background: 'transparent', color: fg, fontSize: 11, padding: '0 6px', cursor: 'pointer', flex: 'none'}},
                `${rate}×`)),
            h(TranscriptRow, {post, fg}));
    }

    // Collapsible transcript under the player. The server writes props.hu_voice.transcript (and the same text
    // into post.message for mobile). Expanded state survives the post list re-mounting rows.
    const expandedPosts = new Set();
    function TranscriptRow({post, fg}) {
        const hv = (post.props || {}).hu_voice || {};
        const status = hv.transcript_status || (hv.transcript ? 'done' : 'none');
        const [open, setOpen] = React.useState(expandedPosts.has(post.id));
        const muted = {fontSize: 12, color: fg, fontStyle: 'italic'};
        if (status === 'pending') return h('div', {'data-humm': 'transcript-pending', style: muted}, 'Transkript wird erstellt …');
        if (status === 'failed') return h('div', {'data-humm': 'transcript-failed', style: muted}, 'Transkript nicht verfügbar');
        if (status !== 'done' || !hv.transcript) return null;
        const toggle = () => { const next = !open; if (next) expandedPosts.add(post.id); else expandedPosts.delete(post.id); setOpen(next); };
        const chevron = h('svg', {width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true,
            style: {transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease'}},
        h('path', {d: 'M6 9l6 6 6-6', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round'}));
        return h('div', {'data-humm': 'transcript'},
            h('button', {type: 'button', 'data-humm': 'transcript-toggle', 'aria-expanded': open, onClick: toggle,
                style: {display: 'inline-flex', alignItems: 'center', gap: 4, border: 0, background: 'transparent', padding: '2px 0',
                    color: fg, fontSize: 12, cursor: 'pointer'}}, chevron, 'Transkript'),
            open && h('div', {'data-humm': 'transcript-text', style: {fontSize: 14, lineHeight: '20px', whiteSpace: 'pre-wrap',
                color: 'var(--center-channel-color)', padding: '2px 0 4px 20px'}}, hv.transcript));
    }

    // Hide the core file tiles under voice posts on desktop/web. Mobile apps don't run plugin code and keep them.
    const STYLE_ID = 'humm-style';
    const CSS = [
        '.post__body:has([data-humm=voice-post]) > .post-image__columns { display: none; }',
        '.humm-mic { width: 32px; height: 32px; border: 0; border-radius: 4px; padding: 0; display: inline-flex; align-items: center; justify-content: center;',
        '  background: transparent; color: rgba(var(--center-channel-color-rgb), 0.56); cursor: pointer; touch-action: none; user-select: none; }',
        '.humm-mic:hover { background: rgba(var(--center-channel-color-rgb), 0.08); color: rgba(var(--center-channel-color-rgb), 0.72); }',
        '@keyframes humm-pulse { 0% { box-shadow: 0 0 0 0 rgba(210, 75, 78, 0.45); transform: scale(1); } 70% { box-shadow: 0 0 0 14px rgba(210, 75, 78, 0); transform: scale(1.06); } 100% { box-shadow: 0 0 0 0 rgba(210, 75, 78, 0); transform: scale(1); } }',
        '@keyframes humm-blink { 50% { opacity: 0.2; } }',
        '@keyframes humm-nudge { 0%, 100% { transform: translateX(0); } 50% { transform: translateX(-4px); } }',
        '@keyframes humm-rise { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }',
        '@media (prefers-reduced-motion: reduce) { [data-humm-anim] { animation: none !important; } }',
    ].join('\n');

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
