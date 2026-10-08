// settings.js - graphics/audio settings, presets, dynamic resolution, fps limiter, perf overlay,
// in-game settings menu and benchmark runner. Self-contained: injects its own DOM + CSS.
//
// Per frame the integrator does:
//   if (!limiter.shouldRender(now)) return;               // fpsCap
//   const s = dynRes.update(frameMs);                      // 0.5..1 extra scale
//   renderer.setPixelRatio(min(devicePixelRatio, settings.display.pixelRatioCap) * settings.display.renderScale * s);
//   overlay.update(frameMs, { res: [w, h], scale: s, drawCalls, triangles, particles });

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = o => JSON.parse(JSON.stringify(o));
const LS_KEY = 'tz_settings', BENCH_KEY = 'tz_bench';

// ---------------------------------------------------------------- defaults + schema
export const DEFAULTS = Object.freeze(deepFreeze({
  display: { renderScale: 0.85, pixelRatioCap: 1.25, fpsCap: 0, showFps: false, priority: 'balanced', targetFps: 60, dynamicRes: true },
  world: { drawDistance: 220, trees: 0.75, terrainDetail: 1 },
  effects: { particleBudget: 65536, waterSim: true, waterRes: 256, caveFluid: true, caveFluidRes: 128, explosionScale: 1 },
  retro: { retroLook: true, vertexSnap: 0.4, ditherStrength: 0.4, colorBits: 6, scanlines: 0.25, bloom: 0.4, chromaShift: 0.15 },
  pathTrace: { enabled: false, scale: 0.35, spp: 1, bounces: 2, accumulate: true },
  audio: { master: 0.8, music: 0.6, sfx: 0.8, audioQuality: 1 },
}));
function deepFreeze(o) { for (const k in o) if (typeof o[k] === 'object') deepFreeze(o[k]); return Object.freeze(o); }

const pct = v => Math.round(v * 100) + '%';
const fx = n => v => (+v).toFixed(n);
const lvl = ['LOW', 'MED', 'HIGH'];
// [key, label, type, min|options, max, step, fmt]
const SCHEMA = [
  ['display', 'DISPLAY', [
    ['renderScale', 'Render scale', 'range', 0.25, 1, 0.05, pct],
    ['pixelRatioCap', 'Pixel ratio cap', 'range', 1, 2, 0.25, fx(2)],
    ['fpsCap', 'FPS cap', 'enum', [0, 30, 60, 90, 120, 144], 0, 0, v => v ? v : 'OFF'],
    ['showFps', 'Show FPS overlay', 'bool'],
    ['priority', 'Priority', 'enum', ['fps', 'balanced', 'quality'], 0, 0, v => v.toUpperCase()],
    ['targetFps', 'Target FPS', 'range', 30, 144, 1, v => v],
    ['dynamicRes', 'Dynamic resolution', 'bool'],
  ]],
  ['world', 'WORLD', [
    ['drawDistance', 'Draw distance', 'range', 120, 600, 10, v => v + ' m'],
    ['trees', 'Tree density', 'range', 0, 1, 0.05, pct],
    ['terrainDetail', 'Terrain detail', 'range', 0, 2, 1, v => lvl[v]],
  ]],
  ['effects', 'EFFECTS', [
    ['particleBudget', 'Particle budget', 'pow2', 4096, 262144, 0, v => v >= 1024 ? (v / 1024) + 'K' : v],
    ['waterSim', 'Water simulation', 'bool'],
    ['waterRes', 'Water resolution', 'range', 64, 512, 64, v => v + '²'],
    ['caveFluid', 'Cave fluid', 'bool'],
    ['caveFluidRes', 'Cave fluid res', 'range', 64, 256, 32, v => v + '²'],
    ['explosionScale', 'Explosion scale', 'range', 0.5, 2, 0.05, fx(2)],
  ]],
  ['retro', 'RETRO (PS2 DEMAKE)', [
    ['retroLook', 'Retro look', 'bool'],
    ['vertexSnap', 'Vertex snap', 'range', 0, 1, 0.05, pct],
    ['ditherStrength', 'Dither', 'range', 0, 1, 0.05, pct],
    ['colorBits', 'Colour bits', 'range', 3, 8, 1, v => v + ' bpc'],
    ['scanlines', 'Scanlines', 'range', 0, 1, 0.05, pct],
    ['bloom', 'Bloom', 'range', 0, 1, 0.05, pct],
    ['chromaShift', 'Chroma shift', 'range', 0, 1, 0.05, pct],
  ]],
  ['pathTrace', 'PATH TRACING', [
    ['enabled', 'Path tracing', 'bool'],
    ['scale', 'PT resolution', 'range', 0.2, 1, 0.05, pct],
    ['spp', 'Samples / pixel', 'range', 1, 4, 1, v => v],
    ['bounces', 'Bounces', 'range', 1, 4, 1, v => v],
    ['accumulate', 'Accumulate', 'bool'],
  ]],
  ['audio', 'AUDIO', [
    ['master', 'Master volume', 'range', 0, 1, 0.05, pct],
    ['music', 'Music', 'range', 0, 1, 0.05, pct],
    ['sfx', 'Effects', 'range', 0, 1, 0.05, pct],
    ['audioQuality', 'Audio quality', 'range', 0, 2, 1, v => lvl[v]],
  ]],
];
const META = {};
for (const [g, , rows] of SCHEMA) for (const r of rows) META[g + '.' + r[0]] = { group: g, key: r[0], label: r[1], type: r[2], min: r[3], max: r[4], step: r[5], fmt: r[6] || (v => v ? 'ON' : 'OFF') };

function sanitize(path, v) {
  const m = META[path], d = getPath(DEFAULTS, path);
  if (!m) return v;
  if (m.type === 'bool') return typeof v === 'boolean' ? v : !!d;
  if (m.type === 'enum') return m.min.includes(v) ? v : d;
  v = +v; if (!isFinite(v)) return d;
  if (m.type === 'pow2') return 2 ** Math.round(Math.log2(clamp(v, m.min, m.max)));
  v = clamp(v, m.min, m.max);
  return m.step ? +(Math.round((v - m.min) / m.step) * m.step + m.min).toFixed(4) : v;
}
const getPath = (o, p) => p.split('.').reduce((a, k) => a?.[k], o);

// ---------------------------------------------------------------- presets
// Presets touch graphics only (display.fpsCap/showFps and audio are left alone).
export const PRESETS = {
  potato: {
    display: { renderScale: 0.5, pixelRatioCap: 1, priority: 'fps', targetFps: 60, dynamicRes: true },
    world: { drawDistance: 140, trees: 0.2, terrainDetail: 0 },
    effects: { particleBudget: 4096, waterSim: false, waterRes: 64, caveFluid: false, caveFluidRes: 64, explosionScale: 0.6 },
    retro: { retroLook: true, vertexSnap: 0.6, ditherStrength: 0.5, colorBits: 5, scanlines: 0, bloom: 0, chromaShift: 0 },
    pathTrace: { enabled: false, scale: 0.25, spp: 1, bounces: 1, accumulate: true },
  },
  low: {
    display: { renderScale: 0.65, pixelRatioCap: 1, priority: 'fps', targetFps: 60, dynamicRes: true },
    world: { drawDistance: 180, trees: 0.45, terrainDetail: 0 },
    effects: { particleBudget: 16384, waterSim: true, waterRes: 128, caveFluid: false, caveFluidRes: 64, explosionScale: 0.8 },
    retro: { retroLook: true, vertexSnap: 0.5, ditherStrength: 0.45, colorBits: 5, scanlines: 0.15, bloom: 0.2, chromaShift: 0 },
    pathTrace: { enabled: false, scale: 0.3, spp: 1, bounces: 1, accumulate: true },
  },
  medium: {
    display: { renderScale: 0.85, pixelRatioCap: 1.25, priority: 'balanced', targetFps: 60, dynamicRes: true },
    world: { drawDistance: 220, trees: 0.75, terrainDetail: 1 },
    effects: { particleBudget: 65536, waterSim: true, waterRes: 256, caveFluid: true, caveFluidRes: 128, explosionScale: 1 },
    retro: { retroLook: true, vertexSnap: 0.4, ditherStrength: 0.4, colorBits: 6, scanlines: 0.25, bloom: 0.4, chromaShift: 0.15 },
    pathTrace: { enabled: false, scale: 0.35, spp: 1, bounces: 2, accumulate: true },
  },
  high: {
    display: { renderScale: 1, pixelRatioCap: 1.5, priority: 'balanced', targetFps: 60, dynamicRes: true },
    world: { drawDistance: 320, trees: 1, terrainDetail: 2 },
    effects: { particleBudget: 131072, waterSim: true, waterRes: 384, caveFluid: true, caveFluidRes: 192, explosionScale: 1.25 },
    retro: { retroLook: true, vertexSnap: 0.35, ditherStrength: 0.35, colorBits: 6, scanlines: 0.25, bloom: 0.5, chromaShift: 0.2 },
    pathTrace: { enabled: false, scale: 0.4, spp: 1, bounces: 2, accumulate: true },
  },
  ultra: {
    display: { renderScale: 1, pixelRatioCap: 2, priority: 'quality', targetFps: 60, dynamicRes: false },
    world: { drawDistance: 450, trees: 1, terrainDetail: 2 },
    effects: { particleBudget: 262144, waterSim: true, waterRes: 512, caveFluid: true, caveFluidRes: 256, explosionScale: 1.5 },
    retro: { retroLook: true, vertexSnap: 0.3, ditherStrength: 0.3, colorBits: 7, scanlines: 0.2, bloom: 0.6, chromaShift: 0.2 },
    pathTrace: { enabled: false, scale: 0.5, spp: 2, bounces: 3, accumulate: true },
  },
  pathtraced: {
    display: { renderScale: 1, pixelRatioCap: 1, priority: 'balanced', targetFps: 45, dynamicRes: true },
    world: { drawDistance: 260, trees: 0.75, terrainDetail: 1 },
    effects: { particleBudget: 65536, waterSim: true, waterRes: 256, caveFluid: true, caveFluidRes: 128, explosionScale: 1 },
    retro: { retroLook: true, vertexSnap: 0.3, ditherStrength: 0.3, colorBits: 7, scanlines: 0.15, bloom: 0.35, chromaShift: 0.1 },
    pathTrace: { enabled: true, scale: 0.35, spp: 1, bounces: 2, accumulate: true },
  },
};
const PRESET_NAMES = Object.keys(PRESETS);

// ---------------------------------------------------------------- live object, events, persistence
export const settings = clone(DEFAULTS);
let presetName = 'medium';
const listeners = new Set();
export const onSettings = fn => { listeners.add(fn); return () => listeners.delete(fn); };
const emit = path => { for (const fn of [...listeners]) try { fn(settings, path); } catch (e) { console.warn('settings listener', e); } };
export const getPreset = () => presetName;   // 'custom' after a manual change

function assignAll(src) {   // merge src over current settings with sanitizing; returns true if anything changed
  let changed = false;
  for (const path in META) {
    const v = getPath(src, path);
    if (v === undefined) continue;
    const m = META[path], nv = sanitize(path, v);
    if (settings[m.group][m.key] !== nv) { settings[m.group][m.key] = nv; changed = true; }
  }
  return changed;
}

// Set one value by path ('display.renderScale'); emits (settings, path) and saves.
export function setSetting(path, v) {
  const m = META[path];
  if (!m) throw new Error('unknown setting ' + path);
  v = sanitize(path, v);
  if (settings[m.group][m.key] === v) return;
  settings[m.group][m.key] = v;
  if (!['display.showFps', 'display.fpsCap'].includes(path) && m.group !== 'audio') presetName = 'custom';
  saveSettings(); emit(path);
}

// Bulk changes (preset, reset, load) emit once with path '*'.
export function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) throw new Error('unknown preset ' + name);
  assignAll(p); presetName = name; saveSettings(); emit('*');
}
export function resetSettings() {
  assignAll(DEFAULTS); presetName = 'medium'; saveSettings(); emit('*');
}
export function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    assignAll(DEFAULTS);   // new keys get defaults, stale keys are ignored
    if (raw) { const o = JSON.parse(raw); assignAll(o); presetName = o._preset || 'custom'; }
  } catch (e) { console.warn('loadSettings', e); }
  emit('*');
  return settings;
}
export function saveSettings() {
  try { localStorage.setItem(LS_KEY, JSON.stringify({ ...settings, _preset: presetName })); } catch (e) { /* private mode */ }
}
loadSettings();

// ---------------------------------------------------------------- dynamic resolution
// update(frameMs) -> extra scale 0.5..1. frameMs = time between *rendered* frames.
// Effective target = min(targetFps, fpsCap). Drops when EMA frame time exceeds target by a priority-dependent
// margin; probes upward after a sustained period at target, backing off if the probe immediately fails.
const DYN = {
  fps: { down: 1.04, step: 0.08, coolDown: 0.25, upAfter: 2.0, upStep: 0.04, min: 0.5 },
  balanced: { down: 1.12, step: 0.06, coolDown: 0.5, upAfter: 3.0, upStep: 0.04, min: 0.5 },
  quality: { down: 1.35, step: 0.05, coolDown: 1.0, upAfter: 1.5, upStep: 0.05, min: 0.7 },
};
export function createDynRes({ getSettings = () => settings } = {}) {
  let scale = 1, ema = 0, sinceChange = 0, goodFor = 0, backoff = 1, lastUp = -1, t = 0;
  return {
    get scale() { return scale; },
    reset() { scale = 1; ema = 0; goodFor = 0; backoff = 1; },
    update(frameMs) {
      const d = getSettings().display;
      if (!d.dynamicRes || benchState.active && benchState.lockDyn) { scale = d.dynamicRes ? scale : 1; ema = 0; goodFor = 0; return scale; }
      if (!(frameMs > 0) || frameMs > 250) return scale;           // tab switch / hitch: ignore
      const p = DYN[d.priority] || DYN.balanced;
      const tgtFps = d.fpsCap ? Math.min(d.fpsCap, d.targetFps) : d.targetFps;
      const tgt = 1000 / tgtFps, dt = frameMs / 1000;
      t += dt; sinceChange += dt;
      ema = ema ? ema + (frameMs - ema) * 0.08 : frameMs;
      const r = ema / tgt;
      if (r > p.down && sinceChange > p.coolDown && scale > p.min) {
        // deeper miss -> bigger step (fps priority is the most aggressive)
        const k = clamp((r - 1) * 2, 1, 3);
        scale = Math.max(p.min, scale - p.step * k);
        if (t - lastUp < 3) backoff = Math.min(backoff * 2, 8);    // probe failed: wait longer next time
        sinceChange = 0; goodFor = 0;
      } else if (r < 1.03) {                                        // at/above target (vsync-limited reads ~1.0)
        goodFor += dt;
        if (goodFor > p.upAfter * backoff && scale < 1) {
          scale = Math.min(1, scale + p.upStep); lastUp = t; sinceChange = 0; goodFor = 0;
        }
        if (t - lastUp > 10) backoff = Math.max(1, backoff / 2);
      } else goodFor = Math.max(0, goodFor - dt);
      return scale;
    },
  };
}

// ---------------------------------------------------------------- frame limiter
const benchState = { active: false, lockDyn: false };
export function createFrameLimiter({ getSettings = () => settings } = {}) {
  let next = -1;
  return {
    shouldRender(now) {
      const cap = getSettings().display.fpsCap;
      if (!cap || benchState.active) { next = -1; return true; }
      const iv = 1000 / cap, tol = 1.5;                  // rAF jitter tolerance
      if (next < 0 || now - next > iv * 4) { next = now + iv; return true; }
      if (now < next - tol) return false;
      next += iv;                                        // keep the remainder: no drift
      if (next < now - tol) next = now + iv;
      return true;
    },
  };
}

// ---------------------------------------------------------------- CSS
let cssDone = false;
function injectCss() {
  if (cssDone) return; cssDone = true;
  const st = document.createElement('style');
  st.textContent = `
.tzs-perf{position:fixed;left:16px;top:108px;z-index:40;pointer-events:none;font:12px/1.35 Consolas,"Courier New",monospace;color:#9ff;text-shadow:0 0 4px #0cf;background:rgba(0,20,30,.45);border:1px solid #2a6a7a;padding:4px 6px}
.tzs-perf b{color:#fff}.tzs-perf canvas{display:block;margin-top:3px}
.tzs-menu,.tzs-bench{position:fixed;inset:0;z-index:60;display:flex;align-items:center;justify-content:center;background:rgba(0,8,20,.72);font-family:Consolas,"Courier New",monospace;color:#9ff;user-select:none}
.tzs-panel{width:min(720px,94vw);max-height:90vh;overflow:auto;border:1px solid #4aa;background:rgba(0,22,34,.9);box-shadow:0 0 24px #0af4;padding:14px 18px;text-shadow:0 0 5px #0cf}
.tzs-panel h2{margin:0 0 10px;font-size:26px;letter-spacing:6px;color:#fff;text-align:center;text-shadow:0 0 14px #0af}
.tzs-panel h3{margin:14px 0 4px;font-size:14px;letter-spacing:3px;color:#ff8;border-bottom:1px solid #2a6a7a;padding-bottom:2px}
.tzs-row{display:flex;align-items:center;gap:10px;padding:3px 6px;font-size:14px;border:1px solid transparent}
.tzs-row.f{border-color:#6df;background:rgba(0,170,255,.12)}
.tzs-row label{flex:0 0 190px}.tzs-row .v{flex:0 0 80px;text-align:right;color:#fff}
.tzs-row input[type=range]{flex:1;accent-color:#3cf;height:14px}
.tzs-btns{display:flex;flex-wrap:wrap;gap:6px;flex:1}
.tzs-b{font:inherit;font-size:13px;color:#9ff;background:rgba(0,40,60,.8);border:1px solid #3a8a9a;padding:3px 9px;cursor:pointer;letter-spacing:1px}
.tzs-b:hover{border-color:#9ff}.tzs-b.on{background:#0a6a8a;color:#fff;border-color:#9ff}.tzs-b.sel{outline:1px dashed #ff8}
.tzs-tog{min-width:56px}
.tzs-hint{margin-top:10px;font-size:12px;color:#7aa;text-align:center}
.tzs-bench pre{font:12px/1.4 Consolas,monospace;color:#cfe;margin:6px 0;white-space:pre-wrap}
.tzs-bench table{width:100%;border-collapse:collapse;font-size:12px}.tzs-bench td,.tzs-bench th{padding:2px 6px;text-align:right;border-bottom:1px solid #1a4a5a}
.tzs-bench th{color:#ff8;font-weight:normal}.tzs-bench td:first-child,.tzs-bench th:first-child{text-align:left}
.tzs-bench tr.cur td{color:#fff}
.tzs-run{position:fixed;left:50%;top:12px;transform:translateX(-50%);z-index:55;font:16px Consolas,monospace;color:#ff8;text-shadow:0 0 6px #fa0;letter-spacing:3px;pointer-events:none}
`;
  document.head.appendChild(st);
}
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const shield = root => { for (const t of ['mousedown', 'mouseup', 'click', 'wheel', 'pointerdown', 'pointerup', 'touchstart']) root.addEventListener(t, e => e.stopPropagation()); };

// ---------------------------------------------------------------- perf overlay
export function createPerfOverlay({ getSettings = () => settings } = {}) {
  injectCss();
  const root = el('div', 'tzs-perf'), txt = el('div'), cv = el('canvas');
  cv.width = 120; cv.height = 32; root.append(txt, cv); document.body.appendChild(root);
  const g = cv.getContext('2d'), hist = new Float32Array(120);
  let hi = 0, acc = 0, n = 0, shownFps = 0, shownMs = 0, lastText = 0;
  const api = {
    el: root,
    update(frameMs, info = {}) {
      const vis = getSettings().display.showFps || benchState.active;
      root.style.display = vis ? '' : 'none';
      if (!vis || !(frameMs > 0)) return;
      hist[hi] = frameMs; hi = (hi + 1) % 120; acc += frameMs; n++;
      const now = performance.now();
      if (now - lastText > 250) {
        shownMs = acc / n; shownFps = 1000 / shownMs; acc = 0; n = 0; lastText = now;
        const L = [`<b>${shownFps.toFixed(0)}</b> fps &nbsp;<b>${shownMs.toFixed(1)}</b> ms`];
        if (info.res) L.push(`res ${info.res[0]}x${info.res[1]}` + (info.scale != null ? ` &middot; dyn ${(info.scale * 100).toFixed(0)}%` : ''));
        else if (info.scale != null) L.push(`dyn ${(info.scale * 100).toFixed(0)}%`);
        const ex = [];
        if (info.particles != null) ex.push(`pt ${info.particles}`);
        if (info.drawCalls != null) ex.push(`dc ${info.drawCalls}`);
        if (info.triangles != null) ex.push(`tri ${info.triangles >= 1e3 ? (info.triangles / 1e3).toFixed(0) + 'k' : info.triangles}`);
        if (ex.length) L.push(ex.join(' &middot; '));
        txt.innerHTML = L.join('<br>');
      }
      // graph: 0..50 ms, lines at 16.7 / 33.3 ms
      g.clearRect(0, 0, 120, 32);
      g.fillStyle = 'rgba(0,30,40,.6)'; g.fillRect(0, 0, 120, 32);
      g.fillStyle = '#2a6a7a'; g.fillRect(0, 32 - 32 * 16.7 / 50, 120, 1); g.fillRect(0, 32 - 32 * 33.3 / 50, 120, 1);
      for (let i = 0; i < 120; i++) {
        const v = hist[(hi + i) % 120]; if (!v) continue;
        const h = Math.min(32, 32 * v / 50);
        g.fillStyle = v > 33.4 ? '#f52' : v > 17.5 ? '#fd2' : '#4f6';
        g.fillRect(i, 32 - h, 1, h);
      }
    },
    show(v) { root.style.display = v ? '' : 'none'; },
    destroy() { root.remove(); },
  };
  return api;
}

// ---------------------------------------------------------------- settings menu
export function createSettingsMenu({ onOpen, onClose, onBenchmark } = {}) {
  injectCss();
  const root = el('div', 'tzs-menu'); root.style.display = 'none';
  const panel = el('div', 'tzs-panel'); root.appendChild(panel); shield(root);
  document.body.appendChild(root);
  panel.appendChild(el('h2', '', 'SETTINGS'));
  const nav = [];   // { row, left(), right(), enter(), sync() }
  let focus = 0, isOpen = false, presetSel = 0, actSel = 0;

  // presets row
  panel.appendChild(el('h3', '', 'PRESET'));
  const pRow = el('div', 'tzs-row'), pBtns = el('div', 'tzs-btns');
  const pEls = PRESET_NAMES.map((n, i) => { const b = el('button', 'tzs-b', n.toUpperCase()); b.onclick = () => { presetSel = i; applyPreset(n); focusAt(nav.indexOf(pNav)); }; pBtns.appendChild(b); return b; });
  const pTag = el('span', 'v'); pRow.append(pBtns, pTag); panel.appendChild(pRow);
  const pNav = {
    row: pRow,
    left() { presetSel = (presetSel + PRESET_NAMES.length - 1) % PRESET_NAMES.length; this.sync(); },
    right() { presetSel = (presetSel + 1) % PRESET_NAMES.length; this.sync(); },
    enter() { applyPreset(PRESET_NAMES[presetSel]); },
    sync() {
      const cur = getPreset();
      pEls.forEach((b, i) => { b.classList.toggle('on', PRESET_NAMES[i] === cur); b.classList.toggle('sel', i === presetSel && nav[focus] === pNav); });
      pTag.textContent = cur === 'custom' ? 'CUSTOM' : '';
    },
  };
  nav.push(pNav);

  // groups
  for (const [g, title, rows] of SCHEMA) {
    panel.appendChild(el('h3', '', title));
    for (const r of rows) {
      const path = g + '.' + r[0], m = META[path];
      const row = el('div', 'tzs-row'), lab = el('label', '', m.label), val = el('span', 'v');
      row.appendChild(lab);
      const get = () => settings[g][r[0]];
      let item;
      if (m.type === 'bool') {
        const b = el('button', 'tzs-b tzs-tog'); b.onclick = () => { setSetting(path, !get()); focusAt(nav.indexOf(item)); };
        const box = el('div', 'tzs-btns'); box.appendChild(b); row.append(box, val);
        item = { row, left: () => setSetting(path, false), right: () => setSetting(path, true), enter: () => setSetting(path, !get()),
          sync() { b.textContent = get() ? 'ON' : 'OFF'; b.classList.toggle('on', get()); val.textContent = ''; } };
      } else if (m.type === 'enum') {
        const box = el('div', 'tzs-btns'), opts = m.min;
        const bs = opts.map(o => { const b = el('button', 'tzs-b', String(m.fmt(o))); b.onclick = () => { setSetting(path, o); focusAt(nav.indexOf(item)); }; box.appendChild(b); return b; });
        row.append(box, val);
        const step = d => setSetting(path, opts[clamp(opts.indexOf(get()) + d, 0, opts.length - 1)]);
        item = { row, left: () => step(-1), right: () => step(1), enter: () => setSetting(path, opts[(opts.indexOf(get()) + 1) % opts.length]),
          sync() { bs.forEach((b, i) => b.classList.toggle('on', opts[i] === get())); val.textContent = ''; } };
      } else {
        const pow = m.type === 'pow2', inp = el('input');
        inp.type = 'range';
        if (pow) { inp.min = Math.log2(m.min); inp.max = Math.log2(m.max); inp.step = 1; }
        else { inp.min = m.min; inp.max = m.max; inp.step = m.step; }
        inp.tabIndex = -1;
        inp.oninput = () => { setSetting(path, pow ? 2 ** +inp.value : +inp.value); focusAt(nav.indexOf(item), true); };
        row.append(inp, val);
        const step = d => setSetting(path, pow ? get() * (d > 0 ? 2 : 0.5) : get() + d * m.step);
        item = { row, left: () => step(-1), right: () => step(1), enter() {},
          sync() { inp.value = pow ? Math.log2(get()) : get(); val.textContent = m.fmt(get()); } };
      }
      row.addEventListener('mousedown', () => focusAt(nav.indexOf(item), true));
      nav.push(item);
      panel.appendChild(row);
    }
  }

  // actions
  panel.appendChild(el('h3', '', ''));
  const aRow = el('div', 'tzs-row'), aBox = el('div', 'tzs-btns');
  const acts = [['RUN BENCHMARK', () => runBench()], ['RESET TO DEFAULTS', () => resetSettings()], ['CLOSE', () => api.close()]];
  const aEls = acts.map(([t, f], i) => { const b = el('button', 'tzs-b', t); b.onclick = () => { actSel = i; f(); }; aBox.appendChild(b); return b; });
  aRow.appendChild(aBox); panel.appendChild(aRow);
  const aNav = {
    row: aRow,
    left() { actSel = (actSel + 2) % 3; this.sync(); }, right() { actSel = (actSel + 1) % 3; this.sync(); },
    enter() { acts[actSel][1](); },
    sync() { aEls.forEach((b, i) => b.classList.toggle('sel', i === actSel && nav[focus] === aNav)); },
  };
  nav.push(aNav);
  panel.appendChild(el('div', 'tzs-hint', '&uarr;&darr; select &middot; &larr;&rarr; change &middot; ENTER apply &middot; ESC / O close'));

  function syncAll() { for (const n of nav) n.sync(); }
  function focusAt(i, noScroll) {
    focus = clamp(i, 0, nav.length - 1);
    nav.forEach((n, j) => n.row.classList.toggle('f', j === focus));
    if (!noScroll) nav[focus].row.scrollIntoView({ block: 'nearest' });
    pNav.sync(); aNav.sync();
  }
  onSettings(() => { if (isOpen) syncAll(); });

  function runBench() {
    api.close();
    if (onBenchmark) onBenchmark();
    else runBenchmark({}, {});
  }

  // keyboard: capture phase so the game never sees keys while open
  addEventListener('keydown', e => {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    if (benchPanelOpen) return;
    const toggleKey = e.code === 'Escape' || e.code === 'KeyO';
    if (!isOpen) {
      if (toggleKey && !e.repeat && !benchState.active) { e.preventDefault(); e.stopImmediatePropagation(); api.open(); }
      return;
    }
    e.preventDefault(); e.stopImmediatePropagation();
    if (toggleKey) { if (!e.repeat) api.close(); return; }
    const n = nav[focus];
    const L = nav.length, mv = d => focusAt((focus + d + L) % L);
    if (e.code === 'ArrowUp' || e.code === 'KeyW') mv(-1);
    else if (e.code === 'ArrowDown' || e.code === 'KeyS' || e.code === 'Tab') mv(e.shiftKey ? -1 : 1);
    else if (e.code === 'ArrowLeft' || e.code === 'KeyA') n.left();
    else if (e.code === 'ArrowRight' || e.code === 'KeyD') n.right();
    else if ((e.code === 'Enter' || e.code === 'Space') && !e.repeat) n.enter();
  }, true);
  addEventListener('keypress', e => { if (isOpen) e.stopImmediatePropagation(); }, true);

  // optional gamepad: d-pad / stick navigate, A = enter, B / Start = close
  let padPrev = {}, padRaf = 0, padRep = 0;
  function padPoll(t) {
    if (!isOpen) return;
    padRaf = requestAnimationFrame(padPoll);
    const p = [...(navigator.getGamepads ? navigator.getGamepads() : [])].find(x => x && x.connected);
    if (!p) return;
    const b = i => !!(p.buttons[i] && p.buttons[i].pressed), ax = p.axes;
    const st = { u: b(12) || ax[1] < -0.6, d: b(13) || ax[1] > 0.6, l: b(14) || ax[0] < -0.6, r: b(15) || ax[0] > 0.6, a: b(0), x: b(1) || b(9) };
    const edge = k => st[k] && (!padPrev[k] || t > padRep);
    let hit = false;
    if (edge('u')) { focusAt(focus - 1); hit = true; } else if (edge('d')) { focusAt(focus + 1); hit = true; }
    if (edge('l')) { nav[focus].left(); hit = true; } else if (edge('r')) { nav[focus].right(); hit = true; }
    if (st.a && !padPrev.a) nav[focus].enter();
    if (st.x && !padPrev.x) api.close();
    if (hit) padRep = t + (Object.keys(padPrev).some(k => padPrev[k] && 'udlr'.includes(k)) ? 120 : 380);
    padPrev = st;
  }

  const api = {
    el: root,
    get isOpen() { return isOpen; },
    open() {
      if (isOpen) return;
      isOpen = true; root.style.display = 'flex';
      presetSel = Math.max(0, PRESET_NAMES.indexOf(getPreset()));
      syncAll(); focusAt(focus);
      padPrev = { a: true, x: true }; padRaf = requestAnimationFrame(padPoll);
      onOpen && onOpen();
    },
    close() {
      if (!isOpen) return;
      isOpen = false; root.style.display = 'none'; cancelAnimationFrame(padRaf);
      onClose && onClose();
    },
    toggle() { isOpen ? api.close() : api.open(); },
  };
  return api;
}

// ---------------------------------------------------------------- benchmark
let gpuCache;
export function gpuString() {
  if (gpuCache) return gpuCache;
  try {
    const c = document.createElement('canvas'), gl = c.getContext('webgl2') || c.getContext('webgl');
    const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
    gpuCache = gl ? (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) : 'no webgl';
    gl && gl.getExtension('WEBGL_lose_context')?.loseContext();
  } catch (e) { gpuCache = 'unknown'; }
  return gpuCache;
}
const pctl = (s, p) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1))];
export function benchStats(ms) {
  const s = Float64Array.from(ms).sort(), n = s.length, sum = ms.reduce((a, b) => a + b, 0);
  if (!n) return { frames: 0 };
  const r2 = v => Math.round(v * 100) / 100;
  return {
    frames: n, seconds: r2(sum / 1000), avgFps: r2(n * 1000 / sum), avgMs: r2(sum / n),
    medianMs: r2(pctl(s, 0.5)), medianFps: r2(1000 / pctl(s, 0.5)),
    low1Fps: r2(1000 / pctl(s, 0.99)), low01Fps: r2(1000 / pctl(s, 0.999)),
    minMs: r2(s[0]), maxMs: r2(s[n - 1]),
  };
}
export const benchHistory = () => { try { return JSON.parse(localStorage.getItem(BENCH_KEY) || '[]'); } catch (e) { return []; } };

// hooks: { begin(), step(t01, dt), end() }. Frame limiter is bypassed and dyn-res frozen while running.
export function runBenchmark(hooks = {}, { seconds = 20, warmup = 1, showResult = true } = {}) {
  injectCss();
  if (benchState.active) return Promise.reject(new Error('benchmark already running'));
  benchState.active = true; benchState.lockDyn = true;
  const banner = el('div', 'tzs-run'); document.body.appendChild(banner);
  return new Promise((resolve, reject) => {
    const ms = [];
    let t0 = -1, prev = -1;
    try { hooks.begin && hooks.begin(); } catch (e) { finish(e); return; }
    function tick(now) {
      if (t0 < 0) { t0 = prev = now; requestAnimationFrame(tick); return; }
      const dt = now - prev, sec = (now - t0) / 1000; prev = now;
      if (sec > warmup) ms.push(dt);
      const total = seconds + warmup;
      banner.textContent = `BENCHMARK ${Math.min(total, sec).toFixed(1)} / ${total.toFixed(0)} s`;
      try { hooks.step && hooks.step(clamp(sec / total, 0, 1), dt / 1000); } catch (e) { finish(e); return; }
      if (sec >= total) finish(); else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
    function finish(err) {
      benchState.active = false; benchState.lockDyn = false; banner.remove();
      try { hooks.end && hooks.end(); } catch (e) { err = err || e; }
      if (err) { reject(err); return; }
      const res = {
        ...benchStats(ms), preset: getPreset(), date: new Date().toISOString(),
        settings: clone(settings), userAgent: navigator.userAgent, gpu: gpuString(),
        screen: [innerWidth, innerHeight, devicePixelRatio], hist: histogram(ms),
      };
      const h = benchHistory(); h.unshift(res);
      try { localStorage.setItem(BENCH_KEY, JSON.stringify(h.slice(0, 10))); } catch (e) { /* ignore */ }
      if (showResult) showBenchResult(res);
      resolve(res);
    }
  });
}
function histogram(ms) {   // 1 ms bins 0..49, last bin = 50+
  const h = new Array(51).fill(0);
  for (const v of ms) h[Math.min(50, Math.floor(v))]++;
  return h;
}
export function benchText(r) {
  const s = r.settings, d = s.display;
  return [
    `THRUST/ZARCH BENCHMARK  ${r.date}`,
    `preset ${r.preset}  frames ${r.frames} in ${r.seconds}s`,
    `avg ${r.avgFps} fps (${r.avgMs} ms)  median ${r.medianFps} fps (${r.medianMs} ms)`,
    `1% low ${r.low1Fps} fps  0.1% low ${r.low01Fps} fps  min ${r.minMs} ms  max ${r.maxMs} ms`,
    `render ${d.renderScale} x pr<=${d.pixelRatioCap}  dynRes ${d.dynamicRes} (${d.priority}, ${d.targetFps})  draw ${s.world.drawDistance} m`,
    `particles ${s.effects.particleBudget}  water ${s.effects.waterSim ? s.effects.waterRes : 'off'}  caveFluid ${s.effects.caveFluid ? s.effects.caveFluidRes : 'off'}`,
    `retro ${s.retro.retroLook}  pathTrace ${s.pathTrace.enabled ? `on ${s.pathTrace.scale} ${s.pathTrace.spp}spp ${s.pathTrace.bounces}b` : 'off'}`,
    `screen ${r.screen?.join('x')}`,
    `GPU ${r.gpu}`,
    `UA ${r.userAgent}`,
  ].join('\n');
}
let benchPanelOpen = false;
export function showBenchResult(r) {
  injectCss();
  const root = el('div', 'tzs-bench'), panel = el('div', 'tzs-panel'); root.appendChild(panel); shield(root);
  panel.appendChild(el('h2', '', 'BENCHMARK'));
  panel.appendChild(el('pre', '', benchText(r).replace(/</g, '&lt;')));
  const cv = el('canvas'); cv.width = 660; cv.height = 110; cv.style.width = '100%'; panel.appendChild(cv);
  const g = cv.getContext('2d'), h = r.hist || [], mx = Math.max(1, ...h), bw = cv.width / h.length;
  g.fillStyle = 'rgba(0,30,40,.7)'; g.fillRect(0, 0, cv.width, cv.height);
  h.forEach((c, i) => { const hh = (cv.height - 14) * c / mx; g.fillStyle = i >= 34 ? '#f52' : i >= 17 ? '#fd2' : '#4f6'; g.fillRect(i * bw + 1, cv.height - 14 - hh, bw - 2, hh); });
  g.fillStyle = '#7aa'; g.font = '10px Consolas,monospace';
  for (const t of [0, 8, 16, 25, 33, 50]) g.fillText(t + (t === 50 ? '+' : '') + 'ms', Math.min(t * bw, cv.width - 34), cv.height - 3);
  panel.appendChild(el('h3', '', 'LAST 10 RUNS'));
  const rows = benchHistory().map(b => `<tr class="${b.date === r.date ? 'cur' : ''}"><td>${b.date.slice(5, 16).replace('T', ' ')}</td><td>${b.preset}</td><td>${b.settings?.display?.renderScale}</td><td>${b.avgFps}</td><td>${b.medianFps}</td><td>${b.low1Fps}</td><td>${b.low01Fps}</td><td>${b.maxMs}</td></tr>`).join('');
  panel.appendChild(el('table', '', `<tr><th>date</th><th>preset</th><th>scale</th><th>avg</th><th>median</th><th>1% low</th><th>0.1% low</th><th>max ms</th></tr>${rows}`));
  const bx = el('div', 'tzs-btns'); bx.style.marginTop = '10px';
  const copy = el('button', 'tzs-b', 'COPY AS TEXT'), close = el('button', 'tzs-b', 'CLOSE');
  copy.onclick = async () => {
    const t = benchText(r);
    try { await navigator.clipboard.writeText(t); } catch (e) {
      const ta = el('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } catch (e2) { /* ignore */ } ta.remove();
    }
    copy.textContent = 'COPIED';
  };
  const done = () => { root.remove(); benchPanelOpen = false; removeEventListener('keydown', kh, true); };
  close.onclick = done;
  const kh = e => { e.stopImmediatePropagation(); e.preventDefault(); if (['Escape', 'Enter', 'KeyO', 'Space'].includes(e.code)) done(); };
  addEventListener('keydown', kh, true);
  bx.append(copy, close); panel.appendChild(bx);
  document.body.appendChild(root); benchPanelOpen = true;
  return { close: done };
}
