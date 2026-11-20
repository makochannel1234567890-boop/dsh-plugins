// Reel builder: 25s / 1080x1920 / 30fps, Ken-Burns cuts over real screen captures,
// free CC BY 4.0 music (Kevin MacLeod / incompetech.com). No text is drawn here —
// every frame is a real screen capture: the published site, or the running
// dsh-mobile-progress PWA of this very session.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const MEDIA = path.join(ROOT, 'reel', 'media');
const MUS = path.join(MEDIA, 'music');
const OUT = path.join(ROOT, 'reel', 'out');
const FF = path.join(ROOT, 'reel', 'tools', 'node_modules', 'ffmpeg-static', 'ffmpeg.exe');

const W = 1080, H = 1920, FPS = 30, TOTAL = 25;

// site/* = shots of the published GitHub Pages site (1080x1920)
// screens/* = shots of the real dsh-mobile-progress PWA while this session ran
const IMAGES = {
  hero: 'site/01-hero.png',
  list: 'site/02-list.png',
  fanout: 'site/03-dsh-fanout.png',
  browser: 'site/04-dsh-browser-agent.png',
  progress: 'site/05-dsh-mobile-progress.png',
  deliberation: 'site/06-dsh-deliberation.png',
  emulator: 'site/07-dsh-emulator-lab.png',
  social: 'site/08-dsh-social-desktop-agent.png',
  localfix: 'site/09-dsh-builtin-browser-localfix.png',
  install: 'site/10-install.png',
  source: 'site/11-source.png',
  pwa100: 'screens/01-progress-100.png',
  pwasteps: 'screens/02-steps.png',
  pwaresult: 'screens/03-result.png',
};

const MUSIC = {
  carefree: 'km-carefree.mp3',
  lifeofriley: 'km-life-of-riley.mp3',
  monkeys: 'km-monkeys-spinning-monkeys.mp3',
  werq: 'km-werq.mp3',
  beachparty: 'km-beach-party.mp3',
};

// zoom: 'in' | 'out' | 'panup' | 'pandown'
const REELS = [
  {
    id: 'reel1',
    music: 'carefree',
    musicOffset: 8,
    shots: [
      { img: 'hero', dur: 2.6, zoom: 'in' },
      { img: 'list', dur: 3.0, zoom: 'panup' },
      { img: 'pwa100', dur: 3.4, zoom: 'in' },
      { img: 'fanout', dur: 3.2, zoom: 'in' },
      { img: 'browser', dur: 3.2, zoom: 'pandown' },
      { img: 'pwasteps', dur: 3.2, zoom: 'in' },
      { img: 'localfix', dur: 3.2, zoom: 'in' },
      { img: 'source', dur: 3.2, zoom: 'out' },
    ],
  },
  {
    id: 'reel2',
    music: 'lifeofriley',
    musicOffset: 12,
    shots: [
      { img: 'hero', dur: 2.0, zoom: 'out' },
      { img: 'pwa100', dur: 2.8, zoom: 'in' },
      { img: 'fanout', dur: 2.6, zoom: 'in' },
      { img: 'browser', dur: 2.6, zoom: 'in' },
      { img: 'progress', dur: 2.6, zoom: 'panup' },
      { img: 'pwasteps', dur: 2.8, zoom: 'in' },
      { img: 'emulator', dur: 2.8, zoom: 'pandown' },
      { img: 'social', dur: 2.8, zoom: 'in' },
      { img: 'source', dur: 3.0, zoom: 'out' },
    ],
  },
  {
    id: 'reel3',
    music: 'monkeys',
    musicOffset: 4,
    shots: [
      { img: 'hero', dur: 2.0, zoom: 'in' },
      { img: 'list', dur: 2.1, zoom: 'pandown' },
      { img: 'fanout', dur: 2.1, zoom: 'in' },
      { img: 'browser', dur: 2.1, zoom: 'out' },
      { img: 'progress', dur: 2.1, zoom: 'in' },
      { img: 'pwa100', dur: 2.1, zoom: 'in' },
      { img: 'emulator', dur: 2.1, zoom: 'in' },
      { img: 'social', dur: 2.1, zoom: 'out' },
      { img: 'localfix', dur: 2.1, zoom: 'in' },
      { img: 'pwasteps', dur: 2.1, zoom: 'in' },
      { img: 'source', dur: 2.1, zoom: 'in' },
      { img: 'hero', dur: 2.0, zoom: 'out' },
    ],
  },
  {
    id: 'reel4',
    music: 'werq',
    musicOffset: 20,
    shots: [
      { img: 'hero', dur: 3.0, zoom: 'in' },
      { img: 'pwa100', dur: 4.2, zoom: 'out' },
      { img: 'fanout', dur: 4.2, zoom: 'panup' },
      { img: 'progress', dur: 4.2, zoom: 'in' },
      { img: 'pwasteps', dur: 4.4, zoom: 'out' },
      { img: 'source', dur: 5.0, zoom: 'out' },
    ],
  },
  {
    id: 'reel5',
    music: 'beachparty',
    musicOffset: 16,
    shots: [
      { img: 'hero', dur: 2.4, zoom: 'out' },
      { img: 'pwa100', dur: 3.4, zoom: 'in' },
      { img: 'install', dur: 3.2, zoom: 'panup' },
      { img: 'fanout', dur: 3.2, zoom: 'in' },
      { img: 'pwasteps', dur: 3.2, zoom: 'in' },
      { img: 'progress', dur: 3.2, zoom: 'in' },
      { img: 'localfix', dur: 3.2, zoom: 'panup' },
      { img: 'source', dur: 3.2, zoom: 'out' },
    ],
  },
];

function zoomExpr(kind, dur) {
  const frames = Math.max(2, Math.round(dur * FPS));
  // zoompan works on the pre-scaled frame; keep motion subtle so screens stay readable.
  switch (kind) {
    case 'in':
      return `zoompan=z='min(1+0.00035*on,1.12)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
    case 'out':
      return `zoompan=z='max(1.12-0.00035*on,1.0)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
    case 'panup':
      return `zoompan=z='1.08':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(1-on/${frames})':d=${frames}:s=${W}x${H}:fps=${FPS}`;
    case 'pandown':
      return `zoompan=z='1.08':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(on/${frames})':d=${frames}:s=${W}x${H}:fps=${FPS}`;
    default:
      return `zoompan=z='1.05':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${W}x${H}:fps=${FPS}`;
  }
}

function run(args, label) {
  const r = spawnSync(FF, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    console.error(`\n[FAIL] ${label} exit=${r.status}`);
    console.error((r.stderr || '').split('\n').slice(-25).join('\n'));
    return false;
  }
  return true;
}

function durationOf(file) {
  const r = spawnSync(FF, ['-i', file], { encoding: 'utf8' });
  const txt = (r.stderr || '') + (r.stdout || '');
  const m = txt.match(/Duration:\s*(\d+):(\d+):(\d+\.\d+)/);
  const s = txt.match(/Stream #\d+:\d+.*Video:.*?,\s*(\d{3,5})x(\d{3,5})/);
  const a = /Stream #\d+:\d+.*Audio:/.test(txt);
  if (!m) return null;
  const dur = (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
  return { dur: +dur.toFixed(2), size: s ? `${s[1]}x${s[2]}` : '?', audio: a };
}

mkdirSync(OUT, { recursive: true });

if (!existsSync(FF)) {
  console.error('ffmpeg not found at ' + FF);
  process.exit(1);
}

const report = [];
for (const reel of REELS) {
  const target = path.join(OUT, `${reel.id}.mp4`);
  const inputs = [];
  const filters = [];
  reel.shots.forEach((s, i) => {
    const file = path.join(MEDIA, IMAGES[s.img]);
    if (!existsSync(file)) throw new Error('missing image ' + file);
    inputs.push('-loop', '1', '-t', String(s.dur), '-i', file);
    filters.push(
      `[${i}:v]scale=${W * 2}:${H * 2}:flags=lanczos,setsar=1,${zoomExpr(s.zoom, s.dur)},trim=duration=${s.dur},setpts=PTS-STARTPTS[v${i}]`
    );
  });
  const audioIdx = reel.shots.length;
  const music = path.join(MUS, MUSIC[reel.music]);
  inputs.push('-ss', String(reel.musicOffset), '-t', String(TOTAL), '-i', music);

  const concatIn = reel.shots.map((_, i) => `[v${i}]`).join('');
  filters.push(`${concatIn}concat=n=${reel.shots.length}:v=1:a=0[vout]`);

  const args = [
    '-hide_banner', '-y',
    ...inputs,
    '-filter_complex', filters.join(';'),
    '-map', '[vout]', '-map', `${audioIdx}:a`,
    '-t', String(TOTAL),
    '-af', `loudnorm=I=-14:TP=-1.5:LRA=11,afade=t=in:st=0:d=0.4,afade=t=out:st=${TOTAL - 1.6}:d=1.6`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-g', '60',
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-movflags', '+faststart',
    target,
  ];

  process.stdout.write(`building ${reel.id} (${reel.shots.length} cuts, ${reel.music}) ... `);
  const ok = run(args, reel.id);
  const info = ok ? durationOf(target) : null;
  console.log(ok ? `ok ${JSON.stringify(info)}` : 'FAILED');
  report.push({ id: reel.id, ok, info, music: reel.music, cuts: reel.shots.length });
}

const credits = `クレジット（動画説明欄に貼ってください / CC BY 4.0）

Music by Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0 International (CC BY 4.0)
https://creativecommons.org/licenses/by/4.0/

使用曲:
${REELS.map((r) => `${r.id}: "${MUSIC[r.music].replace(/^km-|\.mp3$/g, '').replace(/-/g, ' ')}" Kevin MacLeod (incompetech.com)`).join('\n')}

映像: すべて実画面キャプチャ（1080x1920）
- reel\\media\\site: 公開サイト https://makochannel1234567890-boop.github.io/dsh-plugins/ のスクリーンショット11枚
- reel\\media\\screens: 実行中の dsh-mobile-progress PWA（100% / ステップ / 結果）3枚
サイト: https://github.com/makochannel1234567890-boop/dsh-plugins
`;
writeFileSync(path.join(OUT, 'CREDITS.txt'), credits, 'utf8');
writeFileSync(path.join(OUT, 'build-report.json'), JSON.stringify(report, null, 2), 'utf8');
console.log('\n' + JSON.stringify(report, null, 2));
