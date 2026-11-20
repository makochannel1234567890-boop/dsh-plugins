// BPM / beat grid / brightness measurement for MP3s — no ffmpeg required.
//
// Setup (dependency is a WASM MP3 decoder, ~1 MB, installed outside this repo):
//   cd <somewhere-outside-repo> && npm init -y && npm i mpg123-decoder
//   copy this file there, then:
//   node bpm.mjs <abs path to mp3> ...
//
// Output: one JSON line per file with bpm, barIntervalSec, firstBeatSec,
// best25 (loudest 25 s window that starts on a bar line) and barStarts.
//// Measure tempo / beat grid / brightness of MP3 files.
// Uses mpg123-decoder (WASM) so no ffmpeg is required.
// Usage: node bpm.mjs <file...>
import { readFileSync } from "node:fs";
import { MPEGDecoder } from "mpg123-decoder";

const FRAME = 512;            // analysis window (samples)
const HOP = 512;

function mono(channelData, n) {
  const ch = channelData.length;
  const out = new Float32Array(n);
  if (ch === 1) { out.set(channelData[0].subarray(0, n)); return out; }
  const a = channelData[0], b = channelData[1];
  for (let i = 0; i < n; i++) out[i] = (a[i] + b[i]) * 0.5;
  return out;
}

function analyze(sig, sr) {
  const frames = Math.floor((sig.length - FRAME) / HOP);
  const energy = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let e = 0;
    const off = f * HOP;
    for (let i = 0; i < FRAME; i++) { const v = sig[off + i]; e += v * v; }
    energy[f] = e / FRAME;
  }
  // onset strength = positive log-energy change
  const onset = new Float64Array(frames);
  for (let f = 1; f < frames; f++) {
    const a = Math.log(1e-9 + energy[f]);
    const b = Math.log(1e-9 + energy[f - 1]);
    onset[f] = Math.max(0, a - b);
  }
  // remove slow trend
  const mean = onset.reduce((s, v) => s + v, 0) / frames;
  for (let f = 0; f < frames; f++) onset[f] = Math.max(0, onset[f] - mean * 0.5);

  const frameRate = sr / HOP; // ~86.13 Hz at 44.1k

  // autocorrelation over 50..200 BPM
  const bestFor = (bpm) => Math.round((60 / bpm) * frameRate);
  const lagMin = bestFor(200), lagMax = bestFor(50);
  const ac = new Float64Array(lagMax + 2);
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let s = 0;
    for (let f = lag; f < frames; f++) s += onset[f] * onset[f - lag];
    ac[lag] = s / (frames - lag);
  }
  // normalize by lag-0-ish energy
  let best = { lag: lagMin, score: -Infinity };
  const cands = [];
  for (let lag = lagMin; lag <= lagMax; lag++) {
    cands.push({ lag, bpm: 60 * frameRate / lag, score: ac[lag] });
    if (ac[lag] > best.score) best = { lag, score: ac[lag] };
  }
  cands.sort((a, b) => b.score - a.score);
  // octave-fold into 84..168 (typical "upbeat" band) preferring the strongest
  const fold = (bpm) => {
    let b = bpm;
    while (b < 84) b *= 2;
    while (b > 168) b /= 2;
    return b;
  };
  const top = cands.slice(0, 12).map((c) => ({ ...c, folded: fold(c.bpm) }));
  // group near-duplicates
  const groups = [];
  for (const t of top) {
    let g = groups.find((x) => Math.abs(x.bpm - t.folded) < 3);
    if (!g) { g = { bpm: t.folded, score: 0, hits: 0 }; groups.push(g); }
    g.score += t.score; g.hits++;
  }
  groups.sort((a, b) => b.score - a.score);
  // refine the winning lag with parabolic interpolation on the autocorrelation
  let winLag = Math.round((60 / (groups.length ? groups[0].bpm : 120)) * frameRate);
  if (winLag >= lagMin + 1 && winLag <= lagMax - 1) {
    const y0 = ac[winLag - 1], y1 = ac[winLag], y2 = ac[winLag + 1];
    const denom = y0 - 2 * y1 + y2;
    const delta = denom !== 0 ? 0.5 * (y0 - y2) / denom : 0;
    if (Math.abs(delta) < 1) winLag = winLag + delta;
  }
  const rawBpm = 60 * frameRate / winLag;
  const bpm = Math.round(fold(rawBpm) * 10) / 10;

  // beat grid: pick the phase maximising onset energy at beat positions
  const interval = 60 / bpm * frameRate; // frames per beat
  let bestPhase = 0, bestPhaseScore = -Infinity;
  for (let ph = 0; ph < interval; ph += 1) {
    let s = 0, c = 0;
    for (let k = 0; ; k++) {
      const idx = Math.round(ph + k * interval);
      if (idx >= frames) break;
      s += onset[idx]; c++;
    }
    if (c > 0 && s / c > bestPhaseScore) { bestPhaseScore = s / c; bestPhase = ph; }
  }
  const firstBeatSec = bestPhase / frameRate;
  const bar = (60 / bpm) * 4;
  // energy contour per 2 s for "where the track lifts" (helps pick a 25 s window)
  const contour = [];
  const per = 2;
  for (let s = 0; s + per * 2 <= Math.min(60, sig.length / sr); s += per) {
    let e = 0, c = 0;
    for (let f = Math.floor(s * frameRate); f < Math.floor((s + per) * frameRate) && f < frames; f++) { e += energy[f]; c++; }
    contour.push({ t: s, e: Math.round((c ? e / c : 0) * 1e6) });
  }

  // best 25 s window starting exactly on a bar line
  const totalSec = sig.length / sr;
  let bestWin = null;
  for (let b = firstBeatSec; b + 25 <= totalSec; b += bar) {
    let e = 0, c = 0;
    for (let f = Math.floor(b * frameRate); f < Math.floor((b + 25) * frameRate) && f < frames; f++) { e += energy[f]; c++; }
    const score = c ? e / c : 0;
    if (!bestWin || score > bestWin.score) bestWin = { start: Math.round(b * 1000) / 1000, score };
  }
  const bars = [];
  if (bestWin) {
    for (let i = 0; i < 40; i++) {
      const t = bestWin.start + i * bar;
      if (t > bestWin.start + 25) break;
      bars.push(Math.round(t * 1000) / 1000);
    }
  }

  // brightness: high-frequency energy ratio via first difference (6 dB/oct tilt)
  let eAll = 0, eHp = 0;
  const N = Math.min(sig.length - 1, sr * 30); // first 30 s is representative
  for (let i = 1; i < N; i++) {
    const d = sig[i] - sig[i - 1];
    eHp += d * d; eAll += sig[i] * sig[i];
  }
  const hfRatio = eAll > 0 ? eHp / eAll : 0;

  return {
    frames, frameRate: Math.round(frameRate * 100) / 100,
    bpm,
    candidates: groups.slice(0, 4).map((g) => Math.round(g.bpm * 10) / 10),
    firstBeatSec: Math.round(firstBeatSec * 1000) / 1000,
    beatIntervalSec: Math.round((60 / bpm) * 1000) / 1000,
    barIntervalSec: Math.round(bar * 1000) / 1000,
    best25: bestWin ? { start: bestWin.start, end: Math.round((bestWin.start + 25) * 1000) / 1000, barStarts: bars } : null,
    contour,
    hfRatio: Math.round(hfRatio * 10000) / 10000,
  };
}

for (const path of process.argv.slice(2)) {
  const buf = readFileSync(path);
  const dec = new MPEGDecoder();
  await dec.ready;
  const { channelData, samplesDecoded, sampleRate } = dec.decode(new Uint8Array(buf));
  const sig = mono(channelData, samplesDecoded);
  const r = analyze(sig, sampleRate);
  dec.free();
  console.log(JSON.stringify({ file: path.split(/[\\/]/).pop(), sampleRate, seconds: Math.round(samplesDecoded / sampleRate * 10) / 10, ...r }));
}


