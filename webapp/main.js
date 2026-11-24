// hu-mm-av webapp: hold-to-record voice messages in the Mattermost composer, live transcription while
// recording, and an inline waveform player with a collapsible transcript. Plain JS, no build step.
(function () {
    'use strict';
    const PLUGIN_ID = 'de.horseup.mm-av';
    const React = window.React;
    const h = React.createElement;
    const MIME_CANDIDATES = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus'];
    const MIN_MS = 500; // shorter press = tap, show hint
    const SLIDE_PX = 60;
    const S = window.__humm = window.__humm || {events: []};
    const log = (e, x) => { S.events.push({t: Date.now(), e, ...(x || {})}); if (S.events.length > 200) S.events.shift(); console.debug('[hu-mm-av]', e, x || ''); };

    const csrf = () => (document.cookie.match(/MMCSRF=([^;]+)/) || [])[1] || '';
    async function request(url, opts = {}) {
        const res = await fetch(url, {credentials: 'include', ...opts,
            headers: {'X-Requested-With': 'XMLHttpRequest', 'X-CSRF-Token': csrf(), ...(opts.headers || {})}});
        if (!res.ok) throw new Error(`${url.split('?')[0]} ${res.status} ${await res.text()}`);
        return res.json();
    }
    const api = (path, opts) => request('/api/v4' + path, opts);
    const pluginApi = (path, opts) => request(`/plugins/${PLUGIN_ID}${path}`, opts);
    let configPromise = null;
    const pluginConfig = () => (configPromise = configPromise || pluginApi('/api/v1/config').catch((e) => { configPromise = null; log('config.error', {message: String(e)}); return {transcription: false}; }));
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

    // ---- Live transcription --------------------------------------------------------------------------
    // Raw PCM from an AudioWorklet is resampled to 16 kHz and cut into chunks at pauses (3–15 s). Each chunk
    // goes to the plugin server right away, which transcribes it with Voxtral and keeps the text, so the
    // transcript is ready when the message is sent. Silent chunks are never sent (models invent text on silence).
    const STT_RATE = 16000;
    const FRAME = 320; // 20 ms at 16 kHz
    // Cut at the first pause once a chunk has some length: 200 ms after 3 s, 120 ms after 8 s, always at 15 s.
    // Text then shows up a few seconds behind the speaker instead of only at the end.
    const MIN_CHUNK_S = 3;
    const LONG_CHUNK_S = 8;
    const MAX_CHUNK_S = 15;
    const randomId = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');

    function wavFromPcm16k(pcm) {
        const out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
        const str = (o, s) => [...s].forEach((c, i) => out.setUint8(o + i, c.charCodeAt(0)));
        str(0, 'RIFF'); out.setUint32(4, 36 + pcm.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
        out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
        out.setUint32(24, STT_RATE, true); out.setUint32(28, STT_RATE * 2, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true);
        str(36, 'data'); out.setUint32(40, pcm.length * 2, true);
        for (let i = 0; i < pcm.length; i++) out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i])) * 0x7fff, true);
        return new Blob([out], {type: 'audio/wav'});
    }

    class LiveTranscriber {
        constructor(channelId, onUpdate) {
            this.channelId = channelId; this.onUpdate = onUpdate; this.session = randomId();
            this.seq = 0; this.texts = []; this.inflight = new Set(); this.abort = new AbortController();
            this.parts = []; this.len = 0; this.frame = new Float32Array(FRAME); this.frameN = 0;
            this.silentMs = 0; this.voicedFrames = 0; this.noise = 0.001; this.pos = 0; this.ended = false; this.zcr = [];
        }

        async attach(ctx, node) {
            await ctx.audioWorklet.addModule(`/plugins/${PLUGIN_ID}/public/pcm-tap.js`);
            const tap = new AudioWorkletNode(ctx, 'hu-pcm-tap');
            const mute = ctx.createGain(); mute.gain.value = 0; // keeps the tap in the rendered graph, silently
            node.connect(tap); tap.connect(mute); mute.connect(ctx.destination);
            const ratio = ctx.sampleRate / STT_RATE;
            tap.port.onmessage = (e) => this.push(e.data, ratio);
        }

        // Box-filter resample to 16 kHz, then voice-activity bookkeeping per 20 ms frame.
        push(block, ratio) {
            if (this.ended) return;
            const out = [];
            for (; this.pos < block.length; this.pos += ratio) {
                const a = Math.floor(this.pos); const b = Math.min(block.length, Math.max(a + 1, Math.floor(this.pos + ratio)));
                let s = 0; for (let i = a; i < b; i++) s += block[i];
                out.push(s / (b - a));
            }
            this.pos -= block.length;
            for (const v of out) {
                this.frame[this.frameN++] = v;
                if (this.frameN === FRAME) { this.onFrame(this.frame.slice(0)); this.frameN = 0; }
            }
        }

        onFrame(f) {
            let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i];
            const rms = Math.sqrt(s / f.length);
            // Noise floor follows silent frames and only creeps up during speech (capped), so long or quiet
            // speech is not mistaken for silence.
            const silent = rms < Math.max(0.0015, this.noise * 2.5);
            this.noise = silent ? this.noise * 0.95 + rms * 0.05 : Math.min(0.01, this.noise * 1.0005);
            this.silentMs = silent ? this.silentMs + 20 : 0;
            if (!silent) {
                this.voicedFrames++;
                let z = 0; for (let i = 1; i < f.length; i++) if ((f[i] < 0) !== (f[i - 1] < 0)) z++;
                this.zcr.push(z / f.length);
            }
            this.parts.push(f); this.len += f.length;
            const secs = this.len / STT_RATE;
            const pauseMs = secs < LONG_CHUNK_S ? 200 : 120;
            if ((secs >= MIN_CHUNK_S && this.silentMs >= pauseMs) || secs >= MAX_CHUNK_S) this.cut();
        }

        cut() {
            const voiced = this.voicedFrames; const parts = this.parts; const secs = this.len / STT_RATE; const zcr = this.zcr;
            this.parts = []; this.len = 0; this.voicedFrames = 0; this.zcr = [];
            // Speech changes its zero-crossing rate constantly (std >= 0.13 in tests); a steady tone or beep does not
            // (0.0015). The model invents sentences for tones, so such chunks are never sent. Under 200 ms of sound
            // is not worth transcribing either.
            const mean = zcr.reduce((a, b) => a + b, 0) / (zcr.length || 1);
            const zcrStd = Math.sqrt(zcr.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (zcr.length || 1));
            const tonal = voiced >= 10 && zcrStd < 0.04;
            const sent = voiced >= 10 && !tonal;
            log('stt.cut', {secs: Math.round(secs * 10) / 10, voiced, zcrStd: Math.round(zcrStd * 1000) / 1000, tonal, sent, seq: sent ? this.seq : null});
            if (!sent) return;
            const pcm = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
            let o = 0; for (const p of parts) { pcm.set(p, o); o += p.length; }
            this.send(this.seq++, wavFromPcm16k(pcm));
        }

        send(seq, wav, attempt = 1) {
            this.texts[seq] = undefined;
            const url = `/plugins/${PLUGIN_ID}/api/v1/stt/chunk?channel_id=${this.channelId}&session=${this.session}&seq=${seq}`;
            const p = request(url, {method: 'POST', body: wav, headers: {'Content-Type': 'audio/wav'}, signal: this.abort.signal})
                .then((res) => { this.texts[seq] = res.text || ''; })
                .catch((e) => {
                    if (this.abort.signal.aborted) return;
                    if (attempt < 2) { this.inflight.delete(p); this.send(seq, wav, attempt + 1); return; }
                    this.texts[seq] = null; log('stt.error', {seq, message: String(e)});
                })
                .finally(() => { this.inflight.delete(p); this.onUpdate(this.text()); });
            this.inflight.add(p);
            this.onUpdate(this.text());
        }

        text() {
            const parts = this.texts.filter((t) => t);
            return {text: parts.join(' '), pending: this.inflight.size > 0};
        }

        // Called when recording stops: the remaining audio becomes the last chunk.
        end() { if (!this.ended) { this.ended = true; this.cut(); } }

        async finish(timeoutMs = 15000) {
            this.end();
            const deadline = Date.now() + timeoutMs;
            while (this.inflight.size && Date.now() < deadline) {
                await Promise.race([Promise.allSettled([...this.inflight]), new Promise((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
            }
            return {session: this.session, chunks: this.seq};
        }

        cancel() { this.ended = true; this.abort.abort(); }
    }

    async function startRecording(channelId, onText) {
        const source = await openSource();
        const analyser = source.ctx.createAnalyser(); analyser.fftSize = 1024;
        source.node.connect(analyser);
        const frame = new Float32Array(analyser.fftSize);
        // Level for the live bars, scaled to the recent peak so quiet microphones still show movement.
        let peak = 0.02;
        const level = () => {
            analyser.getFloatTimeDomainData(frame); let s = 0; for (let i = 0; i < frame.length; i++) s += frame[i] * frame[i];
            const rms = Math.sqrt(s / frame.length);
            peak = Math.max(rms, peak * 0.997, 0.005);
            return Math.min(1, rms / peak);
        };
        const cfg = await pluginConfig();
        const maxMs = (cfg.max_duration_sec || 300) * 1000;
        let live = null;
        if (cfg.transcription) {
            live = new LiveTranscriber(channelId, onText);
            try { await live.attach(source.ctx, source.node); } catch (e) { log('stt.attach.error', {message: String(e)}); live = null; }
        }
        const mime = MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) || '';
        const recorder = new MediaRecorder(source.stream, {mimeType: mime, audioBitsPerSecond: 64000});
        const chunks = [];
        recorder.ondataavailable = (ev) => ev.data.size && chunks.push(ev.data);
        const stopped = new Promise((resolve) => { recorder.onstop = () => resolve(new Blob(chunks, {type: recorder.mimeType})); });
        recorder.start(250);
        const startedAt = performance.now();
        log('rec.start', {mime: recorder.mimeType, live: !!live});
        return {mime: recorder.mimeType, startedAt, level, live, maxMs,
            stop: async () => {
                if (recorder.state !== 'inactive') recorder.stop();
                const blob = await toRegularMp4(await stopped);
                if (live) live.end();
                source.close();
                return {blob, ms: performance.now() - startedAt};
            }};
    }

    // mp4:start
    // Chromium's MediaRecorder writes fragmented MP4: a header without the total length, then one
    // moof/mdat pair per 250 ms. Players that trust the header get the length wrong; on Android the
    // Mattermost app shows 0:00 and the progress bar jumps to the end. defragmentMp4 rewrites the file
    // as a regular MP4 (ftyp, moov with one sample table and the real duration, mdat). The audio
    // bytes are copied unchanged. Returns null when the input has no fragments, and throws on
    // anything it does not understand, so the caller can keep the original.
    function defragmentMp4(input) {
        // A plain Uint8Array view, so slice() copies (a Node Buffer's slice() shares memory).
        const u8 = ArrayBuffer.isView(input) ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength) : new Uint8Array(input);
        const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
        const fail = (why) => { throw new Error('mp4: ' + why); };
        const boxes = (start, end) => {
            const out = [];
            for (let o = start; o < end;) {
                if (o + 8 > end) fail('truncated box header at ' + o);
                let size = dv.getUint32(o), hdr = 8;
                if (size === 1) { size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = end - o;
                if (size < hdr || o + size > end) fail('bad box size at ' + o);
                out.push({type: String.fromCharCode(...u8.subarray(o + 4, o + 8)), start: o, body: o + hdr, end: o + size});
                o += size;
            }
            return out;
        };
        const children = (b, type) => boxes(b.body, b.end).filter((c) => c.type === type);
        const child = (b, type) => children(b, type)[0] || fail('missing ' + type);
        const raw = (b) => u8.subarray(b.start, b.end);
        const flags = (b) => dv.getUint32(b.body) & 0xffffff;
        const v1 = (b) => u8[b.body] === 1;

        const top = boxes(0, u8.length);
        const moofs = top.filter((b) => b.type === 'moof');
        const moov = top.find((b) => b.type === 'moov');
        if (!moofs.length) return null;
        if (!moov) fail('missing moov');
        const traks = children(moov, 'trak');
        if (traks.length !== 1) fail('expected one track, got ' + traks.length);
        const trackId = dv.getUint32(child(traks[0], 'tkhd').body + (v1(child(traks[0], 'tkhd')) ? 20 : 12));
        const trex = boxes(moov.body, moov.end).filter((b) => b.type === 'mvex').flatMap((m) => children(m, 'trex'))
            .find((t) => dv.getUint32(t.body + 4) === trackId);
        const trexDur = trex ? dv.getUint32(trex.body + 12) : 0;
        const trexSize = trex ? dv.getUint32(trex.body + 16) : 0;

        // Collect every sample's duration, size and byte range from the fragments (ISO 14496-12 tfhd/trun).
        const durations = [], sizes = [], ranges = [];
        let clock = 0; // media time reached so far
        for (const moof of moofs) {
            for (const traf of children(moof, 'traf')) {
                const tfhd = child(traf, 'tfhd');
                if (dv.getUint32(tfhd.body + 4) !== trackId) fail('fragment for another track');
                const tfdt = children(traf, 'tfdt')[0];
                if (tfdt) { // Chromium leaves small gaps between fragments; keep its timeline, as ffmpeg -c copy does
                    const at = v1(tfdt) ? Number(dv.getBigUint64(tfdt.body + 4)) : dv.getUint32(tfdt.body + 4);
                    if (durations.length && at > clock) durations[durations.length - 1] += at - clock;
                    clock = Math.max(clock, at);
                }
                const tf = flags(tfhd);
                let p = tfhd.body + 8, base = moof.start, defDur = trexDur, defSize = trexSize;
                if (tf & 0x1) { base = Number(dv.getBigUint64(p)); p += 8; }
                if (tf & 0x2) p += 4;
                if (tf & 0x8) { defDur = dv.getUint32(p); p += 4; }
                if (tf & 0x10) { defSize = dv.getUint32(p); p += 4; }
                let pos = base;
                for (const trun of children(traf, 'trun')) {
                    const rf = flags(trun), n = dv.getUint32(trun.body + 4);
                    let q = trun.body + 8;
                    if (rf & 0x1) { pos = base + dv.getInt32(q); q += 4; }
                    if (rf & 0x4) q += 4;
                    const start = pos;
                    for (let i = 0; i < n; i++) {
                        let d = defDur, s = defSize;
                        if (rf & 0x100) { d = dv.getUint32(q); q += 4; }
                        if (rf & 0x200) { s = dv.getUint32(q); q += 4; }
                        if (rf & 0x400) q += 4;
                        if (rf & 0x800) q += 4;
                        durations.push(d); sizes.push(s); pos += s; clock += d;
                    }
                    if (q > trun.end) fail('trun shorter than its sample count');
                    if (start < 0 || pos > u8.length) fail('sample data outside the file');
                    if (pos > start) ranges.push([start, pos]);
                }
            }
        }
        if (!sizes.length || durations.some((d) => !d)) fail('no samples or a sample without duration');

        const word = (out, at, value) => new DataView(out.buffer, out.byteOffset).setUint32(at, value);
        const ascii = (s) => Uint8Array.from(s, (c) => c.charCodeAt(0));
        const join = (parts) => {
            const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
            parts.reduce((at, x) => { out.set(x, at); return at + x.length; }, 0);
            return out;
        };
        const box = (type, parts) => { const head = new Uint8Array(8); head.set(ascii(type), 4); const out = join([head, ...parts]); word(out, 0, out.length); return out; };
        const table = (type, values) => { // full box, version 0, flags 0, 32-bit fields
            const out = new Uint8Array(12 + values.length * 4);
            word(out, 0, out.length); out.set(ascii(type), 4);
            values.forEach((v, i) => word(out, 12 + i * 4, v));
            return out;
        };
        const withDuration = (b, at0, at1, value) => { // copy of a mvhd/tkhd/mdhd with its duration set
            const out = u8.slice(b.start, b.end), at = b.body - b.start + (v1(b) ? at1 : at0);
            const w = new DataView(out.buffer, out.byteOffset, out.byteLength);
            if (v1(b)) w.setBigUint64(at, BigInt(value)); else w.setUint32(at, value);
            return out;
        };
        const timescale = (b) => dv.getUint32(b.body + (v1(b) ? 20 : 12));

        const mvhd = child(moov, 'mvhd'), mdhd = child(child(traks[0], 'mdia'), 'mdhd');
        const mediaDur = durations.reduce((a, b) => a + b, 0);
        const movieDur = Math.round(mediaDur * timescale(mvhd) / timescale(mdhd));
        const stts = [];
        for (const d of durations) {
            if (stts.length && stts[stts.length - 1] === d) stts[stts.length - 2]++; else stts.push(1, d);
        }
        const rebuild = (b, fn) => box(b.type, boxes(b.body, b.end).map(fn).filter(Boolean));
        const buildMoov = (dataOffset) => rebuild(moov, (b) => {
            if (b.type === 'mvex') return null;
            if (b.type === 'mvhd') return withDuration(b, 16, 24, movieDur);
            if (b.type !== 'trak') return raw(b);
            return rebuild(b, (t) => {
                if (t.type === 'tkhd') return withDuration(t, 20, 28, movieDur);
                if (t.type === 'edts') return null; // fragment-style edit lists do not carry over
                if (t.type !== 'mdia') return raw(t);
                return rebuild(t, (m) => {
                    if (m.type === 'mdhd') return withDuration(m, 16, 24, mediaDur);
                    if (m.type !== 'minf') return raw(m);
                    return rebuild(m, (i) => i.type !== 'stbl' ? raw(i) : box('stbl', [raw(child(i, 'stsd')),
                        table('stts', [stts.length / 2, ...stts]),
                        table('stsc', [1, 1, sizes.length, 1]), // one chunk holds every sample
                        table('stsz', [0, sizes.length, ...sizes]),
                        table('stco', [1, dataOffset])]));
                });
            });
        });
        const ftyp = box('ftyp', [ascii('M4A '), new Uint8Array(4), ascii('M4A isomiso2mp42')]);
        const header = ftyp.length + buildMoov(0).length + 8;
        const moovOut = buildMoov(header);
        const total = sizes.reduce((a, b) => a + b, 0);
        if (header + total > 0xffffffff) fail('too large');
        return join([ftyp, moovOut, box('mdat', ranges.map(([s, e]) => u8.subarray(s, e)))]);
    }
    // mp4:end

    async function toRegularMp4(blob) {
        if (!/^audio\/mp4/.test(blob.type)) return blob;
        try {
            const out = defragmentMp4(await blob.arrayBuffer());
            if (out) log('mp4.defragmented', {from: blob.size, to: out.length});
            return out ? new Blob([out], {type: blob.type}) : blob;
        } catch (e) {
            log('mp4.error', {message: String(e)});
            return blob;
        }
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

    // Upload the audio as the user (normal files API), wait for the live transcript, then let the server
    // create the post with the transcript already in it.
    async function sendVoice(blob, ms, mime, draft, live) {
        const t0 = performance.now();
        let peaks = [];
        try {
            const decoded = await decodeAudio(await blob.arrayBuffer());
            peaks = computePeaks(decoded);
            if (decoded.duration > 0) ms = decoded.duration * 1000; // the audio's real length, not the wall clock
        } catch (e) { log('peaks.error', {message: String(e)}); }
        const fd = new FormData();
        fd.append('channel_id', draft.channelId);
        fd.append('files', new File([blob], `voice-${Date.now()}.${mime.includes('webm') ? 'webm' : 'm4a'}`, {type: mime.split(';')[0]}));
        const [up, stt] = await Promise.all([api('/files', {method: 'POST', body: fd}), live ? live.finish() : Promise.resolve({session: '', chunks: 0})]);
        const res = await pluginApi('/api/v1/voice', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({
            channel_id: draft.channelId, root_id: draft.rootId || '', file_id: up.file_infos[0].id,
            duration_ms: Math.round(ms), peaks, session: stt.session, chunks: stt.chunks})});
        S.last = {postId: res.post_id, transcript: res.transcript_status, chunks: stt.chunks, bytes: blob.size, ms, sendMs: Math.round(performance.now() - t0)};
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
        send: {fill: 'M3.5 20.2L21.6 12 3.5 3.8l.02 6.5L15.5 12 3.52 13.7z'}, // paper plane pointing right, as in Mattermost's own send button
        stop: {fill: 'M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3z'},
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
    // Use Mattermost's own send icon (read from its composer), so ours always matches the host version.
    let hostSendPath = null;
    const sendIcon = () => {
        if (!hostSendPath) {
            const path = document.querySelector('[data-testid="SendMessageButton"] svg path');
            if (path) hostSendPath = path.getAttribute('d');
        }
        return hostSendPath ? h('svg', {width: 18, height: 18, viewBox: '0 0 24 24', 'aria-hidden': true, style: {display: 'block'}}, h('path', {d: hostSendPath, fill: 'currentColor'})) : icon('send', 18);
    };
    // Same shape as Mattermost's send button (48 × 32, 4 px corners).
    const actionBtn = (bg, color) => ({width: 48, height: 32, borderRadius: 4, border: 0, padding: 0, flex: 'none',
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', background: bg, color});

    const IS_MAC = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
    const MOD = IS_MAC ? '⌘' : 'Ctrl';
    const SHORTCUTS = {cancel: ['Esc'], stop: [MOD, 'S'], send: ['Enter'], record: IS_MAC ? ['⌥', '⇧', 'V'] : ['Alt', 'Shift', 'V']};
    // Hold-to-record: Option/Alt + Shift + V ("V for voice"). Neither Mattermost nor the Calls plugin uses it.
    // e.code is used because Option changes e.key on macOS ("◊").
    const isRecordCombo = (e) => e.code === 'KeyV' && e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey;
    // Only one recorder (channel or thread composer) may be active at a time.
    let activeOwner = null;
    const kbd = (k) => h('span', {key: k, style: {display: 'inline-block', minWidth: 16, padding: '0 4px', marginLeft: 4, borderRadius: 3, textAlign: 'center',
        background: 'rgba(255, 255, 255, 0.16)', fontSize: 11, lineHeight: '16px'}}, k);
    // Hover/focus tooltip in Mattermost's style: label plus shortcut keys.
    function WithTooltip({label, keys, children, disabled}) {
        const [rect, setRect] = React.useState(null);
        React.useEffect(() => { if (disabled) setRect(null); }, [disabled]);
        const show = (e) => { if (!disabled) setRect(e.currentTarget.getBoundingClientRect()); };
        const hide = () => setRect(null);
        return h('span', {onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide, onClick: hide, onPointerDown: hide, style: {display: 'inline-flex', flex: 'none'}},
            children,
            rect && window.ReactDOM.createPortal(h('div', {role: 'tooltip', 'data-humm': 'tooltip', style: {position: 'fixed', zIndex: 1002, pointerEvents: 'none',
                left: rect.left + rect.width / 2, top: rect.top - 8, transform: 'translate(-50%, -100%)', whiteSpace: 'nowrap',
                display: 'flex', alignItems: 'center', padding: '4px 8px', borderRadius: 4, fontSize: 12, lineHeight: '16px',
                background: 'rgba(0, 0, 0, 0.88)', color: '#fff', boxShadow: '0 2px 6px rgba(0, 0, 0, 0.16)'}}, label, ...(keys || []).map(kbd)), document.body));
    }

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
        const [live, setLive] = React.useState({text: '', pending: false});
        const [liveEnabled, setLiveEnabled] = React.useState(false);
        const [sendError, setSendError] = React.useState(false);
        const autoStopRef = React.useRef(null);
        const idRef = React.useRef(randomId());
        const viaRef = React.useRef('pointer'); // how the current recording was started: 'pointer' or 'key'
        const [via, setVia] = React.useState('pointer');
        const keyDownAtRef = React.useRef(null);
        const handlersRef = React.useRef({});
        const modeRef = React.useRef('idle');
        const recRef = React.useRef(null);
        const originRef = React.useRef(null);
        const previewRef = React.useRef(null);
        const setMode = (m) => {
            modeRef.current = m; setModeState(m); log('mode', {m});
            if (['idle', 'hint', 'error'].includes(m)) { if (activeOwner === idRef.current) activeOwner = null; } else activeOwner = idRef.current;
        };
        React.useEffect(() => () => { if (activeOwner === idRef.current) activeOwner = null; }, []);
        const flash = (m) => { setMode(m); setTimeout(() => modeRef.current === m && setMode('idle'), 1800); };
        const resetLive = () => { setLive({text: '', pending: false}); setLiveEnabled(false); };
        const active = mode !== 'idle';
        const editorEl = btnEl && btnEl.closest('.AdvancedTextEditor__body');
        const editorRect = useRect(editorEl, active && mode !== 'hint');
        const micRect = useRect(btnEl, active);

        // Timer and level bars while recording.
        React.useEffect(() => {
            if (mode !== 'recording' && mode !== 'cancel' && mode !== 'locked') return undefined;
            let raf = 0; let rec = null; let frameNo = 0; let limitHit = false; const hist = [];
            if (recRef.current) recRef.current.then((r) => { rec = r; }).catch(() => {});
            const tick = () => {
                if (rec && frameNo++ % 3 === 0) {
                    hist.push(rec.level()); if (hist.length > 320) hist.shift();
                    const ms = performance.now() - rec.startedAt;
                    setLevels(hist.slice()); setElapsed(ms);
                    // At the maximum length, stop into listen-back instead of losing the recording.
                    if (!limitHit && ms >= rec.maxMs) { limitHit = true; log('rec.limit', {ms: Math.round(ms)}); autoStopRef.current(); return; }
                }
                raf = requestAnimationFrame(tick);
            };
            raf = requestAnimationFrame(tick);
            return () => cancelAnimationFrame(raf);
        }, [mode]);

        const discard = async () => {
            const p = recRef.current; recRef.current = null; setMode('idle'); setLevels([]); resetLive();
            const r = p && await p.catch(() => null);
            if (r) { if (r.live) r.live.cancel(); await r.stop(); }
        };
        const send = async (blob, ms, mime, liveT, peaks) => {
            setMode('sending'); setSendError(false);
            try {
                await sendVoice(blob, ms, mime, props.draft, liveT);
                setMode('idle'); resetLive();
            } catch (e) {
                log('send.error', {message: String(e)});
                previewRef.current = {blob, ms, mime, live: liveT, peaks: peaks || null, url: URL.createObjectURL(blob)};
                setSendError(true); setMode('preview');
            }
        };
        const stopAndSend = async () => {
            const r = await recRef.current; recRef.current = null;
            const {blob, ms} = await r.stop();
            setLevels([]);
            if (ms < MIN_MS) { if (r.live) r.live.cancel(); resetLive(); flash('hint'); return; }
            await send(blob, ms, r.mime, r.live);
        };
        const stopToPreview = async () => {
            const r = await recRef.current; recRef.current = null;
            const res = await r.stop();
            let peaks = null;
            try { peaks = computePeaks(await decodeAudio(await res.blob.arrayBuffer())); } catch (e) { log('peaks.error', {message: String(e)}); }
            previewRef.current = {...res, mime: r.mime, url: URL.createObjectURL(res.blob), peaks, live: r.live};
            setLevels([]); setMode('preview');
        };
        autoStopRef.current = stopToPreview;
        const sendPreview = async () => { const p = previewRef.current; previewRef.current = null; URL.revokeObjectURL(p.url); await send(p.blob, p.ms, p.mime, p.live, p.peaks); };
        const discardPreview = () => { const p = previewRef.current; if (p) { URL.revokeObjectURL(p.url); if (p.live) p.live.cancel(); } previewRef.current = null; resetLive(); setSendError(false); setMode('idle'); };

        // Esc cancels, Enter sends, while locked or previewing.
        React.useEffect(() => {
            if (mode !== 'locked' && mode !== 'preview') return undefined;
            const onKey = (e) => {
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (mode === 'locked') discard(); else discardPreview(); }
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); if (mode === 'locked') stopAndSend(); else sendPreview(); }
                if (mode === 'locked' && (e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); stopToPreview(); }
            };
            window.addEventListener('keydown', onKey, true);
            return () => window.removeEventListener('keydown', onKey, true);
        }, [mode]);

        const begin = (how) => {
            viaRef.current = how; setVia(how);
            recRef.current = startRecording(props.draft.channelId, setLive);
            recRef.current.then((r) => setLiveEnabled(!!r.live), (err) => { log('rec.error', {message: String(err)}); recRef.current = null; setMode('idle'); });
            setElapsed(0); setLevels([]);
            setMode('recording');
        };
        const onPointerDown = (e) => {
            if (!['idle', 'hint', 'error'].includes(modeRef.current) || (activeOwner && activeOwner !== idRef.current)) return;
            e.preventDefault();
            try { e.currentTarget.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
            originRef.current = {x: e.clientX, y: e.clientY};
            begin('pointer');
        };

        // Keyboard: hold ⌥⇧V to record and release to send. A short tap (< 0.5 s) starts a hands-free (locked)
        // recording; tapping again or Enter sends, Esc cancels. Leaving the window while holding locks instead of
        // sending. The composer with focus gets the recording; with none focused, the channel composer does.
        handlersRef.current = {begin, discard, stopAndSend, sendPreview};
        React.useEffect(() => {
            if (!btnEl) return undefined;
            const owns = () => {
                if (activeOwner) return activeOwner === idRef.current;
                const mine = btnEl.closest('.AdvancedTextEditor__body');
                const el = document.activeElement;
                const focused = el && el.closest ? el.closest('.AdvancedTextEditor__body') : null;
                return focused ? focused === mine : !!btnEl.closest('#post-create');
            };
            const holdingByKey = () => viaRef.current === 'key' && modeRef.current === 'recording' && keyDownAtRef.current !== null;
            const onDown = (e) => {
                if (e.key === 'Escape' && holdingByKey() && owns()) {
                    e.preventDefault(); e.stopPropagation(); keyDownAtRef.current = null; handlersRef.current.discard(); return;
                }
                if (!isRecordCombo(e) || !owns()) return;
                e.preventDefault(); e.stopPropagation(); // also keeps "◊" out of the message box
                if (e.repeat) return;
                const m = modeRef.current;
                if (['idle', 'hint', 'error'].includes(m)) { keyDownAtRef.current = performance.now(); handlersRef.current.begin('key'); } else if (m === 'locked') handlersRef.current.stopAndSend(); else if (m === 'preview') handlersRef.current.sendPreview();
            };
            const onUp = (e) => {
                if (!holdingByKey() || !(e.code === 'KeyV' || e.key === 'Alt' || e.key === 'Shift')) return;
                e.preventDefault();
                const held = performance.now() - keyDownAtRef.current;
                keyDownAtRef.current = null;
                if (held < MIN_MS) setMode('locked'); else handlersRef.current.stopAndSend();
            };
            const onBlur = () => { if (holdingByKey()) { keyDownAtRef.current = null; setMode('locked'); } };
            window.addEventListener('keydown', onDown, true);
            window.addEventListener('keyup', onUp, true);
            window.addEventListener('blur', onBlur);
            return () => { window.removeEventListener('keydown', onDown, true); window.removeEventListener('keyup', onUp, true); window.removeEventListener('blur', onBlur); };
        }, [btnEl]);
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
        if (mode === 'recording' && via === 'key') {
            bar = [h(Timer, {key: 't', ms: elapsed, blink: true}),
                h('span', {key: 'c', 'data-humm': 'key-hint', style: {flex: 'none', fontSize: 13, color: muted}}, 'Loslassen: senden · Esc: abbrechen'),
                h(LevelBars, {key: 'l', levels, color: RED})];
        } else if (mode === 'recording') {
            bar = [h(Timer, {key: 't', ms: elapsed, blink: true}),
                h('span', {key: 'c', 'data-humm': 'slide-hint', style: {display: 'inline-flex', alignItems: 'center', gap: 2, flex: 'none', fontSize: 13, color: muted}},
                    h('span', {'data-humm-anim': 'nudge', style: {animation: 'humm-nudge 1.2s ease-in-out infinite'}}, icon('chevL', 16)), 'Nach links: abbrechen'),
                h(LevelBars, {key: 'l', levels, color: RED})];
        } else if (mode === 'cancel') {
            bar = [h('span', {key: 'c', style: {display: 'inline-flex', alignItems: 'center', gap: 8, color: RED, fontSize: 14, fontWeight: 600}}, icon('trash', 18), 'Loslassen zum Verwerfen'),
                h('span', {key: 's', style: {flex: 1}}), h(Timer, {key: 't', ms: elapsed, blink: false})];
        } else if (mode === 'locked') {
            bar = [h(WithTooltip, {key: 'x', label: 'Verwerfen', keys: SHORTCUTS.cancel}, h('button', {type: 'button', 'data-humm': 'cancel', 'aria-label': 'Aufnahme verwerfen', 'aria-keyshortcuts': 'Escape', onClick: discard, style: circleBtn('rgba(var(--center-channel-color-rgb), 0.08)', 'var(--center-channel-color)')}, icon('x', 16))),
                h(Timer, {key: 't', ms: elapsed, blink: true}), h(LevelBars, {key: 'l', levels, color: RED}),
                h(WithTooltip, {key: 'p', label: 'Stoppen & anhören', keys: SHORTCUTS.stop}, h('button', {type: 'button', 'data-humm': 'listen', 'aria-label': 'Stoppen und anhören', 'aria-keyshortcuts': IS_MAC ? 'Meta+S' : 'Control+S', onClick: stopToPreview, style: actionBtn('rgba(210, 75, 78, 0.12)', RED)}, icon('stop', 26))),
                h(WithTooltip, {key: 's', label: 'Senden', keys: SHORTCUTS.send}, h('button', {type: 'button', 'data-humm': 'send', 'aria-label': 'Senden', 'aria-keyshortcuts': 'Enter', onClick: stopAndSend, style: actionBtn('var(--button-bg)', 'var(--button-color)')}, sendIcon()))];
        } else if (mode === 'preview') {
            bar = [h(WithTooltip, {key: 'x', label: 'Verwerfen', keys: SHORTCUTS.cancel}, h('button', {type: 'button', 'data-humm': 'cancel', 'aria-label': 'Aufnahme verwerfen', 'aria-keyshortcuts': 'Escape', onClick: discardPreview, style: circleBtn('rgba(var(--center-channel-color-rgb), 0.08)', 'var(--center-channel-color)')}, icon('x', 16))),
                h(PreviewPlayer, {key: 'pp', url: previewRef.current.url, ms: previewRef.current.ms, peaks: previewRef.current.peaks}),
                h(WithTooltip, {key: 's', label: 'Senden', keys: SHORTCUTS.send}, h('button', {type: 'button', 'data-humm': 'send', 'aria-label': 'Senden', 'aria-keyshortcuts': 'Enter', onClick: sendPreview, style: actionBtn('var(--button-bg)', 'var(--button-color)')}, sendIcon()))];
        }

        const overlays = [];
        // While holding, the red mic orb sits over the button (mid-bar, not at the edge), so content stops left of it.
        const holding = mode === 'recording' || mode === 'cancel';
        const orbPad = holding && micRect && editorRect ? Math.max(12, Math.round(editorRect.left + editorRect.width - (micRect.left + micRect.width / 2 - 36))) : 12;
        if (bar && editorRect) {
            // Live transcript above the controls; newest words at the bottom, older lines scroll out at the top.
            const showText = liveEnabled && (mode === 'recording' || mode === 'locked' || mode === 'preview');
            const textHeight = editorRect.height >= 86 ? 36 : 18;
            let placeholder = 'Transkript erscheint beim Sprechen …';
            if (live.pending && !live.text) placeholder = 'Wird transkribiert …';
            else if (mode === 'preview' && !live.text) placeholder = 'Kein Transkript';
            const showError = sendError && mode === 'preview';
            const textRow = showError ? h('div', {key: 'err', 'data-humm': 'send-error', role: 'alert', style: {height: textHeight, display: 'flex', alignItems: 'flex-end', fontSize: 13, lineHeight: '18px', color: RED}},
                'Senden fehlgeschlagen. Die Aufnahme ist noch da: Enter versucht es erneut.') : showText && h('div', {key: 'txt', 'data-humm': 'live-text', 'aria-live': 'polite', style: {height: textHeight, overflow: 'hidden', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end',
                fontSize: 13, lineHeight: '18px', color: live.text ? 'var(--center-channel-color)' : muted, fontStyle: live.text ? 'normal' : 'italic'}},
            h('div', null, live.text || placeholder, live.text && live.pending ? h('span', {style: {color: muted}}, ' …') : null));
            overlays.push(h('div', {key: 'bar', 'data-humm': 'recorder', 'data-humm-mode-bar': mode, style: {position: 'fixed', zIndex: 1000,
                left: editorRect.left, top: editorRect.top, width: editorRect.width, height: editorRect.height, boxSizing: 'border-box',
                display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 4, padding: `6px ${orbPad}px 6px 12px`, borderRadius: 4,
                background: 'var(--center-channel-bg)', border: '1px solid rgba(var(--center-channel-color-rgb), 0.16)',
                boxShadow: '0 2px 6px rgba(0, 0, 0, 0.08)', pointerEvents: mode === 'locked' || mode === 'preview' ? 'auto' : 'none'}},
            textRow, h('div', {key: 'ctl', style: {display: 'flex', alignItems: 'center', gap: 12, minWidth: 0}}, bar)));
        }
        if ((mode === 'recording' || mode === 'cancel') && micRect) {
            const cx = micRect.left + micRect.width / 2; const cy = micRect.top + micRect.height / 2;
            overlays.push(h('div', {key: 'orb', 'data-humm-anim': 'pulse', style: {position: 'fixed', zIndex: 1001, pointerEvents: 'none', left: cx - 24, top: cy - 24, width: 48, height: 48, borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', background: mode === 'cancel' ? 'rgba(var(--center-channel-color-rgb), 0.48)' : RED,
                animation: mode === 'recording' ? 'humm-pulse 1.4s ease-out infinite' : 'none'}}, icon(mode === 'cancel' ? 'trash' : 'mic', 22)));
            if (mode === 'recording' && via === 'pointer') {
                overlays.push(h('div', {key: 'lock', 'data-humm': 'lock-hint', style: {position: 'fixed', zIndex: 1001, pointerEvents: 'none', left: cx - 18, top: cy - 24 - 76, width: 36, height: 68, borderRadius: 18,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-around', padding: '6px 0', boxSizing: 'border-box',
                    background: 'var(--center-channel-bg)', color: muted, border: '1px solid rgba(var(--center-channel-color-rgb), 0.16)', boxShadow: '0 2px 6px rgba(0, 0, 0, 0.12)'}},
                icon('lock', 16), h('span', {'data-humm-anim': 'rise', style: {animation: 'humm-rise 1.2s ease-in-out infinite'}}, icon('chevU', 16))));
            }
        }
        if ((mode === 'hint' || mode === 'error') && micRect) {
            overlays.push(h('div', {key: 'hint', 'data-humm': 'hold-hint', style: {position: 'fixed', zIndex: 1001, pointerEvents: 'none', left: micRect.left + micRect.width / 2, top: micRect.top - 8,
                transform: 'translate(-50%, -100%)', whiteSpace: 'nowrap', fontSize: 12, padding: '4px 8px', borderRadius: 4,
                background: mode === 'error' ? RED : 'var(--center-channel-color)', color: mode === 'error' ? '#fff' : 'var(--center-channel-bg)'}},
            mode === 'error' ? 'Senden fehlgeschlagen' : 'Zum Aufnehmen gedrückt halten'));
        }

        const micButton = h('button', {type: 'button', ref: setBtnEl, className: 'humm-mic', 'aria-label': 'Sprachnachricht aufnehmen (gedrückt halten)', 'aria-keyshortcuts': 'Alt+Shift+V', 'data-humm': 'mic',
            disabled: mode === 'sending', onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp},
        mode === 'sending' ? h('span', {'data-humm-anim': 'spin', 'aria-label': 'Wird gesendet', style: {width: 14, height: 14, borderRadius: '50%', border: '2px solid currentColor', borderTopColor: 'transparent', animation: 'humm-spin 0.8s linear infinite'}}) : icon('mic', 18));
        return h('span', {style: {display: 'inline-flex', alignItems: 'center'}, 'data-humm-mode': mode},
            // Same element tree in every mode, so the button is never remounted mid-press.
            h(WithTooltip, {label: 'Gedrückt halten zum Aufnehmen', keys: SHORTCUTS.record, disabled: mode !== 'idle'}, micButton),
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
        if ((status !== 'done' && status !== 'partial') || !hv.transcript) return null;
        const toggle = () => { const next = !open; if (next) expandedPosts.add(post.id); else expandedPosts.delete(post.id); setOpen(next); };
        const chevron = h('svg', {width: 16, height: 16, viewBox: '0 0 24 24', 'aria-hidden': true,
            style: {transform: open ? 'rotate(180deg)' : 'none', transition: 'transform 150ms ease'}},
        h('path', {d: 'M6 9l6 6 6-6', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round'}));
        return h('div', {'data-humm': 'transcript'},
            h('button', {type: 'button', 'data-humm': 'transcript-toggle', 'aria-expanded': open, onClick: toggle,
                style: {display: 'inline-flex', alignItems: 'center', gap: 4, border: 0, background: 'transparent', padding: '2px 0',
                    color: fg, fontSize: 12, cursor: 'pointer'}}, chevron, status === 'partial' ? 'Transkript (unvollständig)' : 'Transkript'),
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
        '@keyframes humm-spin { to { transform: rotate(360deg); } }',
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
