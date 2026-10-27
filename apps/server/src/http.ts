import { existsSync, statSync, createReadStream } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json',
};

export function createHttpHandler(stats: () => { rooms: number; clients: number }, webDist: string) {
  const distRoot = resolve(webDist);
  return (req: IncomingMessage, res: ServerResponse): void => {
    try {
      if (req.method !== 'GET') {
        res.writeHead(405, { Allow: 'GET' }).end();
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: true, ...stats() }));
        return;
      }
      if (!existsSync(distRoot)) {
        res.writeHead(404).end();
        return;
      }
      let rel = decodeURIComponent(url.pathname);
      if (rel.includes('\0')) {
        res.writeHead(400).end();
        return;
      }
      if (rel.endsWith('/')) rel += 'index.html';
      const file = resolve(distRoot, '.' + rel);
      if (file !== distRoot && !file.startsWith(distRoot + sep)) {
        res.writeHead(403).end();
        return;
      }
      if (!existsSync(file) || !statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
      }
      // Vite's hashed bundles never change under one name; everything else (index.html) is revalidated so
      // an update reaches every browser on its next load.
      res.writeHead(200, {
        'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Cache-Control': rel.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      });
      createReadStream(file).on('error', () => res.destroy()).pipe(res);
    } catch {
      if (!res.headersSent) res.writeHead(400);
      res.end();
    }
  };
}
