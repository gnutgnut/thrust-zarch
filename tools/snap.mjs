#!/usr/bin/env node
// snap.mjs - headless "oracle" harness for the Thrust/Zarch browser game.
// Serves game/ (or uses --url), opens the page in headless Chrome with software WebGL,
// runs a scene script of steps, and writes screenshots + log.txt + result.json to tools/runs/.
//
//   node snap.mjs scenes/smoke.json
//   node snap.mjs scenes/cave.json --url http://127.0.0.1:8765/
//   node snap.mjs --query "?debug&auto" --steps "wait 1500" "shot a" "expect __G.G.mode==='zarch'"
//
// See README.md for the step reference.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import puppeteer from 'puppeteer-core';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const GAME = path.resolve(TOOLS, '..', 'game');
const BROWSERS = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean);

// ---------- CLI ----------
function parseArgs(argv) {
  const o = { steps: null, script: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') o.url = next();
    else if (a === '--query') o.query = next();
    else if (a === '--name') o.name = next();
    else if (a === '--out') o.out = next();
    else if (a === '--browser') o.browser = next();
    else if (a === '--headful') o.headful = true;
    else if (a === '--allow-console-errors') o.allowConsoleErrors = true;
    else if (a === '--width') o.width = +next();
    else if (a === '--height') o.height = +next();
    else if (a === '--steps') { o.steps = []; while (argv[i + 1] && !argv[i + 1].startsWith('--')) o.steps.push(argv[++i]); }
    else if (a === '-h' || a === '--help') o.help = true;
    else if (!o.script) o.script = a;
    else throw new Error('unexpected argument: ' + a);
  }
  return o;
}

async function loadScript(file) {
  const abs = path.resolve(file);
  if (/\.(m?js)$/i.test(abs)) {
    const mod = await import(pathToFileURL(abs).href);
    const d = mod.default ?? mod;
    return typeof d === 'function' ? { name: path.basename(abs).replace(/\.\w+$/, ''), run: d } : d;
  }
  return JSON.parse(fs.readFileSync(abs, 'utf8'));
}

// ---------- static server ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.wasm': 'application/wasm',
  '.txt': 'text/plain', '.ico': 'image/x-icon',
};
function startServer(root) {
  return new Promise((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p === '/favicon.ico' && !fs.existsSync(path.join(root, 'favicon.ico'))) { res.writeHead(204); return res.end(); }
      if (p === '/version.json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"commit":"harness","dirty":false,"date":""}'); }
      if (p.endsWith('/')) p += 'index.html';
      const f = path.resolve(root, '.' + p);
      if (!f.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.readFile(f, (err, buf) => {
        if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(f).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(buf);
      });
    });
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- step parsing ----------
// A step may be a string ("key tap Space 1000"), an array (["key","tap","Space",1000]) or an object ({op:"wait", ms:500}).
function normStep(s) {
  if (typeof s === 'string') {
    const m = s.match(/^\s*(\S+)\s*(.*)$/s);
    const op = m[1], rest = m[2];
    if (['eval', 'expect', 'log', 'waitfor', 'waitFor'].includes(op)) {
      // expressions keep the rest verbatim; waitfor takes "[timeoutMs] expr"
      if (op.toLowerCase() === 'waitfor') { const t = rest.match(/^(\d+)\s+(.*)$/s); return t ? [op, t[2], +t[1]] : [op, rest]; }
      return [op, rest];
    }
    return [op, ...rest.split(/\s+/).filter(Boolean)];
  }
  if (Array.isArray(s)) return s;
  if (s && typeof s === 'object') {
    const { op, ...r } = s;
    switch (op) {
      case 'wait': return ['wait', r.ms];
      case 'key': return ['key', r.action || 'tap', r.code, r.ms];
      case 'eval': case 'expect': case 'log': return [op, r.expr ?? r.msg, r.label];
      case 'waitFor': case 'waitfor': return ['waitFor', r.expr, r.timeout];
      case 'shot': return ['shot', r.name];
      case 'goto': return ['goto', r.query];
      case 'click': return ['click', r.x, r.y];
      case 'notblank': return ['notblank', r.min];
      default: return [op, ...Object.values(r)];
    }
  }
  throw new Error('bad step: ' + JSON.stringify(s));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);

// ---------- main ----------
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.script && !args.steps)) {
    console.log(fs.readFileSync(path.join(TOOLS, 'README.md'), 'utf8'));
    process.exit(args.help ? 0 : 2);
  }
  const scene = args.script ? await loadScript(args.script) : {};
  if (args.steps) scene.steps = args.steps;
  const name = (args.name || scene.name || 'adhoc').replace(/[^\w.-]+/g, '_');
  const query = args.query ?? scene.query ?? '?debug&auto';
  const W = args.width || scene.width || 1280, H = args.height || scene.height || 720;
  const allowConsoleErrors = args.allowConsoleErrors || scene.allowConsoleErrors || false;

  const runDir = path.resolve(args.out || path.join(TOOLS, 'runs', `${stamp()}-${name}`));
  fs.mkdirSync(runDir, { recursive: true });
  const logLines = [];
  const t0 = Date.now();
  const log = (kind, msg) => {
    const line = `[${((Date.now() - t0) / 1000).toFixed(3).padStart(8)}] ${kind.padEnd(8)} ${msg}`;
    logLines.push(line);
    console.log(line);
  };
  const result = { name, query, url: null, ok: false, browser: null, gpu: null, fps: null, shots: [], evals: [], expects: [], errors: [], consoleErrors: [], startedAt: new Date(t0).toISOString() };

  let server = null, browser = null;
  try {
    let base = args.url;
    if (!base) {
      server = await startServer(GAME);
      base = `http://127.0.0.1:${server.address().port}/`;
      log('server', `serving ${GAME} at ${base}`);
    } else log('server', `using existing ${base}`);
    const pageUrl = new URL(query, base).href;
    result.url = pageUrl;

    const exe = args.browser || BROWSERS.find(p => fs.existsSync(p));
    if (!exe) throw new Error('no Chrome/Edge found; pass --browser or set CHROME_PATH');
    result.browser = exe;
    browser = await puppeteer.launch({
      executablePath: exe,
      headless: args.headful ? false : 'new',
      defaultViewport: { width: W, height: H, deviceScaleFactor: 1 },
      args: [
        `--window-size=${W},${H}`,
        '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
        '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run', '--no-default-browser-check',
      ],
    });
    log('browser', `${exe} ${await browser.version()}`);
    const page = await browser.newPage();

    page.on('console', m => {
      const loc = m.location?.(); const where = loc?.url ? ` (${loc.url.replace(base, '')}:${loc.lineNumber ?? '?'})` : '';
      log('console', `${m.type()}: ${m.text()}${where}`);
      if (m.type() === 'error') result.consoleErrors.push(m.text());
    });
    page.on('pageerror', e => { log('PAGEERR', e.stack || e.message || String(e)); result.errors.push(String(e.message || e)); });
    page.on('requestfailed', r => { log('REQFAIL', `${r.url()} ${r.failure()?.errorText}`); result.errors.push(`request failed: ${r.url()}`); });
    page.on('response', r => { if (r.status() >= 400) log('HTTP', `${r.status()} ${r.url()}`); });

    const fail = (msg) => { log('FAIL', msg); result.expects.push({ ok: false, msg }); };
    let lastShot = null;

    const ctx = {
      page, log,
      async goto(q) {
        const u = new URL(q ?? query, base).href;
        log('goto', u);
        await page.goto(u, { waitUntil: 'load' });
        await page.bringToFront();
      },
      wait: async (ms) => { log('wait', `${ms} ms`); await sleep(+ms); },
      async key(action, code, ms) {
        action = action || 'tap';
        log('key', `${action} ${code}${ms ? ' ' + ms + 'ms' : ''}`);
        if (action === 'down') await page.keyboard.down(code);
        else if (action === 'up') await page.keyboard.up(code);
        else if (action === 'tap' || action === 'hold') { await page.keyboard.down(code); await sleep(+ms || 60); await page.keyboard.up(code); }
        else throw new Error('key action must be down|up|tap|hold');
      },
      async click(x, y) { log('click', `${x},${y}`); await page.mouse.click(+x, +y); },
      async eval(expr, label) {
        const v = await page.evaluate(`(async()=>{ const __r = (${expr}); return JSON.parse(JSON.stringify(await __r ?? null)); })()`).catch(e => ({ __error: e.message }));
        log('eval', `${label ? label + ': ' : ''}${expr}  =>  ${JSON.stringify(v)}`);
        result.evals.push({ expr, label, value: v });
        return v;
      },
      async expect(expr, label) {
        let v, err;
        try { v = await page.evaluate(`(async()=>(${expr}))()`); } catch (e) { err = e.message; }
        const ok = !err && !!v;
        log(ok ? 'PASS' : 'FAIL', `expect ${label ? label + ': ' : ''}${expr}  =>  ${err ? 'ERROR ' + err : JSON.stringify(v)}`);
        result.expects.push({ expr, label, ok, value: v ?? null, error: err });
        return ok;
      },
      async waitFor(expr, timeout = 10000) {
        log('waitFor', `${expr} (≤${timeout} ms)`);
        try { await page.waitForFunction(expr, { timeout: +timeout, polling: 50 }); return true; }
        catch { fail(`waitFor timed out: ${expr}`); return false; }
      },
      async shot(sname) {
        sname = (sname || `shot${result.shots.length + 1}`).replace(/[^\w.-]+/g, '_');
        const file = path.join(runDir, `${String(result.shots.length + 1).padStart(2, '0')}-${sname}.png`);
        const buf = await page.screenshot({ path: file, type: 'png' });
        // pixel stats of the PNG, computed in the page with a 2D canvas (no extra deps)
        const stats = await page.evaluate(async (b64) => {
          const img = await createImageBitmap(await (await fetch('data:image/png;base64,' + b64)).blob());
          const c = new OffscreenCanvas(img.width, img.height), g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          const d = g.getImageData(0, 0, img.width, img.height).data;
          let sum = 0, lit = 0, n = 0; const colors = new Set();
          for (let i = 0; i < d.length; i += 16) { // every 4th pixel
            const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            sum += l; n++; if (l > 16) lit++;
            if (colors.size < 5000) colors.add((d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4));
          }
          return { w: img.width, h: img.height, meanLuma: +(sum / n).toFixed(1), litFraction: +(lit / n).toFixed(4), colors: colors.size };
        }, Buffer.from(buf).toString('base64'));
        lastShot = { name: sname, file: path.relative(runDir, file), ...stats };
        result.shots.push(lastShot);
        log('shot', `${lastShot.file}  ${JSON.stringify(stats)}`);
        return lastShot;
      },
      async notblank(min = 0.05) {
        if (!lastShot) return fail('notblank: no screenshot taken yet');
        const ok = lastShot.litFraction >= +min && lastShot.colors > 8;
        log(ok ? 'PASS' : 'FAIL', `notblank ${lastShot.name}: litFraction=${lastShot.litFraction} (min ${min}) colors=${lastShot.colors}`);
        result.expects.push({ expr: `notblank(${lastShot.name})`, ok, value: lastShot.litFraction });
        return ok;
      },
      async logmsg(msg) { log('note', msg); },
    };

    await ctx.goto(query);
    // GPU string / WebGL sanity
    const gl = await page.evaluate(() => {
      const c = document.createElement('canvas'); const g = c.getContext('webgl2') || c.getContext('webgl');
      const ext = g && g.getExtension('WEBGL_debug_renderer_info');
      return { webgl: !!g, renderer: ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null };
    });
    log('webgl', JSON.stringify(gl));
    if (!gl.webgl) result.errors.push('WebGL unavailable in this browser');

    if (typeof scene.run === 'function') {
      await scene.run(ctx);
    } else {
      for (const raw of scene.steps || []) {
        const [op, ...a] = normStep(raw);
        switch (op) {
          case 'wait': await ctx.wait(a[0]); break;
          case 'key': await ctx.key(a[0], a[1], a[2]); break;
          case 'tap': case 'hold': await ctx.key(op, a[0], a[1]); break;
          case 'down': case 'up': await ctx.key(op, a[0]); break;
          case 'click': await ctx.click(a[0], a[1]); break;
          case 'eval': await ctx.eval(a[0], a[1]); break;
          case 'expect': await ctx.expect(a[0], a[1]); break;
          case 'waitFor': case 'waitfor': await ctx.waitFor(a[0], a[1]); break;
          case 'shot': await ctx.shot(a[0]); break;
          case 'notblank': await ctx.notblank(a[0]); break;
          case 'goto': await ctx.goto(a[0]); break;
          case 'log': await ctx.logmsg(a[0]); break;
          default: throw new Error('unknown step op: ' + op);
        }
      }
    }

    // final telemetry
    const tail = await page.evaluate(() => ({
      gpu: document.getElementById('gpuinfo')?.textContent || null,
      fps: document.getElementById('dbg')?.textContent || null,
      mode: window.__G?.G?.mode ?? null, state: window.__G?.G?.state ?? null,
    })).catch(() => ({}));
    result.gpu = tail.gpu || (gl.renderer ? 'GPU: ' + gl.renderer : null);
    result.fps = tail.fps;
    result.final = { mode: tail.mode, state: tail.state };
    log('final', JSON.stringify(tail));
  } catch (e) {
    log('CRASH', e.stack || String(e));
    result.errors.push('harness: ' + (e.message || e));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) server.close();
  }

  const failedExpects = result.expects.filter(x => !x.ok).length;
  const consoleFail = !allowConsoleErrors && result.consoleErrors.length > 0;
  result.ok = result.errors.length === 0 && failedExpects === 0 && !consoleFail;
  result.summary = `${result.ok ? 'PASS' : 'FAIL'}: ${result.expects.length - failedExpects}/${result.expects.length} expects, ${result.errors.length} page errors, ${result.consoleErrors.length} console errors${consoleFail ? ' (fatal)' : ''}`;
  result.durationMs = Date.now() - t0;
  result.runDir = runDir;
  log('result', result.summary);
  fs.writeFileSync(path.join(runDir, 'log.txt'), logLines.join('\n') + '\n');
  fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`run folder: ${runDir}`);
  process.exit(result.ok ? 0 : 1);
}

main();
