// Renders the desktop icon from the game itself: the real ship model towing the pod through the 3D cave
// (main.js ?icon hero shot), then packs 256/64/48/32/16 px PNGs into launcher/thrust-zarch.ico (+ a .png copy).
//   node tools/make-icon.mjs
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'launcher');
const BROWSERS = [process.env.CHROME_PATH, 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'].filter(Boolean);
const SIZES = [256, 64, 48, 32, 16];

const port = 8790 + Math.floor(Math.random() * 100);
const server = spawn(process.execPath, [path.join(ROOT, 'tools', 'serve.mjs'), '--port', String(port)], { stdio: 'ignore' });
const up = () => new Promise(ok => http.get(`http://127.0.0.1:${port}/version.json`, r => ok(r.statusCode === 200)).on('error', () => ok(false)));
for (let i = 0; i < 50 && !(await up()); i++) await new Promise(r => setTimeout(r, 100));

const browser = await puppeteer.launch({
  executablePath: BROWSERS.find(p => fs.existsSync(p)), headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--no-first-run', '--mute-audio'],
});
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 512, height: 512 });
  await page.goto(`http://127.0.0.1:${port}/?debug&kb&icon`, { waitUntil: 'load' });
  await page.waitForFunction('window.__G && __G.G.icon', { timeout: 15000 });
  await new Promise(r => setTimeout(r, 1500));
  const shot = (await page.screenshot({ type: 'png' })).toString('base64');
  // downscale in the page (good filtering), add a rounded frame so it reads on any wallpaper
  const pngs = await page.evaluate(async (b64, sizes) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    return sizes.map(n => {
      const c = document.createElement('canvas'); c.width = c.height = n; const x = c.getContext('2d');
      const r = n * 0.16, path = new Path2D(); path.roundRect(0.5, 0.5, n - 1, n - 1, r);
      x.save(); x.clip(path); x.imageSmoothingQuality = 'high';
      const crop = 400, off = (512 - crop) / 2; x.drawImage(img, off, off, crop, crop, 0, 0, n, n); x.restore();
      x.lineWidth = Math.max(1, n / 40); x.strokeStyle = '#66e8ff'; x.stroke(path);
      return c.toDataURL('image/png').split(',')[1];
    });
  }, shot, SIZES);
  const bufs = pngs.map(p => Buffer.from(p, 'base64'));
  // ICO container with embedded PNGs (supported since Windows Vista)
  const head = Buffer.alloc(6 + 16 * bufs.length); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(bufs.length, 4);
  let off = head.length;
  bufs.forEach((b, i) => {
    const e = 6 + 16 * i, n = SIZES[i] >= 256 ? 0 : SIZES[i];
    head.writeUInt8(n, e); head.writeUInt8(n, e + 1); head.writeUInt16LE(1, e + 4); head.writeUInt16LE(32, e + 6);
    head.writeUInt32LE(b.length, e + 8); head.writeUInt32LE(off, e + 12); off += b.length;
  });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'thrust-zarch.ico'), Buffer.concat([head, ...bufs]));
  fs.writeFileSync(path.join(OUT, 'thrust-zarch.png'), bufs[0]);
  fs.writeFileSync(path.join(OUT, 'icon-source.png'), Buffer.from(shot, 'base64'));
  console.log('wrote', path.join(OUT, 'thrust-zarch.ico'));
} finally { await browser.close(); server.kill(); }
