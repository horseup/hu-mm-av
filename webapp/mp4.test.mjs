// Tests for defragmentMp4 in main.js. main.js is one plain script for the browser, so the test cuts
// the function out between its "mp4:start" and "mp4:end" markers. Run with: node --test webapp/
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const src = readFileSync(new URL('./main.js', import.meta.url), 'utf8');
const region = src.slice(src.indexOf('// mp4:start'), src.indexOf('// mp4:end'));
const defragmentMp4 = new Function(`${region}\nreturn defragmentMp4;`)();

// ---- a tiny MP4 writer and reader for building inputs and checking outputs ----
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const box = (type, ...parts) => { const body = parts.flat(Infinity); return [...u32(body.length + 8), ...ascii(type), ...body]; };
const full = (type, version, flags, ...parts) => box(type, version, ...u32(flags).slice(1), ...parts);

function parse(u8, start = 0, end = u8.length) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength), out = [];
    for (let o = start; o < end;) {
        const size = dv.getUint32(o);
        out.push({type: String.fromCharCode(...u8.subarray(o + 4, o + 8)), start: o, body: o + 8, end: o + size});
        o += size;
    }
    return out;
}
const find = (u8, b, ...path) => path.reduce((cur, t) => cur && parse(u8, cur.body, cur.end).find((c) => c.type === t), b);
const words = (u8, b, from = 4) => { const dv = new DataView(u8.buffer, u8.byteOffset); const out = []; for (let o = b.body + from; o < b.end; o += 4) out.push(dv.getUint32(o)); return out; };

const STSD = full('stsd', 0, 0, u32(1), box('mp4a', new Array(28).fill(0), box('esds', 0, 0, 0, 0, 3, 25)));
function fragmentedInput(fragments, {trexDur = 1024, trexSize = 0} = {}) {
    const moov = box('moov',
        full('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(0), new Array(80).fill(0)),
        box('trak',
            full('tkhd', 0, 3, u32(0), u32(0), u32(1), u32(0), u32(277), new Array(60).fill(0)),
            box('mdia',
                full('mdhd', 0, 0, u32(0), u32(0), u32(48000), u32(277), 0x55, 0xc4, 0, 0),
                full('hdlr', 0, 0, u32(0), ascii('soun'), new Array(12).fill(0), ascii('SoundHandler'), 0),
                box('minf', full('smhd', 0, 0, u32(0)), box('dinf', full('dref', 0, 0, u32(1), full('url ', 0, 1))),
                    box('stbl', STSD, full('stts', 0, 0, u32(0)), full('stsc', 0, 0, u32(0)), full('stsz', 0, 0, u32(0), u32(0)), full('stco', 0, 0, u32(0)))))),
        box('mvex', full('trex', 0, 0, u32(1), u32(1), u32(trexDur), u32(trexSize), u32(0))));
    const out = [...box('ftyp', ascii('isom'), u32(512), ascii('isomiso6mp41')), ...moov];
    for (const f of fragments) out.push(...f(out.length));
    return Uint8Array.from(out);
}
// Chromium's layout: tfhd flags 0x020020 (base is moof, default sample flags), trun 0x301 (data offset, duration, size).
const chromiumFragment = (samples, tfdt = 0) => () => {
    const moofLen = (rest) => box('moof', full('mfhd', 0, 0, u32(1)), box('traf', full('tfhd', 0, 0x020020, u32(1), u32(0)),
        full('tfdt', 1, 0, u32(0), u32(tfdt)), full('trun', 0, 0x301, u32(samples.length), u32(rest), samples.map((s) => [u32(s.dur), u32(s.bytes.length)]))));
    const len = moofLen(0).length;
    return [...moofLen(len + 8), ...box('mdat', samples.map((s) => s.bytes))];
};
// Another layout: defaults in tfhd, no per-sample fields, two truns, data offset only on the first.
const defaultsFragment = (count, size, dur) => () => {
    const make = (off) => box('moof', full('mfhd', 0, 0, u32(2)), box('traf', full('tfhd', 0, 0x020018, u32(1), u32(dur), u32(size)),
        full('trun', 0, 0x1, u32(count - 1), u32(off)), full('trun', 0, 0, u32(1))));
    const len = make(0).length;
    return [...make(len + 8), ...box('mdat', new Array(count * size).fill(0).map((_, i) => 100 + i % 50))];
};
const sample = (dur, n, fill) => ({dur, bytes: new Array(n).fill(fill)});

test('rewrites a Chromium-style fragmented file as a regular MP4', () => {
    const input = fragmentedInput([
        chromiumFragment([sample(1024, 5, 1), sample(1024, 7, 2), sample(1024, 3, 3)]),
        chromiumFragment([sample(1024, 4, 4), sample(512, 6, 5)], 3 * 1024),
    ]);
    const out = defragmentMp4(input);
    assert.deepEqual(parse(out).map((b) => b.type), ['ftyp', 'moov', 'mdat']);
    const [, moov, mdat] = parse(out);
    assert.equal(find(out, moov, 'mvex'), undefined);

    const media = 1024 * 4 + 512;
    const mdhd = find(out, moov, 'trak', 'mdia', 'mdhd');
    assert.deepEqual(words(out, mdhd).slice(2, 4), [48000, media]);
    assert.equal(words(out, find(out, moov, 'mvhd'))[3], Math.round(media * 1000 / 48000));
    assert.equal(words(out, find(out, moov, 'trak', 'tkhd'))[4], Math.round(media * 1000 / 48000));

    const stbl = find(out, moov, 'trak', 'mdia', 'minf', 'stbl');
    assert.deepEqual(parse(out, stbl.body, stbl.end).map((b) => b.type), ['stsd', 'stts', 'stsc', 'stsz', 'stco']);
    assert.deepEqual(words(out, find(out, stbl, 'stts')), [2, 4, 1024, 1, 512]);
    assert.deepEqual(words(out, find(out, stbl, 'stsc')), [1, 1, 5, 1]);
    assert.deepEqual(words(out, find(out, stbl, 'stsz')), [0, 5, 5, 7, 3, 4, 6]);
    assert.deepEqual(words(out, find(out, stbl, 'stco')), [1, mdat.body]);
    assert.deepEqual([...out.subarray(mdat.body, mdat.end)], [1, 1, 1, 1, 1, 2, 2, 2, 2, 2, 2, 2, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5]);
    // The sample description (codec config) is copied byte for byte.
    assert.deepEqual([...out.subarray(find(out, stbl, 'stsd').start, find(out, stbl, 'stsd').end)], STSD);
});

test('keeps gaps between fragments by lengthening the sample before the gap', () => {
    const out = defragmentMp4(fragmentedInput([
        chromiumFragment([sample(1000, 2, 1), sample(1000, 2, 2)]),
        chromiumFragment([sample(1000, 2, 3)], 2030), // 30 ticks after the first fragment ends
        chromiumFragment([sample(1000, 2, 4)], 2900), // overlap: ignored, the timeline never goes back
    ]));
    const moov = parse(out)[1], stbl = find(out, moov, 'trak', 'mdia', 'minf', 'stbl');
    assert.deepEqual(words(out, find(out, stbl, 'stts')), [3, 1, 1000, 1, 1030, 2, 1000]);
    assert.equal(words(out, find(out, moov, 'trak', 'mdia', 'mdhd'))[3], 4030);
});

test('uses tfhd defaults and continues data across truns without a data offset', () => {
    const out = defragmentMp4(fragmentedInput([defaultsFragment(4, 3, 960)]));
    const stbl = find(out, parse(out)[1], 'trak', 'mdia', 'minf', 'stbl');
    assert.deepEqual(words(out, find(out, stbl, 'stts')), [1, 4, 960]);
    assert.deepEqual(words(out, find(out, stbl, 'stsz')), [0, 4, 3, 3, 3, 3]);
    const mdat = parse(out)[2];
    assert.deepEqual([...out.subarray(mdat.body, mdat.end)], new Array(12).fill(0).map((_, i) => 100 + i % 50));
});

test('leaves files without fragments alone', () => {
    const plain = Uint8Array.from([...box('ftyp', ascii('M4A '), u32(0)), ...box('moov'), ...box('mdat', 1, 2, 3)]);
    assert.equal(defragmentMp4(plain), null);
});

test('accepts a Node Buffer as input', () => {
    const out = defragmentMp4(Buffer.from(fragmentedInput([chromiumFragment([sample(1024, 5, 1), sample(1024, 5, 2)])])));
    assert.deepEqual(words(out, find(out, parse(out)[1], 'trak', 'mdia', 'mdhd')).slice(2, 4), [48000, 2048]);
});

test('throws on broken input instead of writing a bad file', () => {
    const input = fragmentedInput([chromiumFragment([sample(1024, 5, 1)])]);
    assert.throws(() => defragmentMp4(input.subarray(0, input.length - 2)), /mp4:/);
});
