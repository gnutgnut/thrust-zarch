// Static server for game/ with caching disabled, so a reload always runs the latest working tree.
// Also serves /version.json (git commit, dirty flag, date) for the build stamp on the title screen.
//   node tools/serve.mjs [--port 8765]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME = path.join(ROOT, 'game');
const port = +(process.argv[process.argv.indexOf('--port') + 1] || 0) || 8765;
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg' };

function version() {
  const git = c => { try { return execSync(`git ${c}`, { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; } };
  return { commit: git('rev-parse --short HEAD') || 'nogit', dirty: !!git('status --porcelain -- game'), date: git('log -1 --format=%cd --date=format:%Y-%m-%d_%H:%M'), served: new Date().toISOString() };
}

http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const send = (code, body, type = 'text/plain') => { res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' }); res.end(body); };
  if (url === '/version.json') return send(200, JSON.stringify(version()), 'application/json');
  let file = path.join(GAME, url.endsWith('/') ? url + 'index.html' : url);
  if (!file.startsWith(GAME)) return send(403, 'forbidden');
  if (url === '/favicon.ico') file = path.join(ROOT, 'launcher', 'thrust-zarch.ico');   // the game-rendered icon
  fs.readFile(file, (err, data) => err ? send(404, 'not found') : send(200, data, TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream'));
}).listen(port, '127.0.0.1', () => console.log(`serving ${GAME} at http://127.0.0.1:${port}/`));
