// Local stand-in for Cloudflare Pages: serves public/ and /api/* (tests only).
import http from 'node:http';
import fs from 'node:fs';
import { D1Shim } from './d1shim.js';
import { handle } from '../src/api.js';
export function startServer(port = 0) {
  const env = { DB: new D1Shim(new URL('../schema.sql', import.meta.url).pathname), SYNC_KEY: 'test-sync-key-1234567890' };
  const html = new URL('../public/index.html', import.meta.url).pathname;
  const srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    if (process.argv[2] === 'run' && url.pathname === '/__sql') { // test-only helper (this file is never deployed)
      const sql = url.searchParams.get('q'); const r = await env.DB.prepare(sql).first();
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(r)); return;
    }
    if (url.pathname.startsWith('/api/')) {
      const chunks = []; for await (const c of req) chunks.push(c);
      const r = await handle(new Request('http://x' + url.pathname, { method: req.method, body: req.method === 'POST' ? Buffer.concat(chunks) : undefined }), env, decodeURIComponent(url.pathname.slice(5)));
      res.writeHead(r.status, { 'content-type': 'application/json' }); res.end(await r.text()); return;
    }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(fs.readFileSync(html));
  });
  return new Promise(ok => srv.listen(port, '127.0.0.1', () => ok({ srv, env, port: srv.address().port })));
}
if (process.argv[2] === 'run') { const { port, env } = await startServer(Number(process.argv[3] || 8787)); console.log('listening', port); }
