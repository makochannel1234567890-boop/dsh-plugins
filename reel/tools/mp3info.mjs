// Minimal MP3 inspector: ID3v2 tags + duration via sequential MPEG frame chain.
// Each candidate frame is accepted only if the NEXT header also validates,
// which rejects false 0xFFEx sync words inside audio data.
// No external deps. Usage: node reel/tools/mp3info.mjs <file...>
import { readFileSync } from "node:fs";

const BR = {
  "1-3": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "1-2": [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  "1-1": [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  "2-3": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2-1": [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
};
const SRT = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function parseHeader(buf, p) {
  if (p + 4 > buf.length) return null;
  if (buf[p] !== 0xff || (buf[p + 1] & 0xe0) !== 0xe0) return null;
  const verBits = (buf[p + 1] >> 3) & 0x03;
  const layerBits = (buf[p + 1] >> 1) & 0x03;
  if (verBits === 1 || layerBits === 0) return null;
  const brIdx = (buf[p + 2] >> 4) & 0x0f;
  const srIdx = (buf[p + 2] >> 2) & 0x03;
  // NOTE: the 2-bit "emphasis" field is deliberately NOT validated.
  // Emphasis 2 is reserved, yet real encoders (incl. LAME) emit it and every
  // decoder ignores it; rejecting it here broke the frame chain on 5 of 6 files.
  if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
  const layer = 4 - layerBits;
  const isMpeg1 = verBits === 3;
  const table = BR[`${isMpeg1 ? 1 : 2}-${layer}`];
  const bitrate = table[brIdx] * 1000;
  const sampleRate = SRT[verBits][srIdx];
  const padding = (buf[p + 2] >> 1) & 0x01;
  const frameLen = layer === 1
    ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4
    : layer === 3 && !isMpeg1
      ? Math.floor((72 * bitrate) / sampleRate) + padding
      : Math.floor((144 * bitrate) / sampleRate) + padding;
  const spf = layer === 1 ? 384 : layer === 3 && !isMpeg1 ? 576 : 1152;
  return { frameLen, spf, bitrate, sampleRate, layer, isMpeg1 };
}

function id3Tags(buf) {
  const out = {};
  if (!(buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)) return { tags: out, end: 0 };
  const ver = buf[3];
  const flags = buf[5];
  const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
  let pos = 10;
  const end = 10 + size;
  if (flags & 0x40) {
    const ext = ver === 4
      ? ((buf[pos] & 0x7f) << 21) | ((buf[pos + 1] & 0x7f) << 14) | ((buf[pos + 2] & 0x7f) << 7) | (buf[pos + 3] & 0x7f)
      : ((buf[pos] << 24) | (buf[pos + 1] << 16) | (buf[pos + 2] << 8) | buf[pos + 3]) + 4;
    pos += ext;
  }
  const dec = (b) => {
    const enc = b[0];
    const body = b.subarray(1);
    if (enc === 1 || enc === 2) {
      let s = "";
      for (let i = 0; i + 1 < body.length; i += 2) {
        const c = enc === 1 ? body.readUInt16LE(i) : body.readUInt16BE(i);
        if (c) s += String.fromCharCode(c);
      }
      return s.replace(/\u0000/g, "").trim();
    }
    if (enc === 3) return body.toString("utf8").replace(/\u0000/g, "").trim();
    return body.toString("latin1").replace(/\u0000/g, "").trim();
  };
  while (pos + 10 <= end) {
    const id = buf.toString("latin1", pos, pos + 4);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const fsz = ver === 4
      ? ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) | ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f)
      : (buf[pos + 4] << 24) | (buf[pos + 5] << 16) | (buf[pos + 6] << 8) | buf[pos + 7];
    if (fsz <= 0 || pos + 10 + fsz > buf.length) break;
    const body = buf.subarray(pos + 10, pos + 10 + fsz);
    const map = { TIT2: "title", TPE1: "artist", TALB: "album", TCOM: "composer", TENC: "encodedBy", TSSE: "encoder", TDRC: "year", TYER: "year", TCOP: "copyright", WCOP: "copyrightUrl", TPUB: "publisher" };
    if (map[id]) out[map[id]] = dec(body);
    if (id === "APIC") out.hasArt = true;
    if (id === "COMM") {
      const enc = body[0];
      let p = 4;
      if (enc === 1 || enc === 2) { while (p + 1 < body.length && !(body[p] === 0 && body[p + 1] === 0)) p += 2; p += 2; }
      else { while (p < body.length && body[p] !== 0) p += 1; p += 1; }
      out.comment = dec(body.subarray(p));
    }
    pos += 10 + fsz;
  }
  return { tags: out, end };
}

function walk(buf, start) {
  // find first frame whose successor also validates
  let first = null;
  for (let p = start; p + 4 <= buf.length; p++) {
    const h = parseHeader(buf, p);
    if (!h) continue;
    if (parseHeader(buf, p + h.frameLen)) { first = p; break; }
  }
  if (first === null) return { frames: 0, seconds: 0, error: "no frame chain" };
  let q = first, frames = 0, samples = 0, sr = 0, resyncs = 0;
  const brs = new Map();
  while (q + 4 <= buf.length) {
    let h = parseHeader(buf, q);
    if (!h && resyncs < 8) {
      // tolerate a stray byte / trailing tag: rescan a bounded window
      let found = -1;
      for (let p = q + 1; p < Math.min(q + 4096, buf.length - 4); p++) {
        const c = parseHeader(buf, p);
        if (c && parseHeader(buf, p + c.frameLen)) { found = p; break; }
      }
      resyncs++;
      if (found < 0) break;
      q = found;
      h = parseHeader(buf, q);
    }
    if (!h) break;
    frames++; samples += h.spf; sr = h.sampleRate;
    brs.set(h.bitrate, (brs.get(h.bitrate) || 0) + 1);
    q += h.frameLen;
  }
  const top = [...brs.entries()].sort((a, b) => b[1] - a[1]);
  return {
    frames,
    seconds: sr ? samples / sr : 0,
    sampleRate: sr,
    vbr: brs.size > 1,
    dominantBitrateKbps: top.length ? top[0][0] / 1000 : 0,
    distinctBitrates: brs.size,
    audioStart: first,
    audioEnd: q,
    resyncs,
    trailingBytes: buf.length - q,
  };
}

for (const path of process.argv.slice(2)) {
  const buf = readFileSync(path);
  const { tags, end } = id3Tags(buf);
  const w = walk(buf, end);
  console.log(JSON.stringify({
    file: path.split(/[\\/]/).pop(),
    bytes: buf.length,
    tags,
    id3End: end,
    ...w,
    mmss: `${Math.floor(w.seconds / 60)}:${String(Math.floor(w.seconds % 60)).padStart(2, "0")}`,
  }));
}
