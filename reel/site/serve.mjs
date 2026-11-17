// reel/site を 4321 番で配信する最小の静的サーバ（依存なし）。
// 使い方: node reel\site\serve.mjs   → http://127.0.0.1:4321/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('.', import.meta.url));
const PORT = Number(process.env.PORT || 4321);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
};

function safePath(urlPath) {
  const clean = decodeURIComponent((urlPath || '/').split('?')[0].split('#')[0]);
  const rel = normalize(clean === '/' ? 'index.html' : `.${clean}`);
  const abs = join(ROOT, rel);
  if (!abs.startsWith(ROOT.endsWith(sep) ? ROOT : ROOT + sep)) return null;
  return abs;
}

const server = createServer(async (req, res) => {
  const abs = safePath(req.url);
  if (!abs) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('forbidden');
  }
  try {
    let target = abs;
    const st = await stat(target).catch(() => null);
    if (st && st.isDirectory()) target = join(target, 'index.html');
    const body = await readFile(target);
    const type = TYPES[extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'cache-control': 'no-store',
      'content-length': body.length,
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`reel/site serving on http://127.0.0.1:${PORT}/  (root: ${ROOT})`);
});
