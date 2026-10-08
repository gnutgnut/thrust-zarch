// SID-style (MOS 6581) synth, SFX and adaptive music for Thrust/Zarch. Web Audio only.
//
// Public API (class Sfx):
//   new Sfx(ctx?)          optional AudioContext / OfflineAudioContext to render into (tests)
//   init()                 create / resume audio; call on a user gesture; safe to call repeatedly
//   ready                  Promise, resolves when the active backend (worklet or node fallback) is up
//   engine(l)              player thrust rumble, l 0..1, call every frame
//   shot() enemyShot() pickup() dock() boom(big=1) hit() refuel() alarm()
//   beam(on)               tractor beam hum, continuous while on
//   enemyEngine(d)         saucer proximity whine, d 0 (near) .. 1 (far / none); fades if not called
//   waveStart(n) baseDestroyed() ui('move'|'select'|'back')
//   music(on)              procedural soundtrack on/off (on by default)
//   setMood(x)             0 = open sky (major, bright), 1 = cave (minor, filtered, echo); glides
//   setIntensity(x)        0..1 tempo / density
//   setVolume({ master, music, sfx })   0..1 each, any subset
//   setQuality(l)          0 minimal (no worklet/echo, fewer voices), 1 normal, 2 full (stereo echo, more voices)

const T = 1, S = 2, P = 4, N = 8; // waveforms: triangle, saw, pulse, noise (combine = mix)
const LP = 1, BP = 2, HP = 4; // filter modes
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const clamp = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x;
const lerp = (a, b, k) => a + (b - a) * k;
const elerp = (a, b, k) => a * Math.pow(b / a, k);
const pick = (r, a) => a[Math.floor(r() * a.length)];
const rng = seed => () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };

// Voice spec (shared by both backends):
//  w wave bits | f f1 ft: freq sweep (exp) | pw pw1: pulse width (+sweep over dur) | pr pd: PWM lfo rate/depth
//  vd vr vdl: vibrato semis/rate/delay | arp ar: semitone table + rate | a d s r dur v: ADSR, gate, volume
//  m m1: modulator freq (swept over ft) for ring / sync | sw { t w f f1 ft }: waveform switch at t (drums)
//  fl { m c c1 ct q cr cd }: per-voice filter | filt: music voice routed through the shared filter
// Held voices take live params [f, v, cutoff, pw, m], smoothed.
const HELD = {
  engN: { w: N, fl: { m: LP, q: .35 } },
  engP: { w: P, pr: 5, pd: .2, fl: { m: LP, q: .5 } },
  beam: { w: P, ring: 1, pr: .7, pd: .3, vd: .25, vr: 5, fl: { m: BP, q: .55, cr: .9, cd: .8 } },
  enemy: { w: S, vd: .6, vr: 9, fl: { m: BP, q: .5 } },
};

// ---------------------------------------------------------------- worklet: the chip
const PROC = `
const CR = 32, TAU = 6.283185307;
const blep = (t, dt) => { if (t < dt) { t /= dt; return t + t - t * t - 1; } if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; } return 0; };
const ex = (a, b, k) => a * Math.pow(b / a, k);
class F { // TPT state-variable filter with a little 6581-ish grit in the band state
  constructor() { this.i1 = this.i2 = 0; this.coef(1000, .3); }
  coef(c, q) { const g = Math.tan(Math.PI * Math.min(Math.max(c, 20), sampleRate * .45) / sampleRate); this.k = 2 - 1.9 * Math.min(q, .98); this.a1 = 1 / (1 + g * (g + this.k)); this.a2 = g * this.a1; this.a3 = g * this.a2; }
  run(x, m) {
    const v3 = x - this.i2, v1 = this.a1 * this.i1 + this.a2 * v3, v2 = this.i2 + this.a2 * this.i1 + this.a3 * v3, b = 2 * v1 - this.i1;
    this.i1 = b / (1 + .08 * Math.abs(b)); this.i2 = 2 * v2 - this.i2;
    return (m & 1 ? v2 : 0) + (m & 2 ? v1 : 0) + (m & 4 ? x - this.k * v1 - v2 : 0);
  }
}
class V {
  constructor() { this.ph = this.mph = this.nc = this.nz = this.env = this.st = this.t = this.cr = this.age = this.inc = this.minc = this.vol = this.w = 0; this.pw = .5; this.lf = 0x7ffff8; this.s = this.h = this.f = null; }
  note(s, age) {
    const sr = sampleRate; this.s = s; this.h = null; this.t = 0; this.age = age; this.st = 1; this.w = s.w;
    this.ai = s.a > 0 ? 1 / (s.a * sr) : 1; this.dk = Math.exp(-4 / ((s.d || .1) * sr)); this.sl = s.s || 0; this.rk = Math.exp(-4 / ((s.r || .05) * sr));
    this.vol = s.v == null ? .3 : s.v; this.sync = !!s.sync; this.ring = !!s.ring; if (this.sync) this.ph = this.mph = 0;
    if (s.fl) { this.f = this.f || new F(); this.f.i1 = this.f.i2 = 0; this.fm = s.fl.m || 1; } else this.f = null;
    this.ctl(); this.cr = CR;
  }
  hold(s, p) {
    if (s) { this.s = s; this.h = { c: p.slice(), g: p }; this.h.c[1] = 0; this.st = 2; this.env = this.sl = this.dk = 1; this.w = s.w; this.t = 0; this.cr = CR;
      this.sync = !!s.sync; this.ring = !!s.ring; this.f = s.fl ? new F() : null; this.fm = s.fl ? s.fl.m || 1 : 0; }
    else if (this.h) this.h.g = p;
  }
  ctl() {
    const s = this.s, t = this.t, h = this.h; let f, pw = s.pw == null ? .5 : s.pw, c = 0, m = s.m || 0;
    if (h) { const C = h.c, G = h.g; for (let i = 0; i < 5; i++) C[i] += (G[i] - C[i]) * .06; f = C[0]; this.vol = C[1]; c = C[2]; pw = C[3]; m = C[4]; }
    else {
      let f1 = s.f1, ft = s.ft, tt = t; const q = s.sw; f = s.f; this.w = s.w;
      if (q && t >= q.t) { this.w = q.w; tt = t - q.t; if (q.f) { f = q.f; f1 = q.f1; ft = q.ft; } }
      if (f1 && ft) f = tt < ft ? ex(f, f1, tt / ft) : f1;
      if (s.m1 && s.ft) m = t < s.ft ? ex(m, s.m1, t / s.ft) : s.m1;
      if (s.pw1 != null) pw += (s.pw1 - pw) * Math.min(1, t / (s.dur || 1));
      if (s.arp) f *= Math.pow(2, s.arp[Math.floor(t * s.ar) % s.arp.length] / 12);
      if (s.fl) { const L = s.fl; c = L.c; if (L.c1) c = t < L.ct ? ex(c, L.c1, t / L.ct) : L.c1; }
      if (this.st && this.st < 3 && t >= (s.dur || 0)) this.st = 3;
    }
    if (s.vd) { const k = s.vdl ? Math.min(1, Math.max(0, (t - s.vdl) * 4)) : 1; f *= Math.pow(2, s.vd * k * Math.sin(TAU * s.vr * t) / 12); }
    if (s.pd) pw += s.pd * Math.sin(TAU * s.pr * t);
    this.pw = pw < .03 ? .03 : pw > .97 ? .97 : pw;
    this.inc = Math.min(.45, Math.max(0, f) / sampleRate); this.minc = m / sampleRate;
    if (this.f) { const L = s.fl; if (L.cd) c *= Math.pow(2, L.cd * Math.sin(TAU * L.cr * t)); this.f.coef(c, L.q == null ? .3 : L.q); }
  }
  run(out, a, b) {
    if (this.h && this.h.g[1] < 1e-4 && this.h.c[1] < 1e-4) { this.h.c[1] = 0; return; }
    const sync = this.sync, flt = this.f, dtc = CR / sampleRate;
    for (let i = a; i < b; i++) {
      if (--this.cr <= 0) { this.cr = CR; this.t += dtc; this.ctl(); }
      if (this.st === 1) { this.env += this.ai; if (this.env >= 1) { this.env = 1; this.st = 2; } }
      else if (this.st === 2) { this.env = this.sl + (this.env - this.sl) * this.dk; if (this.sl === 0 && this.env < 1e-4) { this.st = this.env = 0; return; } }
      else if (this.st === 3) { this.env *= this.rk; if (this.env < 1e-4) { this.st = this.env = 0; return; } }
      else return;
      const inc = this.inc, w = this.w; let ph = this.ph + inc, wm = false;
      if (this.minc) { this.mph += this.minc; if (this.mph >= 1) { this.mph -= 1; wm = true; } }
      if (ph >= 1) ph -= 1;
      if (wm && sync) ph = this.mph * inc / this.minc;
      this.ph = ph;
      let y = 0, n = 0;
      if (w & 1) { y += ph < .5 ? 4 * ph - 1 : 3 - 4 * ph; n++; }
      if (w & 2) { y += 2 * ph - 1 - (sync ? 0 : blep(ph, inc)); n++; }
      if (w & 4) { const pw = this.pw; let p = ph < pw ? 1 : -1; if (!sync) { let q = ph - pw; if (q < 0) q += 1; p += blep(ph, inc) - blep(q, inc); } y += p; n++; }
      if (w & 8) { this.nc += inc * 8; while (this.nc >= 1) { this.nc -= 1; const l = this.lf; this.lf = ((l << 1) | (((l >> 22) ^ (l >> 17)) & 1)) & 0x7fffff; this.nz = (this.lf & 255) / 127.5 - 1; } y += this.nz; n++; }
      if (n > 1) y /= n;
      if (this.ring && this.mph >= .5) y = -y;
      if (flt) y = flt.run(y, this.fm);
      out[i] += y * this.env * this.vol;
    }
  }
}
class Sid extends AudioWorkletProcessor {
  constructor() {
    super(); this.mv = [new V(), new V(), new V()]; this.sv = []; this.hv = {}; this.q = []; this.cap = 8; this.age = 0; this.live = true;
    this.mf = new F(); this.mc = [4000, .2]; this.mt = [4000, .2]; this.hold = 2; this.qn = 512; this.hc = this.ha = this.hb = 0; this.bf = [];
    this.port.onmessage = e => { for (const m of e.data) this.msg(m); };
  }
  msg(m) {
    if (m.k === 'n') { const q = this.q; let i = q.length; while (i && q[i - 1].t > m.t) i--; q.splice(i, 0, m); }
    else if (m.k === 'h') (this.hv[m.n] || (this.hv[m.n] = new V())).hold(m.s, m.p);
    else if (m.k === 'mf') { this.mt[0] = m.c; this.mt[1] = m.q; }
    else if (m.k === 'cfg') { this.cap = m.cap; this.hold = m.hold; this.qn = m.bits ? Math.pow(2, m.bits - 1) : 0; if (this.sv.length > m.cap) this.sv.length = m.cap; }
    else if (m.k === 'mo') { for (const v of this.mv) if (v.st && !v.h) v.st = 3; this.q = this.q.filter(e => e.b); }
    else if (m.k === 'x') this.live = false;
  }
  fire(e) {
    let v = null;
    if (e.b === 0) v = this.mv[e.i];
    else {
      for (const x of this.sv) if (!x.st) { v = x; break; }
      if (!v) { if (this.sv.length < this.cap) this.sv.push(v = new V()); else { v = this.sv[0]; for (const x of this.sv) if (x.age < v.age) v = x; } }
    }
    v.note(e.s, ++this.age);
  }
  render(a, b) {
    const [md, mf, sx] = this.bf;
    for (const v of this.mv) if (v.st) v.run(v.s.filt ? mf : md, a, b);
    for (const v of this.sv) if (v.st) v.run(sx, a, b);
    for (const k in this.hv) { const v = this.hv[k]; if (v.st) v.run(sx, a, b); }
  }
  process(_, out) {
    if (!this.live) return false;
    const o0 = out[0][0], o1 = out[1][0]; if (!o0) return true;
    const n = o0.length, sr = sampleRate;
    if (!this.bf.length || this.bf[0].length !== n) this.bf = [new Float32Array(n), new Float32Array(n), new Float32Array(n)];
    const [md, mf, sx] = this.bf; md.fill(0); mf.fill(0); sx.fill(0);
    const q = this.q, t0 = currentTime, t1 = t0 + n / sr; let p = 0;
    while (q.length && q[0].t < t1) { const e = q.shift(), o = Math.min(n, Math.max(p, Math.round((e.t - t0) * sr))); if (o > p) { this.render(p, o); p = o; } this.fire(e); }
    if (p < n) this.render(p, n);
    const C = this.mc, G = this.mt, F = this.mf, h = this.hold, qn = this.qn;
    C[0] += (G[0] - C[0]) * .08; C[1] += (G[1] - C[1]) * .08; F.coef(C[0], C[1]);
    for (let i = 0; i < n; i++) {
      const a = md[i] + F.run(mf[i], 1), b = sx[i];
      if (++this.hc >= h) { this.hc = 0; this.ha = qn ? Math.round(a * qn) / qn : a; this.hb = qn ? Math.round(b * qn) / qn : b; }
      o0[i] = this.ha; o1[i] = this.hb;
    }
    return true;
  }
}
registerProcessor('sid6581', Sid);
`;

class WkSid {
  constructor(c, cfg) {
    this.n = new AudioWorkletNode(c, 'sid6581', { numberOfInputs: 0, numberOfOutputs: 2, outputChannelCount: [1, 1] });
    this.musicOut = c.createGain(); this.sfxOut = c.createGain(); this.n.connect(this.musicOut, 0); this.n.connect(this.sfxOut, 1);
    this.hs = {}; this.qm = []; this.p({ k: 'cfg', ...cfg });
  }
  p(m) { // batch everything posted in one task into a single message
    if (!this.qm.length) queueMicrotask(() => { this.n.port.postMessage(this.qm); this.qm = []; });
    this.qm.push(m);
  }
  note(b, i, s, t) { this.p({ k: 'n', b, i, s, t }); }
  hold(n, s, p) { this.p({ k: 'h', n, s: this.hs[n] ? null : (this.hs[n] = 1, s), p }); }
  mus(c, q) { this.p({ k: 'mf', c, q }); }
  musOff() { this.p({ k: 'mo' }); }
  dispose() { this.p({ k: 'x' }); this.n.disconnect(); this.musicOut.disconnect(); this.sfxOut.disconnect(); }
}

// ---------------------------------------------------------------- fallback: native nodes per note
const FTYPE = { 1: 'lowpass', 2: 'bandpass', 4: 'highpass' };
class NodeSid {
  constructor(c, noise, cap) {
    this.c = c; this.noise = noise; this.cap = cap; this.act = []; this.mv = [null, null, null]; this.hv = {}; this.pws = {};
    this.musicOut = c.createGain(); this.sfxOut = c.createGain();
    this.mf = c.createBiquadFilter(); this.mf.type = 'lowpass'; this.mf.connect(this.musicOut);
  }
  pulse(pw) {
    const k = Math.round(clamp(pw, .06, .94) * 16);
    if (!this.pws[k]) { const re = new Float32Array(32), im = new Float32Array(32); for (let i = 1; i < 32; i++) re[i] = 2 / (i * Math.PI) * Math.sin(i * Math.PI * k / 16); this.pws[k] = this.c.createPeriodicWave(re, im); }
    return this.pws[k];
  }
  src(w, f, pw, t) { // -> [node, freqParam, map]
    const c = this.c;
    if (w & N) { const s = c.createBufferSource(), m = x => clamp(x / 3000, .02, 4); s.buffer = this.noise; s.loop = true; s.playbackRate.setValueAtTime(m(f), t); return [s, s.playbackRate, m]; }
    const o = c.createOscillator(); if (w & P) o.setPeriodicWave(this.pulse(pw)); else o.type = w & S ? 'sawtooth' : 'triangle';
    o.frequency.setValueAtTime(f, t); return [o, o.frequency, x => x];
  }
  filt(L, t) {
    const F = this.c.createBiquadFilter(), q = L.q == null ? .3 : L.q; F.type = FTYPE[L.m] || 'lowpass';
    F.Q.value = F.type === 'bandpass' ? .7 + q * 8 : q * 16; F.frequency.setValueAtTime(L.c, t);
    if (L.c1) F.frequency.exponentialRampToValueAtTime(L.c1, t + (L.ct || .1)); return F;
  }
  lfo(param, rate, depth, rec) { const l = this.c.createOscillator(), g = this.c.createGain(); l.frequency.value = rate; g.gain.value = depth; l.connect(g); g.connect(param); rec.nodes.push(l, g); rec.srcs.push(l); }
  kill(r, t) { if (r.dead) return; r.dead = true; const G = r.g.gain; G.cancelScheduledValues(t); G.setTargetAtTime(0, t, .004); for (const s of r.srcs) try { s.stop(t + .03); } catch (e) { /* already stopped */ } }
  note(b, i, s, t) {
    const c = this.c, now = c.currentTime; t = Math.max(t || 0, now);
    if (b === 0) { const o = this.mv[i]; if (o && o.end > t) this.kill(o, t); }
    else { this.act = this.act.filter(r => r.end > now && !r.dead); while (this.act.length >= this.cap) this.kill(this.act.shift(), now); }
    const v = s.v == null ? .3 : s.v, A = s.a || .002, D = s.d || .1, Sl = s.s || 0, R = s.r || .05, gate = Math.max(s.dur || 0, A);
    const end = t + (Sl > 0 ? gate + R : Math.min(gate + R, A + D * 1.3)) + .03;
    const g = c.createGain(), rec = { g, nodes: [g], srcs: [], end }; let dst = g;
    if (s.ring && s.m) { const r = c.createGain(), mo = c.createOscillator(); r.gain.value = 0; mo.type = 'square'; mo.frequency.setValueAtTime(s.m, t); if (s.m1) mo.frequency.exponentialRampToValueAtTime(s.m1, t + (s.ft || .1)); mo.connect(r.gain); r.connect(dst); dst = r; rec.nodes.push(r, mo); rec.srcs.push(mo); }
    if (s.fl) { const F = this.filt(s.fl, t); F.connect(dst); dst = F; rec.nodes.push(F); }
    const q = s.sw, segs = q ? [[s.w, s.f, s.f1, s.ft, 0, q.t], [q.w, q.f || s.f, q.f1, q.ft, q.t, 0]] : [[s.w, s.f, s.f1, s.ft, 0, 0]];
    let last = null;
    for (const [w, f, f1, ft, a, z] of segs) {
      const [o, p, m] = this.src(w, f, s.pw == null ? .5 : s.pw, t + a), t0 = t + a;
      if (s.arp) { const n = Math.min(40, Math.ceil((end - t0) * s.ar)); for (let k = 1; k < n; k++) p.setValueAtTime(m(f * Math.pow(2, s.arp[k % s.arp.length] / 12)), t0 + k / s.ar); p.setValueAtTime(m(f * Math.pow(2, s.arp[0] / 12)), t0); }
      else if (f1) p.exponentialRampToValueAtTime(m(f1), t0 + (ft || .1));
      o.connect(dst); o.start(t0); o.stop(z ? t + z : end); rec.nodes.push(o); rec.srcs.push(o); last = o;
    }
    const G = g.gain; G.setValueAtTime(0, t); G.linearRampToValueAtTime(v, t + A); G.setTargetAtTime(v * Sl, t + A, D / 4); G.setTargetAtTime(0, t + gate, R / 4);
    g.connect(b === 0 ? (s.filt ? this.mf : this.musicOut) : this.sfxOut);
    last.onended = () => { for (const n of rec.nodes) n.disconnect(); rec.dead = true; };
    if (b === 0) this.mv[i] = rec; else this.act.push(rec);
  }
  hold(n, s, p) {
    const c = this.c, t = c.currentTime; let h = this.hv[n];
    if (!h) {
      const [o, prm, map] = this.src(s.w, p[0] || 1, p[3], t), G = c.createGain(); G.gain.value = 0;
      h = this.hv[n] = { prm, map, G, nodes: [o, G], srcs: [o] }; let dst = G;
      if (s.ring) { const r = c.createGain(), mo = c.createOscillator(); r.gain.value = 0; mo.type = 'square'; mo.frequency.value = p[4] || 1; mo.connect(r.gain); r.connect(dst); dst = r; h.mo = mo; h.nodes.push(r, mo); h.srcs.push(mo); }
      if (s.fl) { h.F = this.filt({ ...s.fl, c: p[2] || 500 }, t); h.F.connect(dst); dst = h.F; h.nodes.push(h.F); if (s.fl.cd) this.lfo(h.F.detune, s.fl.cr, s.fl.cd * 1200, h); }
      if (s.vd) this.lfo(o.detune, s.vr, s.vd * 100, h);
      o.connect(dst); G.connect(this.sfxOut); for (const x of h.srcs) x.start(t);
    }
    h.prm.setTargetAtTime(h.map(Math.max(1, p[0])), t, .03); h.G.gain.setTargetAtTime(p[1], t, .03);
    if (h.F) h.F.frequency.setTargetAtTime(Math.max(20, p[2]), t, .03);
    if (h.mo) h.mo.frequency.setTargetAtTime(Math.max(1, p[4]), t, .03);
  }
  mus(c, q) { const t = this.c.currentTime; this.mf.frequency.setTargetAtTime(c, t, .05); this.mf.Q.setTargetAtTime(q * 16, t, .05); }
  musOff() { const t = this.c.currentTime; for (const r of this.mv) if (r) this.kill(r, t); }
  dispose() {
    const t = this.c.currentTime; this.musOff(); for (const r of this.act) this.kill(r, t);
    for (const k in this.hv) { const h = this.hv[k]; for (const s of h.srcs) try { s.stop(); } catch (e) { /* ok */ } for (const n of h.nodes) n.disconnect(); }
    this.hv = {}; this.mf.disconnect(); this.musicOut.disconnect(); this.sfxOut.disconnect();
  }
}

// ---------------------------------------------------------------- music material
const ROOT = 38; // D2
const MAJOR = [0, 2, 4, 5, 7, 9, 11], LYD = [0, 2, 4, 6, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10], PHRY = [0, 1, 3, 5, 7, 8, 10];
const PROG_S = [[0, 4, 5, 3], [0, 5, 3, 4], [0, 3, 4, 4], [5, 3, 0, 4], [0, 1, 3, 4], [0, 4, 3, 3]];
const PROG_C = [[0, 5, 3, 4], [0, 6, 5, 6], [0, 3, 0, 4], [0, 1, 0, 6], [0, 5, 6, 4], [0, 0, 5, 1]];
// x root, o octave, f fifth, p chromatic approach to next chord, . rest
const BASS_S = ['x.xox.xox.xox.xo', 'x.x.o.x.x.x.o.xp', 'xxo.xxo.xxo.xxop', 'x..xo.x.x..xo.x.', 'xoxoxoxoxoxoxofp'];
const BASS_C = ['x.....x...x.....', 'x..x..x.....x..p', 'x.......f.......', 'x..xo..xx..xo..p', 'x...x...x...f..p'];
const DRUMS = [{ k: [0, 8], s: [4, 12] }, { k: [0, 6, 8], s: [4, 12] }, { k: [0, 3, 8, 11], s: [4, 12] }, { k: [0, 10], s: [4, 12, 14] }];
const KICK = { w: N, f: 3000, sw: { t: .008, w: T, f: 150, f1: 38, ft: .1 }, a: 0, d: .16, s: 0, dur: .2, v: .55 };
const SNARE = { w: T, f: 240, f1: 170, ft: .02, sw: { t: .014, w: N, f: 3800, f1: 1500, ft: .14 }, a: 0, d: .14, s: 0, dur: .2, v: .4 };
const TOM = { w: N, f: 2000, sw: { t: .006, w: T, f: 140, f1: 70, ft: .2 }, a: 0, d: .25, s: 0, dur: .3, v: .42 };
const HAT = { w: N, f: 12000, a: 0, d: .035, s: 0, dur: .05, v: .15 };
const motif = r => { // 2 bars of 16ths: { d: scale degree offset from chord root, l: steps }
  const o = new Array(32).fill(null); let p = 0, d = pick(r, [0, 2, 4]);
  while (p < 32) {
    const l = Math.min(pick(r, [1, 2, 2, 2, 3, 4, 4, 6]), 32 - p);
    if (p && r() < .22) { p += l; continue; }
    if (p % 8 === 0) d = pick(r, [0, 2, 4, 7]);
    o[p] = { d, l }; d = clamp(d + pick(r, [-2, -1, -1, 1, 1, 2, 3, -3]), -3, 9); p += l;
  }
  return o;
};

// ---------------------------------------------------------------- public class
export class Sfx {
  constructor(ctx = null) {
    this.ctx = null; this._ext = ctx; this.q = 1; this.vol = { master: 1, music: 1, sfx: 1 };
    this.mood = 0; this.int = 0; this.musOn = true; this.seed = (Math.random() * 1e9) | 0;
    this.held = {}; this._sent = {}; this.be = null; this.fx = null; this.mu = null; this._rl = {}; this._gen = 0; this.ready = Promise.resolve();
  }
  init() {
    if (this.ctx) { if (this.ctx.state === 'suspended' && !this.ctx.startRendering) this.ctx.resume(); return; }
    const C = globalThis.AudioContext || globalThis.webkitAudioContext; if (!this._ext && !C) return;
    const c = this.ctx = this._ext || new C(), sr = c.sampleRate;
    const nb = c.createBuffer(1, sr, sr), d = nb.getChannelData(0); let l = 0x7ffff8; // LFSR noise, like the chip
    for (let i = 0; i < sr; i += 2) { l = ((l << 1) | (((l >> 22) ^ (l >> 17)) & 1)) & 0x7fffff; d[i] = d[i + 1] = (l & 255) / 127.5 - 1; }
    this.noise = nb;
    this.out = c.createGain(); this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -14; this.comp.knee.value = 10; this.comp.ratio.value = 4; this.comp.attack.value = .003; this.comp.release.value = .2;
    this.out.connect(this.comp); this.comp.connect(c.destination);
    this.mg = c.createGain(); this.sg = c.createGain();
    this._vol(); this._build(); this._tick();
  }

  // ---- routing / quality
  _build() {
    const c = this.ctx, q = this.q, gen = ++this._gen; this._tear();
    if (q > 0) {
      const fx = this.fx = { ms: c.createGain(), ss: c.createGain(), lp: c.createBiquadFilter(), fb: c.createGain(), wet: c.createGain(), d: [c.createDelay(2)] };
      fx.ms.gain.value = fx.ss.gain.value = 0; fx.lp.frequency.value = 2400; fx.fb.gain.value = .3; fx.wet.gain.value = 1;
      this.mg.connect(fx.ms); this.sg.connect(fx.ss); fx.ms.connect(fx.d[0]); fx.ss.connect(fx.d[0]); fx.d[0].connect(fx.lp);
      if (q > 1) { // ping-pong
        const d2 = c.createDelay(2), mx = c.createChannelMerger(2); fx.d.push(d2); fx.mx = mx;
        fx.lp.connect(d2); d2.connect(fx.fb); fx.lp.connect(mx, 0, 0); d2.connect(mx, 0, 1); mx.connect(fx.wet);
      } else { fx.lp.connect(fx.fb); fx.lp.connect(fx.wet); }
      fx.fb.connect(fx.d[0]); fx.wet.connect(this.out);
    }
    const cfg = { cap: [5, 8, 12][q], hold: 2, bits: q > 1 ? 11 : 10 };
    this._use(new NodeSid(c, this.noise, cfg.cap));
    if (q > 0 && c.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      this._wk = this._wk || c.audioWorklet.addModule(URL.createObjectURL(new Blob([PROC], { type: 'application/javascript' })));
      this.ready = this._wk.then(() => { if (gen === this._gen) this._use(new WkSid(c, cfg)); }).catch(e => { this._wk = null; console.warn('SID worklet unavailable, using node fallback', e); });
    } else this.ready = Promise.resolve();
  }
  _tear() {
    this.mg.disconnect(); this.sg.disconnect(); this.mg.connect(this.out); this.sg.connect(this.out);
    if (this.fx) { const f = this.fx; for (const n of [f.ms, f.ss, f.lp, f.fb, f.wet, f.mx, ...f.d]) if (n) n.disconnect(); this.fx = null; }
  }
  _use(be) {
    if (this.be) this.be.dispose();
    this.be = be; be.musicOut.connect(this.mg); be.sfxOut.connect(this.sg); this._sent = {}; this._lp = this._lm = null;
    for (const n in this.held) this._flushOne(n, true);
  }
  _vol() {
    if (!this.ctx) return; const v = this.vol, t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(.9 * v.master, t, .02); this.mg.gain.setTargetAtTime(.8 * v.music, t, .02); this.sg.gain.setTargetAtTime(v.sfx, t, .02);
  }
  setVolume(o = {}) { for (const k of ['master', 'music', 'sfx']) if (typeof o[k] === 'number') this.vol[k] = clamp(o[k]); this._vol(); }
  setQuality(l) { l = clamp(l | 0, 0, 2); if (l === this.q) return; this.q = l; if (this.ctx) this._build(); }
  setMood(x) { this.mood = clamp(+x || 0); }
  setIntensity(x) { this.int = clamp(+x || 0); }
  music(on) {
    on = !!on; if (on === this.musOn) return; this.musOn = on;
    if (!on) { if (this.be) this.be.musOff(); } else if (this.mu) { this.mu.n = 0; this.mu.t = 0; }
  }

  // ---- scheduler (25 ms timer + AudioContext clock lookahead; nothing per frame)
  _tick() {
    const c = this.ctx; if (!c) return; clearTimeout(this._tm);
    if (!(typeof OfflineAudioContext !== 'undefined' && c instanceof OfflineAudioContext)) this._tm = setTimeout(() => this._tick(), 25);
    if (this._enT && performance.now() - this._enT > 300) { this._enT = 0; this._hold('enemy', [600, 0, 900, .5, 0]); }
    for (const n in this.held) this._flushOne(n);
    if (c.state === 'running') { if (this.musOn) this._sched(c.currentTime + .15); this._params(); }
  }
  _hold(n, p) { this.held[n] = p; if (this.be && n === 'beam') this._flushOne(n); }
  _flushOne(n, force) {
    const p = this.held[n], o = this._sent[n]; if (!this.be) return;
    if (!force && o && Math.abs(p[1] - o[1]) < .002 && Math.abs(p[0] / o[0] - 1) < .01 && Math.abs(p[2] / o[2] - 1) < .02) return;
    this._sent[n] = p; this.be.hold(n, HELD[n], p);
  }
  _dur() { return 60 / (lerp(128, 104, this.mood) + this.int * 24) / 4; }
  _params() { // continuous mood/intensity glides: shared chip filter + echo
    const m = this.mood, I = this.int, n = this.mu ? this.mu.n : 0;
    const cut = elerp(5200, 600, m) * (1 + I * .6) * (1 + .5 * m * Math.sin(n * Math.PI / 32)), q = lerp(.15, .78, m);
    if (!this._lp || Math.abs(cut / this._lp[0] - 1) > .01 || Math.abs(q - this._lp[1]) > .01) { this._lp = [cut, q]; this.be.mus(cut, q); }
    const lm = this._lm; if (!this.fx || (lm && Math.abs(m - lm[0]) < .002 && Math.abs(I - lm[1]) < .002)) return; this._lm = [m, I];
    const fx = this.fx, t = this.ctx.currentTime, dl = clamp(this._dur() * 3, .1, 1.5);
    for (const d of fx.d) d.delayTime.setTargetAtTime(dl, t, .3);
    fx.fb.gain.setTargetAtTime(lerp(.22, .55, m), t, .1); fx.ms.gain.setTargetAtTime(lerp(.12, .45, m), t, .1);
    fx.ss.gain.setTargetAtTime(m * .3, t, .1); fx.lp.frequency.setTargetAtTime(elerp(2800, 1300, m), t, .1);
  }
  _sched(until) {
    const c = this.ctx, M = this.mu || (this.mu = { n: 0, sec: 0, t: 0, seed: this.seed, lead: null });
    if (M.t < c.currentTime + .01) M.t = c.currentTime + .05; // (re)start or recover from a stall
    while (M.t < until) { this._step(M.t); M.t += this._dur(); M.n++; }
  }
  _section() {
    const M = this.mu, r = M.r = rng(M.seed + M.sec++ * 7919);
    M.ps = pick(r, PROG_S); M.pc = pick(r, PROG_C); M.bright = r() < .5 ? MAJOR : LYD;
    M.bS = pick(r, BASS_S); M.bC = pick(r, BASS_C); M.drum = pick(r, DRUMS);
    M.mA = motif(r); M.mB = motif(r); M.intro = M.sec === 1;
    M.leadOn = []; for (let i = 0; i < 8; i += 2) M.leadOn[i] = M.leadOn[i + 1] = !M.intro && r() < .85;
  }
  _step(t) {
    const M = this.mu, s = M.n % 16, bar = (M.n >> 4) % 8, I = this.int, be = this.be, dt = this._dur(), lo = this.q === 0;
    if (s === 0 && bar === 0) this._section();
    if (s === 0) { // harmony decisions snap to the bar; timbre glides continuously in _params
      M.cave = this.mood > .5; M.sc = M.cave ? (I > .7 ? PHRY : MINOR) : M.bright;
      const pr = M.cave ? M.pc : M.ps; M.deg = pr[bar % 4]; M.nxt = pr[(bar + 1) % 4];
    }
    const sc = M.sc, cave = M.cave, r = M.r;
    const pitch = d => ROOT + sc[((d % 7) + 7) % 7] + 12 * Math.floor(d / 7);
    // voice 2: bass
    const pat = cave ? M.bC : M.bS; let bc = pat[s];
    if (bc === '.' && s % 2 && I > .6 && r() < I - .5) bc = 'o';
    if (bc !== '.') {
      let n = pitch(M.deg); if (bc === 'o') n += 12; else if (bc === 'f') n = pitch(M.deg + 4); else if (bc === 'p') n = pitch(M.nxt) + (r() < .5 ? -1 : 1);
      let len = 1; while (len < 4 && pat[(s + len) % 16] === '.') len++;
      be.note(0, 1, { w: P, f: mtof(n), pw: .5, pw1: .15, pr: .4, pd: .08, a: .002, d: .15, s: .55, r: .04, dur: len * dt * .8, v: cave ? .34 : .3, filt: 1 }, t);
    }
    // voice 1: fast chord arpeggio (50 Hz frame-rate arp)
    const every = cave ? (I > .6 ? 4 : 8) : (I > .5 ? 1 : 2);
    if (s % every === 0) {
      const r0 = pitch(M.deg), tn = [0, pitch(M.deg + 2) - r0, pitch(M.deg + 4) - r0];
      if (!cave) tn.push(12); else if (I > .4) tn.push(pitch(M.deg + 6) - r0);
      be.note(0, 0, { w: P, f: mtof(r0 + 24), arp: tn, ar: lo ? 25 : 50, pw: .12, pw1: .45, a: .003, d: cave ? .6 : .2, s: cave ? .5 : .35, r: cave ? .3 : .06, dur: every * dt * .85, v: cave ? .12 : .14, filt: 1 }, t);
    } else if (cave && r() < .07) { // water drip in the cave, steals the arp voice
      be.note(0, 0, { w: T, f: mtof(pitch(M.deg + pick(r, [7, 9, 11])) + 24), a: 0, d: .25, s: 0, dur: .25, v: .13 }, t);
    }
    // voice 3: lead with vibrato + PWM, drums steal it (and hand it back)
    let e = !lo && M.leadOn[bar] ? (bar % 4 < 2 ? M.mA : M.mB)[(bar % 2) * 16 + s] : null;
    if (e && cave && r() < .3) e = null;
    let dr = null;
    if (M.intro) dr = s === 0 ? KICK : null;
    else if (bar === 7 && s >= 12 && I > .3) dr = cave || s % 2 ? TOM : SNARE;
    else if (M.drum.k.includes(s) && (!cave || s === 0 || (s === 10 && I > .5))) dr = KICK;
    else if (M.drum.s.includes(s) && (!cave || (s === 12 && I > .2))) dr = cave ? TOM : SNARE;
    else if (!lo && !cave && I > .45 && s % 2 === 0 && !e) dr = HAT;
    let lt = t;
    if (dr) { be.note(0, 2, cave ? { ...dr, filt: 1, v: dr.v * .85 } : dr, t); lt = t + (dr === HAT ? .03 : .055); }
    if (e) {
      const len = e.l * dt * .9, n = pitch(M.deg + e.d) + (cave ? 24 : 36), dur = Math.max(.03, t + len - lt);
      const sp = cave ? { w: S, f: mtof(n), a: .03, d: .3, s: .6, r: .25, vd: .2, vr: 4, vdl: .2, filt: 1, v: .17, dur }
        : { w: P, f: mtof(n), pw: .5, pr: 3 + I * 3, pd: .2, vd: .25, vr: 5.5, vdl: .15, a: .006, d: .12, s: .7, r: .12, dur, v: .16, filt: this.mood > .35 ? 1 : 0 };
      be.note(0, 2, sp, lt); M.lead = { sp, end: t + len };
    } else if (dr && M.lead && M.lead.end > lt + .04) be.note(0, 2, { ...M.lead.sp, a: .001, vdl: 0, dur: M.lead.end - lt }, lt);
  }

  // ---- sfx
  _fx(s, dt = 0) { if (this.be) this.be.note(1, -1, s, dt ? this.ctx.currentTime + dt : 0); }
  _ok(k, gap) { const t = this.ctx ? this.ctx.currentTime : 0, l = this._rl[k] || -9; if (!this.be || t - l < gap) return false; this._rl[k] = t; return true; }
  engine(l) {
    l = clamp(+l || 0); if (!this.ctx) return;
    this.held.engN = [300 + l * 2200, l * .2, 140 + l * 1600, .5, 0];
    this.held.engP = [44 + l * 36, l * .16, 110 + l * 700, .5, 0];
  }
  beam(on) { if (this.ctx) this._hold('beam', [110, on ? .2 : 0, 900, .5, 113.3]); }
  enemyEngine(d = 1) {
    if (!this.ctx) return; const k = 1 - clamp(+d);
    this.held.enemy = [500 + k * 700, k * k * .13, 900 + k * 1800, .5, 0]; this._enT = performance.now();
  }
  shot() { const k = .92 + Math.random() * .16; this._fx({ w: P, f: 1500 * k, f1: 260 * k, ft: .11, pw: .5, pr: 38, pd: .38, a: 0, d: .09, s: .25, r: .04, dur: .06, v: .3 }); }
  enemyShot() { this._fx({ w: T, f: 980, f1: 140, ft: .24, m: 1370, m1: 95, ring: 1, a: 0, d: .2, s: .3, r: .06, dur: .14, v: .38 }); }
  pickup() {
    const s = { w: P, f: mtof(72), arp: [0, 4, 7, 12, 16, 19, 24], ar: 28, pw: .3, pw1: .6, a: 0, d: .3, s: .5, r: .1, dur: .26, v: .24 };
    this._fx(s); this._fx({ ...s, w: T, f: mtof(84), v: .14 }, .07);
  }
  dock() {
    this._fx({ w: S, sync: 1, m: 110, f: 180, f1: 1900, ft: .75, a: .02, d: .3, s: .8, r: .2, dur: .7, v: .26, fl: { m: LP, c: 700, c1: 5000, ct: .75, q: .5 } });
    this._fx({ w: T, f: mtof(81), arp: [0, 4, 7, 12], ar: 16, a: 0, d: .5, s: .3, r: .3, dur: .3, v: .2, vd: .3, vr: 6 }, .72);
  }
  boom(big = 1) {
    const b = clamp(+big || 1, .2, 2.5), k = Math.min(b, 1.3);
    this._fx({ w: N, f: 2600 * k, f1: 160, ft: .9 * b, a: 0, d: .9 * b, s: 0, dur: .9 * b, v: .5 * k, fl: { m: LP, c: 4000 * Math.min(b, 1.2), c1: 90, ct: .8 * b, q: .45 } });
    this._fx({ w: T, f: 170, f1: 32, ft: .35 * b, a: 0, d: .4 * b, s: 0, dur: .4 * b, v: .6 * Math.min(1.2, b) });
  }
  hit() {
    this._fx({ w: N, f: 6000, f1: 800, ft: .15, a: 0, d: .15, s: 0, dur: .15, v: .35 });
    this._fx({ w: P, f: 220, f1: 70, ft: .18, m: 333, ring: 1, pw: .3, a: 0, d: .2, s: 0, dur: .2, v: .32 });
  }
  refuel() { // ticks climb in pitch while refuelling continues (Shepard-ish wrap)
    if (!this._ok('refuel', .07)) return; const t = this.ctx.currentTime;
    this._rn = t - (this._rt || 0) > .4 ? 0 : (this._rn || 0) + 1; this._rt = t;
    this._fx({ w: P, pw: .25, f: mtof(64 + this._rn % 24), a: 0, d: .05, s: 0, dur: .05, v: .17 });
  }
  alarm() { if (this._ok('alarm', .6)) this._fx({ w: P, pw: .5, f: 990, arp: [0, -6], ar: 6, fl: { m: BP, c: 1800, q: .4 }, a: .01, d: .1, s: .9, r: .08, dur: .5, v: .3 }); }
  waveStart(n = 1) {
    if (!this.be) return; const b = 60 + ((n | 0) % 5) * 2;
    [0, 4, 7, 12].forEach((x, i) => this._fx({ w: P, pw: .25 + i * .08, f: mtof(b + x), a: 0, d: .1, s: .5, r: .05, dur: .08, v: .22 }, i * .09));
    this._fx({ w: P, f: mtof(b + 12), arp: [0, 4, 7], ar: 25, pr: 4, pd: .25, vd: .3, vr: 6, vdl: .1, a: .01, d: .2, s: .6, r: .3, dur: .55, v: .22 }, .36);
    this._fx({ w: T, f: mtof(b - 12), f1: mtof(b - 24), ft: .8, a: .01, d: .8, s: 0, dur: .8, v: .35 }, .36);
  }
  baseDestroyed() {
    if (!this.be) return; this.boom(2);
    this._fx({ w: S, sync: 1, m: 55, f: 1600, f1: 60, ft: 1.8, a: 0, d: 2, s: 0, dur: 2, v: .3, fl: { m: LP, c: 6000, c1: 200, ct: 2, q: .7 } });
    this._fx({ w: N, f: 1500, f1: 200, ft: 2.5, a: .05, d: 2.6, s: 0, dur: 2.6, v: .45, fl: { m: LP, c: 3000, c1: 120, ct: 2.5, q: .6 } }, .35);
    this._fx({ w: T, f: 120, f1: 25, ft: 1, a: 0, d: 1, s: 0, dur: 1, v: .6 }, .35);
  }
  ui(kind = 'move') {
    if (kind === 'select') this._fx({ w: P, pw: .4, f: mtof(76), arp: [0, 7, 12], ar: 40, a: 0, d: .16, s: .3, r: .05, dur: .12, v: .2 });
    else if (kind === 'back') this._fx({ w: P, pw: .4, f: 700, f1: 300, ft: .09, a: 0, d: .1, s: 0, dur: .1, v: .18 });
    else this._fx({ w: P, pw: .25, f: 1320, a: 0, d: .04, s: 0, dur: .04, v: .16 });
  }
}
