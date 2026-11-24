// scripts/serve-dashboard.js — local dev server, no external deps
import 'dotenv/config';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler } from '../netlify/functions/data.js';
import { handler as checkHandler } from '../netlify/functions/check.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const DASHBOARD = join(__dirname, '..', 'dashboard');
const PORT = 8888;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.ico':  'image/x-icon',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/data') {
    try {
      const result = await handler({});
      res.writeHead(result.statusCode, result.headers ?? { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  if (url.pathname === '/api/check') {
    try {
      const qs = Object.fromEntries(url.searchParams.entries());
      const result = await checkHandler({ queryStringParameters: qs });
      res.writeHead(result.statusCode, result.headers ?? { 'Content-Type': 'application/json' });
      res.end(result.body);
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  let filePath = join(DASHBOARD, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!extname(filePath)) filePath += '.html';
  const ext = extname(filePath);

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] ?? 'text/plain' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
}).listen(PORT, () => {
  console.log(`\nDashboard: http://localhost:${PORT}`);
  console.log(`API:       http://localhost:${PORT}/api/data`);
  console.log(`Check:     http://localhost:${PORT}/api/check`);
  console.log(`Check one: http://localhost:${PORT}/api/check?asset=NVDA\n`);
});
