import * as THREE from 'three';

// armies.js - enemy bases and the armies they field, for the 3D (Zarch) half.
//
//   const armies = createArmies(ctx);   ctx = { scene, groundY, terrainH, BOUND, PAD_H, rnd, spawnBullet, explode, say, addScore, sfx }
//   armies.update(dt, player)           player = { pos: Vector3, vel: Vector3, alive: bool, ram(why) }
//   armies.hitTest(p, radius, dmg)      -> true if a ship / bomb / base part absorbed the shot (damage, kills and score applied)
//   armies.contacts() / bases() / infection() / craters() / intensity() / reset(seed) / setDrawDistance(m) / setMaxShips(n)
//
// Bases are puzzles, not sponges: shield pylons keep a dome over the core; with the dome up, the hull and reactor
// shrug off fire. Drop the pylons, then shoot the reactor (3x damage) or the hull until the core goes critical; after a
// countdown it blows (Thrust's reactor), taking nearby ships - and the player, if too close - with it.
// Ships: one InstancedMesh per type (instance colour = faction tint). Bullets go out through ctx.spawnBullet.

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const BULLET_G = 9.0 * 0.25;          // main.js applies GRAV*0.25 to every bullet; aim compensates for the drop
function mulberry32(a) {
  return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------ data tables
// r: footprint radius (fortress: half side). hp: core structure. pylons: shield generators (hp each). domeR: shield radius.
// turrets: [kind, hp]. spawn: seconds between waves once awake. budget: army cost the base keeps in the air (grows with
// time and with each wave). wave: cost points per wave. roster: type weights. crit: reactor countdown. blast: kill radius.
export const TIERS = {
  outpost:  { rank: 0, label: 'OUTPOST',  r: 10, hp: 20,  pylons: 0, pylonHp: 0,  domeR: 0,  turrets: [['gun', 4]], spawn: 15, budget: 4, wave: 3, grow: 0.5,
              roster: { scout: 3, seeder: 1 }, score: 1000, crit: 4, blast: 26, blastPow: 3, wakeR: 170, patrolR: 45, tint: 0xff8a3d, radar: 6, dist: [95, 210] },
  garrison: { rank: 1, label: 'GARRISON', r: 16, hp: 45,  pylons: 2, pylonHp: 8,  domeR: 11, turrets: [['gun', 5], ['gun', 5]], spawn: 16, budget: 9, wave: 6, grow: 1,
              roster: { scout: 1, fighter: 3, bomber: 2, seeder: 1 }, score: 2500, crit: 5, blast: 36, blastPow: 4, wakeR: 200, patrolR: 60, tint: 0xe8343a, radar: 8, dist: [130, 270] },
  fortress: { rank: 2, label: 'FORTRESS', r: 25, hp: 90,  pylons: 3, pylonHp: 10, domeR: 15, turrets: [['flak', 8], ['flak', 8], ['flak', 8], ['flak', 8]], spawn: 18, budget: 16, wave: 10, grow: 1.6,
              roster: { fighter: 2, bomber: 1.5, gunship: 2, interceptor: 2 }, score: 5000, crit: 6, blast: 50, blastPow: 5, wakeR: 230, patrolR: 75, tint: 0xa64dff, radar: 10, dist: [180, 340] },
  hive:     { rank: 3, label: 'HIVE',     r: 22, hp: 160, pylons: 4, pylonHp: 12, domeR: 21, turrets: [['flak', 8], ['gun', 6], ['flak', 8], ['gun', 6]], spawn: 20, budget: 24, wave: 12, grow: 2,
              roster: { scout: 2, fighter: 1, interceptor: 2, carrier: 1, seeder: 1.5 }, score: 10000, crit: 7, blast: 60, blastPow: 6, wakeR: 1e9, patrolR: 90, tint: 0x3dff7a, radar: 12, dist: [190, 290],
              fly: { alt: 55, speed: 4.5, orbit: 80 } },
};
// hp in player-bullet hits. speed m/s. agility: velocity response (1/s). alt/minAlt: cruise / minimum height over ground.
// r: hit + ram radius. aggro: engage range. fire: seconds between shots or bursts. bspd: bullet speed. lead 0..1: target lead.
export const ROSTER = {
  scout:       { hp: 1,  speed: 30, agility: 2.6, alt: 16, minAlt: 5,   r: 1.5, aggro: 120, fire: 3.0, burst: 1, bspd: 50, spread: 0.08, lead: 0.3, dmg: 1, score: 100,  cost: 1, boom: 0.6, radar: 2 },
  fighter:     { hp: 3,  speed: 36, agility: 1.8, alt: 24, minAlt: 6,   r: 2.3, aggro: 150, fire: 2.0, burst: 3, bspd: 60, spread: 0.03, lead: 0.6, dmg: 1, score: 200,  cost: 2, boom: 1.0, radar: 3, retreat: true },
  bomber:      { hp: 7,  speed: 17, agility: 0.9, alt: 34, minAlt: 12,  r: 3.6, aggro: 180, fire: 0.45, burst: 0, bspd: 0, spread: 0, lead: 0, dmg: 3, score: 350, cost: 3, boom: 1.6, radar: 4, retreat: true, bombs: 4 },
  gunship:     { hp: 16, speed: 10, agility: 1.0, alt: 20, minAlt: 8,   r: 3.8, aggro: 140, fire: 1.9, burst: 1, bspd: 45, spread: 0.05, lead: 0.4, dmg: 1, score: 600,  cost: 5, boom: 2.2, radar: 5, retreat: true, barrels: 3 },
  carrier:     { hp: 28, speed: 7,  agility: 0.5, alt: 48, minAlt: 22,  r: 7.5, aggro: 200, fire: 3.2, burst: 1, bspd: 40, spread: 0.08, lead: 0.2, dmg: 1, score: 1000, cost: 8, boom: 3.0, radar: 7, launch: 8, kids: 4 },
  seeder:      { hp: 2,  speed: 14, agility: 1.4, alt: 4,  minAlt: 2.5, r: 2.0, aggro: 0,   fire: 0,   burst: 0, bspd: 0,  spread: 0,    lead: 0,   dmg: 0, score: 300,  cost: 2, boom: 0.8, radar: 3, flee: 45, seedEvery: 14 },
  interceptor: { hp: 4,  speed: 50, agility: 2.4, alt: 22, minAlt: 6,   r: 2.1, aggro: 220, fire: 1.5, burst: 2, bspd: 70, spread: 0.01, lead: 1.0, dmg: 1, score: 400,  cost: 3, boom: 1.0, radar: 3 },
};
export const SHIP_TYPES = Object.keys(ROSTER);
const GREEK = ['ALPHA', 'BETA', 'GAMMA', 'DELTA', 'EPSILON', 'ZETA', 'ETA', 'THETA', 'IOTA', 'KAPPA', 'LAMBDA', 'SIGMA', 'OMEGA'];
const CAP = 200;   // hard per-type instance capacity
const TYPE_CAP = { seeder: 2, carrier: 1, gunship: 3 };   // per base, alive + queued

// ------------------------------------------------------------------ geometry helpers (no BufferGeometryUtils vendored)
// P(geo, colour, pos, rot, scale): rotate (X, Y, Z), scale in world axes, translate; bake a vertex colour.
function P(geo, color, pos = [0, 0, 0], rot = [0, 0, 0], scl = [1, 1, 1]) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (rot[0]) g.rotateX(rot[0]); if (rot[1]) g.rotateY(rot[1]); if (rot[2]) g.rotateZ(rot[2]);
  g.scale(scl[0], scl[1], scl[2]); g.translate(pos[0], pos[1], pos[2]);
  const n = g.attributes.position.count, c = new Float32Array(n * 3), col = new THREE.Color(color);
  for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
function merge(list) {
  let n = 0; for (const g of list) n += g.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3); let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o); nor.set(g.attributes.normal.array, o); col.set(g.attributes.color.array, o);
    o += g.attributes.position.count * 3; g.dispose();
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.computeBoundingSphere();
  return g;
}
const Box = (x, y, z) => new THREE.BoxGeometry(x, y, z);
const Cyl = (a, b, h, s = 8, open = false, t0 = 0, tl = TAU) => new THREE.CylinderGeometry(a, b, h, s, 1, open, t0, tl);
const Cone = (r, h, s = 4) => new THREE.ConeGeometry(r, h, s);
const Sph = (r, w = 8, h = 6) => new THREE.SphereGeometry(r, w, h);
const HP = Math.PI / 2, W = 0xffffff, D = 0x3a3f4a, GL = 0x1c2a3a, M = 0x9aa0aa;

// Ship models, nose along +Z, Y up. White parts take the faction tint (instance colour), dark parts stay dark.
export function shipGeometry(type) {
  switch (type) {
    case 'scout': return merge([
      P(Cone(0.6, 2.8), W, [0, 0, 0.3], [HP, 0, 0], [1, 0.6, 1]),
      P(Box(2.6, 0.1, 0.7), W, [0, 0, -0.4], [0, 0, 0]),
      P(Box(0.1, 0.7, 0.7), D, [0, 0.35, -0.9]),
      P(Box(0.6, 0.35, 0.5), D, [0, 0, -1.15]),
    ]);
    case 'fighter': return merge([
      P(Cone(0.8, 3.8), W, [0, 0, 0.4], [HP, 0, 0], [1, 0.55, 1]),
      P(Box(2.8, 0.12, 1.3), W, [1.3, 0, -0.5], [0, -0.45, 0]),
      P(Box(2.8, 0.12, 1.3), W, [-1.3, 0, -0.5], [0, 0.45, 0]),
      P(Cyl(0.2, 0.2, 1.5, 5), D, [2.5, 0, -0.9], [HP, 0, 0]),
      P(Cyl(0.2, 0.2, 1.5, 5), D, [-2.5, 0, -0.9], [HP, 0, 0]),
      P(Sph(0.45, 6, 4), GL, [0, 0.32, 0.5], [0, 0, 0], [1, 0.8, 1.7]),
      P(Box(0.12, 1.0, 1.0), W, [0, 0.5, -1.4]),
      P(Box(0.7, 0.4, 0.5), D, [0, 0, -1.6]),
    ]);
    case 'bomber': return merge([
      P(Cyl(0.9, 1.1, 5.4, 6), W, [0, 0, 0], [HP, 0, 0], [1.25, 0.8, 1]),
      P(Cone(0.95, 1.5, 6), GL, [0, 0, 3.4], [HP, 0, 0], [1.25, 0.8, 1]),
      P(Box(8.4, 0.26, 2.0), W, [0, 0.15, 0.2]),
      P(Cyl(0.45, 0.55, 2.4, 6), D, [2.5, -0.35, 0.3], [HP, 0, 0]),
      P(Cyl(0.45, 0.55, 2.4, 6), D, [-2.5, -0.35, 0.3], [HP, 0, 0]),
      P(Box(3.2, 0.15, 1.1), W, [0, 0.35, -2.5]),
      P(Box(0.16, 1.4, 1.2), W, [0, 1.0, -2.5]),
      P(Box(1.2, 0.3, 2.4), D, [0, -0.85, 0]),
    ]);
    case 'gunship': {
      const parts = [
        P(Box(2.6, 1.8, 5), W),
        P(Box(2.0, 1.1, 1.6), GL, [0, -0.2, 3.0]),
        P(Box(1.2, 1.0, 2.4), W, [2.1, -0.2, 0.6]),
        P(Box(1.2, 1.0, 2.4), W, [-2.1, -0.2, 0.6]),
        P(Cyl(1.1, 1.1, 0.35, 8), D, [2.7, 0.75, -1.5]),
        P(Cyl(1.1, 1.1, 0.35, 8), D, [-2.7, 0.75, -1.5]),
        P(Box(0.16, 1.4, 1.4), W, [0, 1.4, -2.0]),
      ];
      for (const sx of [-1, 1]) for (const bx of [-0.35, 0, 0.35]) parts.push(P(Cyl(0.12, 0.12, 2.2, 5), D, [sx * 2.1 + bx, -0.2 + (bx === 0 ? 0.3 : 0), 2.6], [HP, 0, 0]));
      return merge(parts);
    }
    case 'carrier': return merge([
      P(Box(5, 2.6, 14), W),
      P(Cone(2.6, 4, 4), W, [0, 0, 9], [HP, 0, 0], [1.25, 0.65, 1]),
      P(Box(4.2, 0.2, 12.4), D, [0, 1.4, 0]),
      P(Box(1.3, 2.4, 2.6), W, [1.8, 2.6, -2.2]),
      P(Cyl(0.1, 0.1, 2.2, 4), D, [1.8, 4.9, -2.2]),
      P(Box(0.4, 1.4, 8), D, [2.7, -0.2, 0.5]),
      P(Box(0.4, 1.4, 8), D, [-2.7, -0.2, 0.5]),
      P(Cyl(0.85, 0.95, 1.3, 8), D, [1.5, 0, -7.5], [HP, 0, 0]),
      P(Cyl(0.85, 0.95, 1.3, 8), D, [-1.5, 0, -7.5], [HP, 0, 0]),
    ]);
    case 'seeder': {
      const parts = [P(Cyl(2.0, 1.4, 0.6, 8), W), P(new THREE.SphereGeometry(0.95, 8, 4, 0, TAU, 0, HP), 0x7dff4a, [0, 0.3, 0])];
      for (let i = 0; i < 3; i++) { const a = i / 3 * TAU; parts.push(P(Cone(0.28, 1.4, 4), D, [Math.cos(a) * 1.1, -0.85, Math.sin(a) * 1.1], [Math.PI, 0, 0])); }
      return merge(parts);
    }
    case 'interceptor': return merge([
      P(Cone(0.55, 5.2), W, [0, 0, 0.5], [HP, 0, 0], [1, 0.6, 1]),
      P(Box(1.6, 0.08, 0.5), W, [0.75, 0, 1.7], [0, 0.4, 0]),
      P(Box(1.6, 0.08, 0.5), W, [-0.75, 0, 1.7], [0, -0.4, 0]),
      P(Box(2.4, 0.08, 1.2), W, [1.1, 0, -1.1], [0, -0.6, 0]),
      P(Box(2.4, 0.08, 1.2), W, [-1.1, 0, -1.1], [0, 0.6, 0]),
      P(Box(0.08, 1.0, 0.9), D, [0.5, 0.5, -1.8], [0, 0, -0.3]),
      P(Box(0.08, 1.0, 0.9), D, [-0.5, 0.5, -1.8], [0, 0, 0.3]),
      P(Cyl(0.35, 0.42, 0.8, 6), D, [0, 0, -2.2], [HP, 0, 0]),
    ]);
  }
}
const SHIP_LEN = { scout: 1.4, fighter: 1.9, bomber: 2.9, gunship: 2.6, carrier: 7.6, seeder: 0.2, interceptor: 2.5 };

// ------------------------------------------------------------------ base layouts (local frame, y = 0 is the slab top)
// hull: hit volumes, boxes {b:[x0,y0,z0,x1,y1,z1]} or ellipsoid {e:[rx,ry,rz]}. hangar: launch point.
function baseLayout(tier, tint) {
  const T = tint, s = [];   // static merged parts
  const L = { static: s, hull: [], pylons: [], turrets: [], reactor: null, hangar: [0, 3, 0], domeC: [0, 0, 0] };
  const hut = (x, z, r, len, rotY = 0) => s.push(P(Cyl(r, r, len, 8, false, 0, Math.PI), T, [x, 0, z], [HP, rotY, HP]));
  if (tier === 'outpost') {
    hut(-3, 0, 3.2, 8); s.push(P(Box(5.6, 2.8, 0.2), D, [-3, 1.4, 4.0]));
    s.push(P(Cyl(2.2, 2.6, 0.8, 8), M, [4, 0.4, -2]));
    s.push(P(Cyl(0.15, 0.22, 9, 4), M, [2, 4.5, -6]), P(Box(2.2, 1.2, 0.15), T, [2, 8.6, -6]));
    s.push(P(Box(3, 1.6, 3), M, [5, 0.8, 4.5]));
    L.hull.push({ b: [-6.3, 0, -4, 0.3, 3.3, 4.1] }, { b: [3.5, 0, 3, 6.5, 1.6, 6] });
    L.reactor = { p: [4, 2.2, -2], r: 1.6 };
    L.turrets.push({ p: [5, 1.6, 4.5] });
    L.hangar = [-3, 2.2, 6.5];
  } else if (tier === 'garrison') {
    s.push(P(Box(8, 4, 6), M, [0, 2, -3]), P(Box(8.4, 0.4, 6.4), T, [0, 4.2, -3]));
    hut(-5, 3, 3.4, 7); s.push(P(Box(6, 3, 0.2), D, [-5, 1.5, 6.5]));
    s.push(P(Cyl(1.6, 2.2, 5, 8), M, [4, 2.5, 2]), P(new THREE.TorusGeometry(2.2, 0.18, 4, 12), T, [4, 6.3, 2], [HP, 0, 0]));
    L.hull.push({ b: [-4, 0, -6, 4, 4.4, 0] }, { b: [-8.4, 0, -0.5, -1.6, 3.4, 6.6] }, { b: [2, 0, 0, 6, 5, 4] });
    L.reactor = { p: [4, 6.3, 2], r: 1.8 };
    L.pylons.push({ p: [0, 0, 13.5] }, { p: [0, 0, -13.5] });
    L.turrets.push({ p: [10, 0, -9] }, { p: [-10, 0, -9] });
    L.hangar = [-5, 2.5, 9];
  } else if (tier === 'fortress') {
    const H = 23, wt = 1.6, wh = 5;
    s.push(P(Box(2 * H, wh, wt), M, [0, wh / 2, -H]), P(Box(wt, wh, 2 * H), M, [H, wh / 2, 0]), P(Box(wt, wh, 2 * H), M, [-H, wh / 2, 0]));
    s.push(P(Box(H - 5, wh, wt), M, [-(H + 5) / 2, wh / 2, H]), P(Box(H - 5, wh, wt), M, [(H + 5) / 2, wh / 2, H]));
    s.push(P(Box(2 * H, 0.5, wt + 0.3), T, [0, wh + 0.25, -H]), P(Box(wt + 0.3, 0.5, 2 * H), T, [H, wh + 0.25, 0]), P(Box(wt + 0.3, 0.5, 2 * H), T, [-H, wh + 0.25, 0]));
    for (const [x, z] of [[H, H], [-H, H], [H, -H], [-H, -H]]) {
      s.push(P(Cyl(2.6, 3.1, 8, 8), M, [x, 4, z]), P(Cyl(2.9, 2.9, 0.5, 8), T, [x, 8.1, z]));
      L.turrets.push({ p: [x, 8.3, z] });
      L.hull.push({ b: [x - 3, 0, z - 3, x + 3, 8.3, z + 3] });
    }
    L.hull.push({ b: [-H, 0, -H - wt / 2, H, wh, -H + wt / 2] }, { b: [H - wt / 2, 0, -H, H + wt / 2, wh, H] }, { b: [-H - wt / 2, 0, -H, -H + wt / 2, wh, H] },
      { b: [-H, 0, H - wt / 2, -5, wh, H + wt / 2] }, { b: [5, 0, H - wt / 2, H, wh, H + wt / 2] });
    s.push(P(Box(12, 7, 10), M, [0, 3.5, -4]), P(Box(12.6, 0.5, 10.6), T, [0, 7.2, -4]));
    s.push(P(Cyl(1.3, 2.1, 2.5, 6), D, [0, 8.6, -4]), P(new THREE.TorusGeometry(2.6, 0.22, 4, 14), T, [0, 10.4, -4], [HP, 0, 0]));
    s.push(P(Box(10, 5, 7), M, [0, 2.5, 8]), P(Box(7, 3.6, 0.2), D, [0, 1.8, 11.6]));
    L.hull.push({ b: [-6, 0, -9, 6, 7.5, 1] }, { b: [-5, 0, 4.5, 5, 5, 11.6] });
    L.reactor = { p: [0, 10.4, -4], r: 2.2 };
    for (let i = 0; i < 3; i++) { const a = i / 3 * TAU + 0.5; L.pylons.push({ p: [Math.cos(a) * 18.5, 0, Math.sin(a) * 18.5] }); }
    L.hangar = [0, 3, 15];
  } else if (tier === 'hive') {
    s.push(P(Sph(18, 14, 8), M, [0, 0, 0], [0, 0, 0], [1, 0.32, 1]));
    s.push(P(new THREE.TorusGeometry(17.4, 1.3, 5, 24), T, [0, 0.4, 0], [HP, 0, 0]));
    s.push(P(Cyl(4, 6, 5, 8), M, [0, 5.5, 0]), P(Cyl(4.3, 4.3, 0.6, 8), T, [0, 8.2, 0]));
    s.push(P(Box(5, 2, 5), D, [9, -4.2, 0]), P(Box(5, 2, 5), D, [-9, -4.2, 0]));
    for (let i = 0; i < 4; i++) {
      const a = i / 4 * TAU, c = Math.cos(a), sn = Math.sin(a);
      s.push(P(Box(9, 0.9, 1.4), T, [c * 21, 0, sn * 21], [0, -a, 0]));
      L.pylons.push({ p: [c * 26, 0, sn * 26] });
      const b = a + TAU / 8; L.turrets.push({ p: [Math.cos(b) * 12, -6.2, Math.sin(b) * 12], hang: true });
    }
    L.hull.push({ e: [18.5, 6.2, 18.5] }, { b: [-6, 0, -6, 6, 8.5, 6] });
    L.reactor = { p: [0, -6.4, 0], r: 3 };
    L.hangar = [9, -7, 0];
  }
  return L;
}

// ------------------------------------------------------------------ module
export function createArmies(ctx) {
  const { scene } = ctx;
  const BOUND = ctx.BOUND ?? 360, PAD_H = ctx.PAD_H ?? 6;
  const sfx = ctx.sfx || {};
  const say = (t, s) => ctx.say?.(t, s), addScore = n => ctx.addScore?.(n);
  const boom = (p, power) => ctx.explode?.(p.clone(), power);
  const shoot = b => ctx.spawnBullet?.(b);
  const groundRaw = (x, z) => { const g = ctx.groundY(x, z); return g < -100 ? PAD_H : Math.max(g, 0); };

  const root = new THREE.Group(); root.name = 'armies'; scene.add(root);
  let rng = mulberry32(1);
  const R = (a = 1, b) => b === undefined ? rng() * a : a + rng() * (b - a);

  // ---- shared materials / geometry
  const shipMat = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 40, specular: 0x333333 });
  const staticMat = new THREE.MeshPhongMaterial({ vertexColors: true, flatShading: true, shininess: 10 });
  const metalMat = new THREE.MeshPhongMaterial({ color: 0x8c929c, flatShading: true });
  const darkMat = new THREE.MeshPhongMaterial({ color: 0x2c3038, flatShading: true });
  const turretBaseGeo = new THREE.CylinderGeometry(1.1, 1.4, 1.4, 8).translate(0, -0.7, 0);
  const gunHeadGeo = merge([P(Box(1.6, 1.0, 1.8), W), P(Cyl(0.14, 0.14, 2.4, 5), D, [0.35, 0, 1.5], [HP, 0, 0]), P(Cyl(0.14, 0.14, 2.4, 5), D, [-0.35, 0, 1.5], [HP, 0, 0])]);
  const flakHeadGeo = merge([P(Box(2.0, 1.3, 2.0), W), ...[[-.4, -.25], [.4, -.25], [-.4, .3], [.4, .3]].map(([x, y]) => P(Cyl(0.16, 0.16, 2.6, 5), D, [x, y, 1.6], [HP, 0, 0]))]);
  const pylonGeo = merge([P(Cyl(0.3, 1.0, 7, 4), M, [0, 3.5, 0]), P(Box(2.2, 0.6, 2.2), D, [0, 0.3, 0]), P(new THREE.TorusGeometry(1.2, 0.15, 4, 10), W, [0, 6.2, 0], [HP, 0, 0])]);
  const orbGeo = new THREE.SphereGeometry(0.9, 10, 6);
  const beamGeo = new THREE.CylinderGeometry(0.12, 0.12, 1, 5, 1, true).translate(0, 0.5, 0).rotateX(HP);   // unit beam along +Z
  const reactorGeo = new THREE.IcosahedronGeometry(1, 1);

  // ---- ship instanced meshes
  const meshes = {};
  for (const t of SHIP_TYPES) {
    const m = new THREE.InstancedMesh(shipGeometry(t), shipMat, CAP);
    m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; m.count = 0;
    for (let i = 0; i < CAP; i++) m.setColorAt(i, new THREE.Color(1, 1, 1));
    m.instanceColor.setUsage(THREE.DynamicDrawUsage); m.name = 'armies-' + t;
    meshes[t] = m; root.add(m);
  }

  // ---- FX points: engine glows, shield sparks, bombs, infection motes
  const fx = (() => {
    const c = document.createElement('canvas'); c.width = c.height = 32;
    const x = c.getContext('2d'), g = x.createRadialGradient(16, 16, 0, 16, 16, 16);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.4, 'rgba(255,255,255,.6)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    x.fillStyle = g; x.fillRect(0, 0, 32, 32);
    const max = 3000, pos = new Float32Array(max * 3), col = new Float32Array(max * 3), geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
    const pts = new THREE.Points(geo, new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: true, map: new THREE.CanvasTexture(c), vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    pts.frustumCulled = false; root.add(pts);
    const o = { n: 0, obj: pts,
      add(X, Y, Z, r, g, b) { if (o.n >= max) return; const i = o.n++ * 3; pos[i] = X; pos[i + 1] = Y; pos[i + 2] = Z; col[i] = r; col[i + 1] = g; col[i + 2] = b; },
      end() { geo.setDrawRange(0, o.n); geo.attributes.position.needsUpdate = true; geo.attributes.color.needsUpdate = true; } };
    return o;
  })();

  // ---- state
  let bases = [], ships = [], bombs = [], sparks = [], infect = [], craterList = [], fxQueue = [];
  let drawDist = 300, maxShips = 70, time = 0, waveNo = 0, intens = 0, shotsRecent = 0, shotSfxT = 0, homeSayT = 0, homeHits = 0;
  let infectVer = 0, showInfection = true, nextId = 1, waveSayT = 0, diff = 1;
  let plr = { pos: new THREE.Vector3(), vel: new THREE.Vector3(), alive: false, ram() {} };

  const _hv = new THREE.Vector3(), _hv2 = new THREE.Vector3(), _v = new THREE.Vector3(), _v2 = new THREE.Vector3(), _dv = new THREE.Vector3(), _m = new THREE.Matrix4(), _q = new THREE.Quaternion(),
    _e = new THREE.Euler(0, 0, 0, 'YXZ'), _one = new THREE.Vector3(1, 1, 1), _c = new THREE.Color(), _white = new THREE.Color(2.2, 2.2, 2.2);

  // world <-> base local (base yaw about Y)
  const toWorld = (b, l, out) => { const c = Math.cos(b.yaw), s = Math.sin(b.yaw); return out.set(b.x + l[0] * c + l[2] * s, b.y + l[1], b.z - l[0] * s + l[2] * c); };
  const toLocal = (b, p, out) => { const dx = p.x - b.x, dz = p.z - b.z, c = Math.cos(b.yaw), s = Math.sin(b.yaw); return out.set(dx * c - dz * s, p.y - b.y, dx * s + dz * c); };

  // slab tops so ships, bombs and the player can stand on foundations
  function heightAt(x, z) {
    let h = -Infinity;
    for (const b of bases) {
      if (b.flying) continue;
      const dx = x - b.x, dz = z - b.z;
      if (b.tierKey === 'fortress') { const l = toLocal(b, _hv.set(x, 0, z), _hv2); if (Math.abs(l.x) < b.r && Math.abs(l.z) < b.r) h = Math.max(h, b.y); }
      else if (dx * dx + dz * dz < b.r * b.r) h = Math.max(h, b.y);
    }
    return h;
  }
  const floorAt = (x, z) => Math.max(groundRaw(x, z), heightAt(x, z));

  // ================================================================ bases
  function footprintStats(x, z, r) {
    let mn = Infinity, mx = -Infinity, wet = false;
    const sample = (px, pz) => { const h = ctx.terrainH(px, pz); if (h <= 0.6) wet = true; mn = Math.min(mn, h); mx = Math.max(mx, h); };
    sample(x, z);
    for (let i = 0; i < 12; i++) { const a = i / 12 * TAU; sample(x + Math.cos(a) * r, z + Math.sin(a) * r); if (i % 2 === 0) sample(x + Math.cos(a) * r * 0.5, z + Math.sin(a) * r * 0.5); }
    return { mn, mx, wet };
  }
  function siteOk(x, z, r, placed, flying) {
    const d = Math.hypot(x, z);
    if (d < 80 + r || Math.abs(x) > BOUND - r - 12 || Math.abs(z) > BOUND - r - 12) return false;
    if (Math.abs(x) < 80 + r && Math.abs(z) < 12 + r) return false;            // cave strip
    for (const p of placed) if (Math.hypot(x - p.x, z - p.z) < r + p.r + (p.flying || flying ? 120 : 60)) return false;
    return true;
  }
  function placeBases() {
    const n = 4 + Math.floor(R(4));
    const tiers = ['hive', 'fortress', 'garrison', 'outpost'];
    const extra = ['outpost', 'garrison', 'outpost', 'fortress'];
    for (let i = 4; i < n; i++) tiers.push(extra[i - 4]);
    tiers.sort((a, b) => TIERS[b].rank - TIERS[a].rank);   // biggest first: they are hardest to fit
    const placed = [];
    for (const key of tiers) {
      const T = TIERS[key], r = key === 'fortress' ? T.r * 1.42 : T.r, flying = !!T.fly;
      let best = null, bestS = Infinity;
      for (let pass = 0; pass < 3 && !best; pass++) {
        const lo = pass === 2 ? 85 + r : T.dist[0], hi = pass === 2 ? 500 : T.dist[1];
        for (let k = 0; k < 500; k++) {
          const a = R(TAU), d = R(lo, hi), x = Math.cos(a) * d, z = Math.sin(a) * d;
          if (!siteOk(x, z, flying ? T.r + T.fly.orbit : r, placed, flying)) continue;
          let score;
          if (flying) score = R(1);
          else { const f = footprintStats(x, z, r); if (f.wet && pass < 2) continue; score = (f.mx - f.mn) + (f.wet ? 50 : 0) + R(4); }
          if (score < bestS) { bestS = score; best = { x, z }; }
        }
      }
      if (!best) continue;
      placed.push({ x: best.x, z: best.z, r: flying ? T.r + T.fly.orbit : r, flying });
      bases.push(buildBase(key, best.x, best.z, bases.length));
    }
  }

  function buildBase(key, x, z, idx) {
    const T = TIERS[key], tint = new THREE.Color(T.tint).offsetHSL(R(-0.03, 0.03), 0, R(-0.05, 0.05));
    const b = {
      idx, tierKey: key, tier: T, name: `${T.label} ${GREEK[(idx * 5 + Math.floor(R(GREEK.length))) % GREEK.length]}`,
      x, z, y: 0, yaw: R(TAU), r: T.r, tint, tintHex: '#' + tint.getHexString(),
      hp: T.hp, maxHp: T.hp, alive: true, critical: 0, critTick: 0, awake: !!T.fly, alertT: 0,
      waveT: T.fly ? 35 : 4, waves: 0, queue: [], queueT: 0, flying: !!T.fly, armyCost: 0,
      pylons: [], turrets: [], reactor: null, hull: [], group: new THREE.Group(), domeFlash: 0, sink: 0,
    };
    const L = baseLayout(key, tint);
    // foundation: highest ground under the footprint, slab reaches below the lowest
    if (b.flying) {
      b.anchor = { x, z }; b.orbA = R(TAU);
      b.orbit = Math.min(T.fly.orbit, BOUND - T.r - 14 - Math.max(Math.abs(x), Math.abs(z)));
      b.x = x + Math.cos(b.orbA) * b.orbit; b.z = z + Math.sin(b.orbA) * b.orbit;
      b.y = hiveAlt(b);
    } else {
      const f = footprintStats(x, z, key === 'fortress' ? T.r * 1.42 : T.r);
      b.y = Math.max(lerp(f.mn, f.mx, 0.75), 0.5) + 0.4;   // partly dug into the high side, plinth on the low side
      const sh = b.y - Math.min(f.mn, 0) + 3;
      b.slabMat = new THREE.MeshPhongMaterial({ color: 0x80858e, flatShading: true });
      const slabGeo = key === 'fortress' ? merge([P(Box(2 * T.r, sh, 2 * T.r), 0xffffff, [0, -sh / 2, 0]), P(Box(2 * T.r + 0.2, 0.5, 2 * T.r + 0.2), tint, [0, -0.35, 0])])
        : merge([P(Cyl(T.r, T.r + 2, sh, key === 'outpost' ? 8 : 12), 0xffffff, [0, -sh / 2, 0]), P(Cyl(T.r + 0.08, T.r + 0.1, 0.5, key === 'outpost' ? 8 : 12, true), tint, [0, -0.35, 0])]);
      b.slabMat.vertexColors = true;
      b.slab = new THREE.Mesh(slabGeo, b.slabMat); b.group.add(b.slab);
    }
    b.group.position.set(b.x, b.y, b.z); b.group.rotation.y = b.yaw;
    b.staticMesh = new THREE.Mesh(merge(L.static), staticMat); b.group.add(b.staticMesh);
    b.tintMat = new THREE.MeshPhongMaterial({ color: tint, flatShading: true, vertexColors: true });
    b.glowMat = new THREE.MeshBasicMaterial({ color: tint.clone().lerp(new THREE.Color(1, 1, 1), 0.35) });
    b.beamMat = new THREE.MeshBasicMaterial({ color: tint.clone().lerp(new THREE.Color(1, 1, 1), 0.3), transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
    b.hull = L.hull; b.hangar = L.hangar;
    // reactor core
    b.reactorMat = new THREE.MeshBasicMaterial({ color: 0xffd27a });
    const rm = new THREE.Mesh(reactorGeo, b.reactorMat); rm.position.fromArray(L.reactor.p); rm.scale.setScalar(L.reactor.r); b.group.add(rm);
    b.reactor = { l: L.reactor.p, r: L.reactor.r, mesh: rm, wp: new THREE.Vector3() };
    // shield dome
    if (T.domeR > 0) {
      const domeGeo = b.flying ? new THREE.SphereGeometry(T.domeR, 20, 12) : new THREE.SphereGeometry(T.domeR, 20, 8, 0, TAU, 0, HP);
      b.domeMat = new THREE.MeshBasicMaterial({ color: tint, transparent: true, opacity: 0.12, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
      b.domeWireMat = new THREE.MeshBasicMaterial({ color: tint, wireframe: true, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false });
      b.dome = new THREE.Group(); b.dome.add(new THREE.Mesh(domeGeo, b.domeMat), new THREE.Mesh(domeGeo, b.domeWireMat));
      b.domeR = T.domeR; b.group.add(b.dome);
    }
    for (const pl of L.pylons) {
      const g = new THREE.Group(); g.position.fromArray(pl.p);
      g.add(new THREE.Mesh(pylonGeo, b.tintMat));
      const orb = new THREE.Mesh(orbGeo, b.glowMat); orb.position.y = 7.6; g.add(orb);
      // power beam from the orb to the top of the dome
      const top = new THREE.Vector3(0, b.flying ? T.domeR * 0.6 : T.domeR * 0.92, 0), from = new THREE.Vector3(pl.p[0], 7.6, pl.p[2]);
      const beam = new THREE.Mesh(beamGeo, b.beamMat); beam.position.copy(from);
      beam.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), top.clone().sub(from).normalize()); beam.scale.set(1, 1, from.distanceTo(top));
      b.group.add(g, beam);
      b.pylons.push({ l: [pl.p[0], 4.5, pl.p[2]], r: 2.2, hp: T.pylonHp, alive: true, mesh: g, beam, wp: new THREE.Vector3() });
    }
    L.turrets.forEach((tp, i) => {
      const [kind, hp] = T.turrets[i % T.turrets.length];
      const g = new THREE.Group(); g.position.fromArray(tp.p);
      const base = new THREE.Mesh(turretBaseGeo, metalMat); if (tp.hang) { base.rotation.x = Math.PI; } g.add(base);
      const head = new THREE.Mesh(kind === 'flak' ? flakHeadGeo : gunHeadGeo, b.tintMat); head.position.y = tp.hang ? -0.9 : 0.7; g.add(head);
      b.group.add(g);
      b.turrets.push({ l: [tp.p[0], tp.p[1] + (tp.hang ? -0.9 : 0.7), tp.p[2]], kind, hp, r: 1.9, alive: true, mesh: g, head, cd: R(1, 3), wp: new THREE.Vector3() });
    });
    root.add(b.group);
    updateBaseWorld(b);
    return b;
  }
  function hiveAlt(b) {
    let g = groundRaw(b.x, b.z);
    for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; g = Math.max(g, groundRaw(b.x + Math.cos(a) * 22, b.z + Math.sin(a) * 22)); }
    return g + b.tier.fly.alt;
  }
  function updateBaseWorld(b) {
    for (const p of b.pylons) toWorld(b, p.l, p.wp);
    for (const t of b.turrets) toWorld(b, t.l, t.wp);
    toWorld(b, b.reactor.l, b.reactor.wp);
    b.domeC = toWorld(b, [0, 0, 0], b.domeC || new THREE.Vector3());
  }
  const shieldsUp = b => b.pylons.reduce((n, p) => n + (p.alive ? 1 : 0), 0);

  function damageBase(b, amt) {
    if (!b.alive || b.critical > 0) return;
    b.hp -= amt; wake(b);
    if (b.hp <= 0) {
      b.hp = 0; b.critical = b.tier.crit; b.critTick = Math.ceil(b.critical);
      sfx.alarm?.(); say(`${b.name} - REACTOR CRITICAL`, 2);
    }
  }
  function wake(b) { if (!b.awake) { b.awake = true; b.waveT = Math.min(b.waveT, 2); } b.alertT = 5; }

  function destroyBase(b) {
    b.alive = false; b.critical = 0;
    const c = b.reactor.wp.clone();
    boom(c, b.tier.blastPow);
    for (let i = 0; i < 7; i++) fxQueue.push({ t: time + 0.15 + i * 0.18, p: new THREE.Vector3(c.x + R(-1, 1) * b.r, c.y + R(0, 6), c.z + R(-1, 1) * b.r), pow: b.tier.blastPow * 0.45 });
    sfx.baseDestroyed ? sfx.baseDestroyed() : sfx.boom?.(2);
    addScore(b.tier.score); say(`${b.name} DESTROYED  +${b.tier.score}`, 3);
    const br = b.tier.blast;
    for (const s of ships) if (!s.dead && s.pos.distanceTo(c) < br) killShip(s, true);
    if (plr.alive && plr.pos.distanceTo(c) < br) plr.ram('CAUGHT IN THE BLAST');
    // wreck: hide the works, scorch the slab, scatter rubble
    b.staticMesh.visible = false; b.reactor.mesh.visible = false; if (b.dome) b.dome.visible = false;
    for (const p of b.pylons) { p.alive = false; p.mesh.visible = false; p.beam.visible = false; }
    for (const t of b.turrets) { t.alive = false; t.mesh.visible = false; }
    if (b.slab) {
      b.slabMat.color.setHex(0x2a2522);
      const parts = []; for (let i = 0; i < 14; i++) { const a = R(TAU), d = R(b.r * 0.8), s = R(1, 3.5); parts.push(P(Box(s * 1.4, s, s), [0x3a3532, 0x24201e, 0x4a3f35][i % 3], [Math.cos(a) * d, s * 0.3, Math.sin(a) * d], [R(1), R(3), R(1)])); }
      b.group.add(new THREE.Mesh(merge(parts), staticMat));
    } else b.group.visible = false;
    const gy = floorAt(c.x, c.z);
    craterList.push({ x: c.x, z: c.z, r: b.flying ? 20 : b.r * 0.8, y: gy });
    b.queue.length = 0;
  }

  function hitBase(b, p, rad, dmg) {
    const dx = p.x - b.x, dz = p.z - b.z, reach = b.r * (b.tierKey === 'fortress' ? 1.45 : 1) + 8 + rad;
    if (dx * dx + dz * dz > reach * reach || !b.group.parent) return false;
    if (b.critical > 0 || !b.alive) {
      if (!b.alive) {   // rubble only stops bullets at the slab
        if (b.slab && p.y < b.y + 0.5 && heightAt(p.x, p.z) > -Infinity) return true;
        return false;
      }
    }
    for (const pl of b.pylons) if (pl.alive && p.distanceToSquared(pl.wp) < (pl.r + rad) ** 2) {
      if (b.critical > 0) return true;
      pl.hp -= dmg; spark(p, b.tint, 6); wake(b);
      if (pl.hp <= 0) {
        pl.alive = false; pl.mesh.visible = false; pl.beam.visible = false; boom(pl.wp, 1.2); sfx.boom?.(0.7); addScore(250);
        const n = shieldsUp(b); say(n ? `SHIELD PYLON DOWN  -  ${n} LEFT` : `${b.name} SHIELDS DOWN`, 1.6);
        if (!n && b.dome) b.dome.visible = false;
      }
      return true;
    }
    for (const t of b.turrets) if (t.alive && p.distanceToSquared(t.wp) < (t.r + rad) ** 2) {
      if (b.critical > 0) return true;
      t.hp -= dmg; spark(p, b.tint, 5); wake(b);
      if (t.hp <= 0) { t.alive = false; t.mesh.visible = false; boom(t.wp, 1); sfx.boom?.(0.6); addScore(150); }
      return true;
    }
    const shields = shieldsUp(b);
    if (shields && b.dome) {
      const d2 = p.distanceToSquared(b.domeC);
      if (d2 < (b.domeR + rad) ** 2 && (b.flying || p.y > b.y - 1)) { b.domeFlash = 1; spark(p, b.tint, 8); wake(b); return true; }
    }
    const l = toLocal(b, p, _v2);
    const rr = b.reactor;
    if (p.distanceToSquared(rr.wp) < (rr.r + rad) ** 2) { if (!shields) { damageBase(b, dmg * 3); spark(p, new THREE.Color(1, 0.8, 0.3), 10); } else spark(p, b.tint, 4); return true; }
    for (const h of b.hull) {
      let inside = false;
      if (h.b) { const q = h.b; inside = l.x > q[0] - rad && l.x < q[3] + rad && l.y > q[1] - rad && l.y < q[4] + rad && l.z > q[2] - rad && l.z < q[5] + rad; }
      else { const e = h.e; inside = (l.x / (e[0] + rad)) ** 2 + (l.y / (e[1] + rad)) ** 2 + (l.z / (e[2] + rad)) ** 2 < 1; }
      if (inside) { if (!shields) damageBase(b, dmg); spark(p, shields ? b.tint : new THREE.Color(1, 0.7, 0.4), 4); return true; }
    }
    if (b.slab && p.y < b.y + 0.2 && heightAt(p.x, p.z) > -Infinity) { spark(p, new THREE.Color(0.8, 0.8, 0.8), 3); return true; }
    return false;
  }

  function updateBase(b, dt) {
    const T = b.tier, P = plr.pos;
    if (!b.alive) return;
    if (b.flying) {
      if (b.critical > 0) { b.sink += dt; b.y -= dt * (2 + b.sink * 3); b.group.rotation.z = Math.sin(b.sink * 0.8) * 0.15 * b.sink; }
      else {
        b.orbA += T.fly.speed / Math.max(b.orbit, 20) * dt;
        b.x = b.anchor.x + Math.cos(b.orbA) * b.orbit; b.z = b.anchor.z + Math.sin(b.orbA) * b.orbit;
        b.y = lerp(b.y, hiveAlt(b), 1 - Math.exp(-0.5 * dt)); b.yaw += dt * 0.06;
      }
      b.group.position.set(b.x, b.y, b.z); b.group.rotation.y = b.yaw;
      updateBaseWorld(b);
      if (b.critical > 0 && b.y < floorAt(b.x, b.z) + 6) b.critical = Math.min(b.critical, 0.001);
    }
    const dP = Math.hypot(P.x - b.x, P.z - b.z);
    b.group.visible = dP < drawDist + b.r + 40;
    b.alertT -= dt;
    if (plr.alive && dP < T.wakeR) wake(b);
    // visuals
    const shields = shieldsUp(b);
    if (b.dome) {
      b.domeFlash = Math.max(0, b.domeFlash - dt * 3);
      b.dome.visible = shields > 0;
      b.domeMat.opacity = 0.05 + 0.05 * shields / T.pylons + 0.25 * b.domeFlash + 0.02 * Math.sin(time * 3 + b.idx);
      b.domeWireMat.opacity = 0.12 + 0.18 * shields / T.pylons + 0.4 * b.domeFlash;
    }
    const rm = b.reactor.mesh;
    if (b.critical > 0) {
      const f = (Math.sin(time * (10 + 20 / Math.max(b.critical, 0.3))) > 0) ? 1 : 0;
      b.reactorMat.color.setRGB(1, f ? 1 : 0.1, f ? 1 : 0.05); rm.scale.setScalar(b.reactor.r * (1.1 + 0.25 * f));
      b.critical -= dt;
      const tick = Math.ceil(b.critical);
      if (tick < b.critTick && tick > 0) { b.critTick = tick; sfx.alarm?.(); if (dP < 350) say(`REACTOR CRITICAL  ${tick}`, 0.9); }
      if (b.critical <= 0) destroyBase(b);
      return;
    }
    const pulse = 1 + 0.08 * Math.sin(time * 4 + b.idx);
    rm.scale.setScalar(b.reactor.r * pulse); rm.rotation.y += dt;
    if (shields) b.reactorMat.color.setRGB(1, 0.82, 0.48); else b.reactorMat.color.setRGB(1, 0.45 + 0.3 * Math.sin(time * 6), 0.2);
    // turrets
    const tierScale = 1 - 0.12 * T.rank;
    if (plr.alive) for (const t of b.turrets) {
      if (!t.alive) continue;
      const d = t.wp.distanceTo(P), range = t.kind === 'flak' ? 115 : 125;
      if (d > range + 40) continue;
      if (b.group.visible) { b.group.updateMatrixWorld(); t.head.lookAt(P); }
      t.cd -= dt * diff;
      if (d < range && t.cd <= 0) {
        wake(b);
        if (t.kind === 'flak') {
          t.cd = (2.4 + R(0.8)) * tierScale;
          for (let k = 0; k < 5; k++) fireAt(t.wp, P, plr.vel, 42, 0.12, 0.5, 1, 'flak', 2);
        } else { t.cd = (1.7 + R(0.9)) * tierScale; fireAt(t.wp, P, plr.vel, 55, 0.025, 0.7, 1, 'shell', 2); }
      }
    }
    // waves: spawn while awake and under budget
    const budget = Math.min(T.budget * 3, T.budget + T.grow * b.waves + time / 60);
    if (b.awake) {
      b.waveT -= dt;
      if (b.waveT <= 0 && b.queue.length === 0) {
        if (b.armyCost < budget && ships.length < maxShips) launchWave(b, budget);
        b.waveT = T.spawn * R(0.85, 1.15) / (1 + time / 400);
      }
    }
    if (b.queue.length) {
      b.queueT -= dt;
      if (b.queueT <= 0 && ships.length < maxShips) { const q = b.queue.shift(); spawnShip(q.type, b, q.squad, 'launch'); b.queueT = 0.45; }
    }
  }
  function composeWave(b, pts) {
    const out = [], WT = b.tier.roster;
    while (pts > 0 && out.length < 12) {
      const ok = k => ROSTER[k].cost <= pts && (TYPE_CAP[k] === undefined || countOf(b, k) + out.filter(x => x === k).length < TYPE_CAP[k]);
      let tot = 0; for (const k in WT) if (ok(k)) tot += WT[k];
      if (!tot) break;
      let r = R(tot), pick = null;
      for (const k in WT) { if (!ok(k)) continue; r -= WT[k]; if (r <= 0) { pick = k; break; } }
      pick = pick || Object.keys(WT).find(ok);
      out.push(pick); pts -= ROSTER[pick].cost;
    }
    return out;
  }
  const countOf = (b, k) => { let n = 0; for (const s of ships) if (s.base === b && s.type === k && !s.dead) n++; for (const q of b.queue) if (q.type === k) n++; return n; };
  function launchWave(b, budget) {
    const list = composeWave(b, Math.min(b.tier.wave + b.waves * 0.5, budget - b.armyCost + 1));
    if (!list.length) return;
    b.waves++; waveNo++;
    const squad = { members: [], leader: null, engaged: false };
    for (const type of list) b.queue.push({ type, squad: type === 'seeder' || type === 'carrier' ? null : squad });
    sfx.waveStart?.(waveNo);
    if (Math.hypot(plr.pos.x - b.x, plr.pos.z - b.z) < 240 && time > waveSayT) { waveSayT = time + 10; say(`WAVE ${waveNo}  -  ${b.name} LAUNCHING`, 1.8); }
  }

  // ================================================================ ships
  function spawnShip(type, b, squad, state, at) {
    const d = ROSTER[type];
    const s = {
      id: nextId++, type, def: d, base: b, tint: b.tint, tintHex: b.tintHex, hp: d.hp, maxHp: d.hp, state, t: 0, sub: null, subT: 0,
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: R(TAU), pitch: 0, bank: 0, fireT: R(1, d.fire || 2), burst: 0, burstT: 0,
      flash: 0, lodAcc: 0, hidden: false, dead: false, squad: null, slot: 0, orb: R(TAU), ph: R(TAU), kids: 0, parent: null, launchT: R(2, 4),
      seedD: 0, wp: null, runs: 0, target: new THREE.Vector3(), extend: new THREE.Vector3(),
    };
    if (at) s.pos.copy(at); else { toWorld(b, b.hangar, s.pos); s.pos.x += R(-1, 1); s.pos.z += R(-1, 1); }
    s.vel.set(0, b.flying ? -6 : 8, 0);
    if (squad) { s.squad = squad; s.slot = squad.members.length; squad.members.push(s); if (!squad.leader) squad.leader = s; }
    b.armyCost += d.cost;
    ships.push(s);
    return s;
  }
  function killShip(s, scored) {
    if (s.dead) return;
    s.dead = true; s.base.armyCost -= s.def.cost;
    boom(s.pos, s.def.boom); sfx.boom?.(Math.min(1.4, 0.4 + s.def.boom * 0.3));
    if (scored) addScore(s.def.score);
    if (s.squad) { const m = s.squad.members, i = m.indexOf(s); if (i >= 0) m.splice(i, 1); if (s.squad.leader === s) s.squad.leader = m[0] || null; m.forEach((x, k) => x.slot = k); }
    if (s.parent) s.parent.kids--;
  }
  function damageShip(s, dmg) {
    s.hp -= dmg; s.flash = 0.12;
    if (s.hp <= 0) { killShip(s, true); return; }
    if (s.state === 'patrol' || s.state === 'form') engage(s);
    wake(s.base);
  }
  function engage(s) {
    if (s.type === 'seeder') return;
    const set = s.squad ? s.squad.members : [s];
    for (const m of set) if (m.state === 'patrol' || m.state === 'form' || m.state === 'return') { m.state = 'attack'; m.t = 0; m.sub = null; }
    if (s.squad) s.squad.engaged = true;
    wake(s.base);
  }
  function fireAt(from, tgt, tvel, spd, spread, lead, dmg, kind, life = 3) {
    spread *= 1.6 - 0.6 * diff;
    const dist = from.distanceTo(tgt), t = dist / spd;
    _v.copy(tgt).addScaledVector(tvel, t * lead); _v.y += 0.5 * BULLET_G * t * t;
    _v.sub(from).normalize();
    _v.x += R(-spread, spread); _v.y += R(-spread, spread) * 0.6; _v.z += R(-spread, spread); _v.normalize();
    shoot({ p: from.clone().addScaledVector(_v, 2.5), v: _v.clone().multiplyScalar(spd), own: false, dmg, life: Math.min(life, dist / spd + 0.8), kind });
    shotsRecent += 1;
    if (shotSfxT <= 0) { sfx.enemyShot?.(); shotSfxT = 0.09; }
  }
  // velocity helpers
  function seek(dv, tx, ty, tz, s, spd, arrive = 0) {
    const dx = tx - s.pos.x, dz = tz - s.pos.z, h = Math.hypot(dx, dz) || 1;
    const k = arrive > 0 ? Math.min(1, h / arrive) : 1;
    dv.x = dx / h * spd * k; dv.z = dz / h * spd * k; dv.y = clamp((ty - s.pos.y) * 1.2, -12, 12);
    return h;
  }
  const cruiseY = (s, x, z, alt) => floorAt(x, z) + alt;

  function stepShip(s, dt) {
    const d = s.def, P = plr.pos, pa = plr.alive, home = s.base;
    s.t += dt; s.fireT -= dt * diff;
    const dist = s.pos.distanceTo(P);
    const dv = _dv.set(0, 0, 0);
    let faceP = false, spd = d.speed;
    if (!home.alive && s.state !== 'launch' && s.type !== 'seeder' && pa && s.state !== 'attack') { s.state = 'attack'; s.sub = null; }

    switch (s.state) {
      case 'launch': {
        dv.set(Math.sin(s.yaw) * 4, home.flying ? -8 : 9, Math.cos(s.yaw) * 4);
        if (s.t > (home.flying ? 1.0 : 1.5)) { s.state = s.type === 'seeder' ? 'seed' : (s.squad && s.squad.leader !== s ? 'form' : 'patrol'); s.t = 0; if (s.squad?.engaged) s.state = 'attack'; }
        break;
      }
      case 'form': {
        const L = s.squad && s.squad.leader;
        if (!L || L === s || L.dead) { s.state = 'patrol'; break; }
        if (L.state === 'attack') { s.state = 'attack'; s.sub = null; break; }
        const side = s.slot % 2 ? 1 : -1, rank = Math.ceil(s.slot / 2);
        const c = Math.cos(L.yaw), sn = Math.sin(L.yaw), ox = side * rank * 7, oz = -rank * 6;
        const tx = L.pos.x + ox * c + oz * sn, tz = L.pos.z - ox * sn + oz * c, ty = Math.max(L.pos.y + rank * 1.2, cruiseY(s, tx, tz, d.minAlt + 3));
        dv.set((tx - s.pos.x) * 1.4 + L.vel.x, clamp((ty - s.pos.y) * 1.4, -12, 12), (tz - s.pos.z) * 1.4 + L.vel.z);
        const m = Math.hypot(dv.x, dv.z), cap = d.speed * 1.3; if (m > cap) { dv.x *= cap / m; dv.z *= cap / m; }
        break;
      }
      case 'patrol': case 'return': {
        let sp = d.speed * 0.6;
        if (s.squad && s.squad.leader === s) for (const m of s.squad.members) sp = Math.min(sp, m.def.speed * 0.55);   // formation pace
        const rad = home.tier.patrolR + (s.type === 'carrier' ? 30 : 0) + (s.id % 5) * 4;
        if (s.state === 'return') {
          const h = seek(dv, home.x, cruiseY(s, s.pos.x, s.pos.z, d.alt), home.z, s, d.speed * 0.8);
          if (h < rad + 15) { s.state = 'patrol'; s.t = 0; }
        } else {
          s.orb += sp / rad * dt;
          const tx = home.x + Math.cos(s.orb) * rad, tz = home.z + Math.sin(s.orb) * rad;
          seek(dv, tx, cruiseY(s, tx, tz, d.alt), tz, s, sp);
        }
        if (pa && d.aggro && (dist < d.aggro * (home.awake ? 1 : 0.7) || (home.alertT > 0 && dist < d.aggro * 2))) engage(s);
        break;
      }
      case 'retreat': case 'repair': {
        const h = seek(dv, home.x, cruiseY(s, home.x, home.z, d.alt), home.z, s, d.speed * (s.state === 'repair' ? 0.3 : 0.9), 20);
        if (h < home.r + 14) s.state = 'repair';
        if (s.state === 'repair') { s.hp = Math.min(s.maxHp, s.hp + s.maxHp / 8 * dt); if (s.hp >= s.maxHp) { s.state = 'patrol'; s.t = 0; } }
        break;
      }
      case 'seed': {   // Zarch virus homage: skim the ground, leave infection, run from the player
        if (!s.wp || s.pos.distanceTo(_v.set(s.wp.x, s.pos.y, s.wp.z)) < 8 || s.t > 25) {
          s.t = 0;
          const a = R(TAU), r = R(30, 170), cx = rng() < 0.35 ? 0 : home.x, cz = rng() < 0.35 ? 0 : home.z;
          s.wp = { x: clamp(cx + Math.cos(a) * r, -BOUND + 20, BOUND - 20), z: clamp(cz + Math.sin(a) * r, -BOUND + 20, BOUND - 20) };
        }
        let tx = s.wp.x, tz = s.wp.z, sp = d.speed;
        if (pa && dist < d.flee) { tx = s.pos.x - (P.x - s.pos.x) * 3; tz = s.pos.z - (P.z - s.pos.z) * 3; sp = d.speed * 1.5; }
        seek(dv, tx, cruiseY(s, s.pos.x, s.pos.z, d.alt), tz, s, sp);
        const moved = Math.hypot(s.vel.x, s.vel.z) * dt;
        s.seedD += moved;
        if (s.seedD > d.seedEvery) { s.seedD = 0; dropInfection(s.pos.x, s.pos.z); }
        break;
      }
      case 'attack': attack(s, dv, dist, dt); faceP = s.type === 'gunship'; break;
    }
    if (s.state === 'attack' && home.alive && d.retreat && s.hp < s.maxHp * 0.35) { s.state = 'retreat'; s.sub = null; }

    // separation (grid), terrain avoidance, bounds
    separate(s, dv);
    const ax = s.pos.x + s.vel.x * 0.9, az = s.pos.z + s.vel.z * 0.9, bx = s.pos.x + s.vel.x * 1.8, bz = s.pos.z + s.vel.z * 1.8;
    const floor = Math.max(floorAt(s.pos.x, s.pos.z), floorAt(ax, az), floorAt(bx, bz) - 2) + d.minAlt;
    if (s.pos.y < floor) dv.y = Math.max(dv.y, (floor - s.pos.y) * 2.5 + 3);
    const edge = BOUND - 8;
    if (Math.abs(s.pos.x) > edge) dv.x = -Math.sign(s.pos.x) * d.speed;
    if (Math.abs(s.pos.z) > edge) dv.z = -Math.sign(s.pos.z) * d.speed;
    s.vel.lerp(dv, 1 - Math.exp(-d.agility * dt));
    const vm = s.vel.length(), vmax = d.speed * 1.4; if (vm > vmax) s.vel.multiplyScalar(vmax / vm);
    s.pos.addScaledVector(s.vel, dt);
    const hard = floorAt(s.pos.x, s.pos.z) + 0.8; if (s.pos.y < hard) { s.pos.y = hard; if (s.vel.y < 0) s.vel.y = 0; }
    s.pos.x = clamp(s.pos.x, -BOUND, BOUND); s.pos.z = clamp(s.pos.z, -BOUND, BOUND);
    // orientation
    const hs = Math.hypot(s.vel.x, s.vel.z);
    let wantYaw = s.yaw;
    if (faceP) wantYaw = Math.atan2(P.x - s.pos.x, P.z - s.pos.z);
    else if (hs > 1) wantYaw = Math.atan2(s.vel.x, s.vel.z);
    let dy = wantYaw - s.yaw; dy = Math.atan2(Math.sin(dy), Math.cos(dy));
    const turn = dy * (1 - Math.exp(-5 * dt)); s.yaw += turn;
    s.bank = lerp(s.bank, clamp(-turn / Math.max(dt, 1e-3) * 0.35, -0.9, 0.9) * (s.type === 'carrier' ? 0.2 : 1), 1 - Math.exp(-4 * dt));
    s.pitch = lerp(s.pitch, -Math.atan2(s.vel.y, Math.max(hs, 6)) * 0.8, 1 - Math.exp(-4 * dt));
    // ramming
    if (pa && dist < d.r + 1.8) { plr.ram('RAMMED'); damageShip(s, 6); }
  }

  function attack(s, dv, dist, dt) {
    const d = s.def, P = plr.pos, home = s.base;
    if (!plr.alive || (home.alive && dist > d.aggro * 1.8 && s.type !== 'bomber')) { s.state = 'return'; s.sub = null; return; }
    switch (s.type) {
      case 'scout': {   // swarm: orbit the player, pot-shots
        s.ph += dt * (1.0 + (s.id % 3) * 0.2);
        const r = 20 + (s.id % 4) * 4, tx = P.x + Math.cos(s.ph) * r, tz = P.z + Math.sin(s.ph) * r;
        seek(dv, tx, Math.max(P.y + 4 + Math.sin(s.ph * 2) * 4, cruiseY(s, tx, tz, d.minAlt)), tz, s, d.speed);
        if (s.fireT <= 0 && dist < 75) { s.fireT = d.fire * R(0.7, 1.4); fireAt(s.pos, P, plr.vel, d.bspd, d.spread, d.lead, d.dmg, 'laser'); }
        break;
      }
      case 'fighter': {   // strafing runs: dive at the player, pass, extend, come round
        if (!s.sub) s.sub = 'run';
        if (s.sub === 'run') {
          _v.copy(P).addScaledVector(plr.vel, dist / d.speed * 0.5);
          seek(dv, _v.x, Math.max(_v.y + 2, cruiseY(s, s.pos.x, s.pos.z, d.minAlt)), _v.z, s, d.speed * 1.15);
          dv.y = clamp((_v.y + 2 - s.pos.y) * 1.5, -18, 14);
          _v2.subVectors(P, s.pos).normalize();
          const facing = s.vel.lengthSq() > 1 ? _v2.dot(_v.copy(s.vel).normalize()) : 0;
          if (s.fireT <= 0 && dist < 95 && facing > 0.94) { s.burst = d.burst; s.fireT = d.fire; }
          if (dist < 20) { s.sub = 'extend'; s.subT = 2.4; s.extend.set(s.vel.x, 0, s.vel.z).normalize(); }
        } else {
          s.subT -= dt;
          dv.set(s.extend.x * d.speed, clamp((cruiseY(s, s.pos.x, s.pos.z, d.alt) - s.pos.y) * 1.2, -8, 10), s.extend.z * d.speed);
          if (s.subT <= 0) s.sub = 'run';
        }
        break;
      }
      case 'interceptor': {   // fast pursuit, full lead
        _v.copy(P).addScaledVector(plr.vel, Math.min(dist / d.speed, 1.5));
        const off = dist < 28 ? 1 : 0;
        if (off) { _v.x += Math.cos(s.ph) * 40; _v.z += Math.sin(s.ph) * 40; s.ph += dt * 0.5; }
        seek(dv, _v.x, Math.max(P.y + 3, cruiseY(s, s.pos.x, s.pos.z, d.minAlt)), _v.z, s, d.speed);
        _v2.subVectors(P, s.pos).normalize();
        const facing = s.vel.lengthSq() > 1 ? _v2.dot(_v.copy(s.vel).normalize()) : 0;
        if (s.fireT <= 0 && dist < 110 && facing > 0.9) { s.burst = d.burst; s.fireT = d.fire * R(0.9, 1.3); }
        break;
      }
      case 'gunship': {   // hold at standoff range, strafe sideways, triple-barrel volleys
        const want = 50, dx = s.pos.x - P.x, dz = s.pos.z - P.z, h = Math.hypot(dx, dz) || 1;
        const k = (h - want) * -0.6;
        dv.x = dx / h * k + (-dz / h) * Math.sin(s.t * 0.4 + s.ph) * 6; dv.z = dz / h * k + (dx / h) * Math.sin(s.t * 0.4 + s.ph) * 6;
        const m = Math.hypot(dv.x, dv.z); if (m > d.speed) { dv.x *= d.speed / m; dv.z *= d.speed / m; }
        dv.y = clamp((Math.max(P.y + 8, cruiseY(s, s.pos.x, s.pos.z, d.minAlt)) - s.pos.y) * 0.8, -6, 8);
        if (s.fireT <= 0 && dist < 85) {
          s.fireT = d.fire * R(0.9, 1.2);
          const c = Math.cos(s.yaw), sn = Math.sin(s.yaw);
          for (const side of [-1, 1]) {
            _v2.set(s.pos.x + side * 2.1 * c + 2.6 * sn, s.pos.y - 0.2, s.pos.z - side * 2.1 * sn + 2.6 * c);
            for (let b = 0; b < d.barrels; b++) fireAt(_v2, P, plr.vel, d.bspd, d.spread, d.lead, d.dmg, 'shell');
          }
        }
        break;
      }
      case 'bomber': {   // bombing runs on the home pad or wherever the player is lurking
        if (!s.sub) {
          s.sub = 'approach'; s.runs++;
          if (rng() < 0.5 || P.y - floorAt(P.x, P.z) > 30) s.target.set(R(-8, 8), PAD_H, R(-8, 8)); else s.target.set(P.x, floorAt(P.x, P.z), P.z);
        }
        const ty = Math.max(cruiseY(s, s.pos.x, s.pos.z, d.alt), s.target.y + 26);
        if (s.sub === 'approach') {
          const h = seek(dv, s.target.x, ty, s.target.z, s, d.speed);
          if (h < 10) { s.sub = 'drop'; s.subT = 1.8; s.fireT = 0; s.extend.set(s.vel.x, 0, s.vel.z).normalize(); }
        } else if (s.sub === 'drop') {
          dv.set(s.extend.x * d.speed, 0, s.extend.z * d.speed); s.subT -= dt;
          if (s.fireT <= 0) { s.fireT = d.fire; dropBomb(s); }
          if (s.subT <= 0) { s.sub = 'egress'; s.subT = 5; }
        } else {
          dv.set(s.extend.x * d.speed, clamp((ty + 6 - s.pos.y), -6, 6), s.extend.z * d.speed); s.subT -= dt;
          if (s.subT <= 0) { s.sub = null; if (s.runs >= 2) { s.runs = 0; s.state = 'return'; } }
        }
        break;
      }
      case 'carrier': {   // keep high and back, launch scouts, a defensive gun
        const want = 90, dx = s.pos.x - P.x, dz = s.pos.z - P.z, h = Math.hypot(dx, dz) || 1, k = (h - want) * -0.3;
        dv.x = dx / h * k; dv.z = dz / h * k;
        const m = Math.hypot(dv.x, dv.z); if (m > d.speed) { dv.x *= d.speed / m; dv.z *= d.speed / m; }
        dv.y = clamp((cruiseY(s, s.pos.x, s.pos.z, d.alt) - s.pos.y) * 0.6, -5, 5);
        s.launchT -= dt;
        if (s.launchT <= 0 && s.kids < d.kids && ships.length < maxShips) {
          s.launchT = d.launch;
          _v2.copy(s.pos); _v2.y -= 2;
          const kid = spawnShip('scout', s.base, null, 'attack', _v2); kid.parent = s; kid.vel.copy(s.vel); kid.vel.y = -3; s.kids++;
        }
        if (s.fireT <= 0 && dist < 100) { s.fireT = d.fire * R(0.8, 1.3); fireAt(s.pos, P, plr.vel, d.bspd, d.spread, d.lead, d.dmg, 'shell'); }
        break;
      }
      default: seek(dv, P.x, P.y + 5, P.z, s, d.speed);
    }
    // bursts (fighter / interceptor)
    if (s.burst > 0) {
      s.burstT -= dt;
      if (s.burstT <= 0) { s.burst--; s.burstT = s.type === 'fighter' ? 0.12 : 0.16; fireAt(s.pos, P, plr.vel, d.bspd, d.spread, d.lead, d.dmg, s.type === 'interceptor' ? 'lead' : 'laser'); }
    }
  }

  // spatial hash for separation
  let grid = new Map();
  const GC = 14;
  function buildGrid() {
    grid.clear();
    for (const s of ships) { if (s.dead) continue; const k = Math.floor(s.pos.x / GC) * 4096 + Math.floor(s.pos.z / GC); let a = grid.get(k); if (!a) grid.set(k, a = []); a.push(s); }
  }
  function separate(s, dv) {
    const gx = Math.floor(s.pos.x / GC), gz = Math.floor(s.pos.z / GC);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      const a = grid.get((gx + i) * 4096 + gz + j); if (!a) continue;
      for (const o of a) {
        if (o === s || o.dead) continue;
        const rr = (s.def.r + o.def.r) * 1.4 + 1;
        const dx = s.pos.x - o.pos.x, dy = s.pos.y - o.pos.y, dz = s.pos.z - o.pos.z, d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < rr * rr && d2 > 1e-6) {
          const d = Math.sqrt(d2), f = (rr - d) / rr * 14 * (o.def.r >= s.def.r ? 1 : 0.5);
          dv.x += dx / d * f; dv.y += dy / d * f * 0.6; dv.z += dz / d * f;
        }
      }
    }
  }

  // ================================================================ bombs, infection, sparks
  function dropBomb(s) {
    if (bombs.length > 80) return;
    bombs.push({ p: s.pos.clone().add(_v.set(0, -1.2, 0)), v: s.vel.clone().multiplyScalar(0.8), dmg: s.def.dmg });
  }
  function detonateBomb(bm, onGround) {
    boom(bm.p, onGround ? 1.4 : 0.8); sfx.boom?.(0.6);
    if (onGround) {
      craterList.push({ x: bm.p.x, z: bm.p.z, r: 3.5, y: bm.p.y }); if (craterList.length > 300) craterList.shift();
      if (Math.hypot(bm.p.x, bm.p.z) < 24) {
        homeHits++; ctx.homeHit?.(bm.dmg);
        if (time > homeSayT) { homeSayT = time + 6; say('YOUR BASE IS UNDER ATTACK', 1.6); }
      }
    }
    if (plr.alive && plr.pos.distanceTo(bm.p) < 6) plr.ram('BOMBED');
  }
  function dropInfection(x, z) {
    if (ctx.terrainH(x, z) <= 0.5 || Math.hypot(x, z) < 20) return;
    for (let i = infect.length - 1; i >= Math.max(0, infect.length - 24); i--) {
      const q = infect[i]; if (Math.hypot(q.x - x, q.z - z) < 4) { q.max = Math.min(9, q.max + 0.6); return; }
    }
    infect.push({ x, z, r: 1, max: 5 + R(2), born: time });
    if (infect.length > 800) infect.shift();
    infectVer++;
  }
  function spark(p, c, n) {
    for (let i = 0; i < n && sparks.length < 400; i++) sparks.push({ x: p.x, y: p.y, z: p.z, vx: R(-8, 8), vy: R(-3, 9), vz: R(-8, 8), life: R(0.25, 0.6), r: c.r, g: c.g, b: c.b });
  }

  // ================================================================ public API
  function update(dt, player) {
    if (player) plr = player;
    time += dt; shotSfxT -= dt;
    for (const b of bases) updateBase(b, dt);
    buildGrid();
    const P = plr.pos, far2 = drawDist * drawDist;
    for (const s of ships) {
      if (s.dead) continue;
      s.flash = Math.max(0, s.flash - dt);
      const d2 = s.pos.distanceToSquared(P);
      s.hidden = d2 > far2;
      if (s.hidden) { s.lodAcc += dt; if (s.lodAcc < 0.25) continue; stepShip(s, s.lodAcc); s.lodAcc = 0; }
      else stepShip(s, dt);
    }
    // bombs
    for (let i = bombs.length - 1; i >= 0; i--) {
      const bm = bombs[i]; bm.v.y -= 9.8 * dt; bm.p.addScaledVector(bm.v, dt);
      if (bm.p.y <= floorAt(bm.p.x, bm.p.z)) { bm.p.y = floorAt(bm.p.x, bm.p.z); detonateBomb(bm, true); bombs[i] = bombs[bombs.length - 1]; bombs.pop(); }
    }
    for (let i = fxQueue.length - 1; i >= 0; i--) if (fxQueue[i].t <= time) { boom(fxQueue[i].p, fxQueue[i].pow); fxQueue.splice(i, 1); }
    // infection grows
    for (const q of infect) if (q.r < q.max) { q.r = Math.min(q.max, q.r + dt * 0.25); }
    if (infect.length && (time * 4 | 0) !== ((time - dt) * 4 | 0)) infectVer++;
    // compact dead
    let w = 0; for (let i = 0; i < ships.length; i++) if (!ships[i].dead) ships[w++] = ships[i]; ships.length = w;
    // base / player collisions
    if (plr.alive) for (const b of bases) if (b.alive) collideBase(b);
    // intensity: engaged army near the player, incoming fire, critical reactors
    let eng = 0; for (const s of ships) if (s.state === 'attack' && !s.hidden && s.pos.distanceToSquared(P) < 160 * 160) eng += s.def.cost;
    let crit = 0, near = 0;
    for (const b of bases) { const d = Math.hypot(P.x - b.x, P.z - b.z); if (b.critical > 0 && d < 250) crit = 1; if (b.alive && b.awake && d < 200) near = Math.max(near, 1 - d / 200); }
    const raw = plr.alive ? clamp(clamp(eng / 18, 0, 1) * 0.6 + clamp(shotsRecent / 12, 0, 1) * 0.2 + crit * 0.35 + near * 0.15, 0, 1) : 0.05;
    intens = lerp(intens, raw, 1 - Math.exp(-(raw > intens ? 2 : 0.5) * dt));
    render(dt);
  }
  function collideBase(b) {
    const P = plr.pos, dx = P.x - b.x, dz = P.z - b.z, reach = b.r * 1.45 + 10;
    if (dx * dx + dz * dz > reach * reach) return;
    if (b.dome && shieldsUp(b) && P.distanceTo(b.domeC) < b.domeR + 1.2 && (b.flying || P.y > b.y - 1)) { b.domeFlash = 1; plr.ram('HIT THE SHIELD'); return; }
    const l = toLocal(b, P, _v2), rad = 1.2;
    for (const h of b.hull) {
      let inside;
      if (h.b) { const q = h.b; inside = l.x > q[0] - rad && l.x < q[3] + rad && l.y > q[1] - rad && l.y < q[4] + rad && l.z > q[2] - rad && l.z < q[5] + rad; }
      else { const e = h.e; inside = (l.x / (e[0] + rad)) ** 2 + (l.y / (e[1] + rad)) ** 2 + (l.z / (e[2] + rad)) ** 2 < 1; }
      if (inside) { plr.ram('CRASHED INTO THE BASE'); return; }
    }
    for (const p of b.pylons) if (p.alive && P.distanceTo(p.wp) < p.r + 1.4) { plr.ram('CRASHED INTO A PYLON'); return; }
  }

  function render(dt) {
    for (const t of SHIP_TYPES) meshes[t].count = 0;
    fx.n = 0;
    for (const s of ships) {
      if (s.hidden) continue;
      const m = meshes[s.type], i = m.count; if (i >= CAP) continue; m.count++;
      _e.set(s.pitch, s.yaw, s.bank); _q.setFromEuler(_e);
      _m.compose(s.pos, _q, _one); m.setMatrixAt(i, _m);
      m.setColorAt(i, s.flash > 0 ? _white : _c.copy(s.tint).multiplyScalar(s.state === 'repair' ? 0.6 : 1));
      // engine glow behind the ship
      const L = SHIP_LEN[s.type], cp = Math.cos(s.pitch);
      const fxp = s.type === 'seeder' ? 1 : 0;
      fx.add(s.pos.x - Math.sin(s.yaw) * cp * L, s.pos.y + Math.sin(s.pitch) * L - fxp * 1.2, s.pos.z - Math.cos(s.yaw) * cp * L,
        s.tint.r * 0.6 + 0.4, s.tint.g * 0.6 + 0.35, s.tint.b * 0.6 + 0.2);
    }
    for (const t of SHIP_TYPES) { const m = meshes[t]; m.instanceMatrix.needsUpdate = true; m.instanceColor.needsUpdate = true; }
    for (const bm of bombs) { fx.add(bm.p.x, bm.p.y, bm.p.z, 1, 0.5, 0.1); fx.add(bm.p.x - bm.v.x * 0.03, bm.p.y - bm.v.y * 0.03, bm.p.z - bm.v.z * 0.03, 0.5, 0.2, 0.05); }
    for (let i = sparks.length - 1; i >= 0; i--) {
      const p = sparks[i]; p.life -= dt;
      if (p.life <= 0) { sparks[i] = sparks[sparks.length - 1]; sparks.pop(); continue; }
      p.vy -= 12 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      const f = Math.min(1, p.life * 3); fx.add(p.x, p.y, p.z, p.r * f + 0.3 * f, p.g * f + 0.3 * f, p.b * f + 0.3 * f);
    }
    if (showInfection) {
      const P = plr.pos, dd = drawDist * drawDist;
      for (const q of infect) {
        const dx = q.x - P.x, dz = q.z - P.z; if (dx * dx + dz * dz > dd) continue;
        const y = groundRaw(q.x, q.z) + 0.4, k = 0.35 + 0.15 * Math.sin(time * 3 + q.x);
        fx.add(q.x, y, q.z, 0.45 * k, 1.0 * k, 0.2 * k);
        if (q.r > 2) { const a = q.x * 7 + q.z; fx.add(q.x + Math.cos(a) * q.r * 0.6, y, q.z + Math.sin(a) * q.r * 0.6, 0.3 * k, 0.8 * k, 0.15 * k); }
      }
    }
    fx.end();
  }

  function hitTest(p, radius = 0.5, dmg = 1) {
    for (const s of ships) {
      if (s.dead) continue;
      const r = s.def.r + radius;
      if (Math.abs(s.pos.x - p.x) > r || Math.abs(s.pos.z - p.z) > r || Math.abs(s.pos.y - p.y) > r) continue;
      if (s.pos.distanceToSquared(p) < r * r) { damageShip(s, dmg); spark(p, s.tint, 4); return true; }
    }
    for (let i = 0; i < bombs.length; i++) if (bombs[i].p.distanceToSquared(p) < (1.2 + radius) ** 2) {
      detonateBomb(bombs[i], false); bombs[i] = bombs[bombs.length - 1]; bombs.pop(); addScore(25); return true;
    }
    for (const b of bases) if (hitBase(b, p, radius, dmg)) return true;
    return false;
  }

  function reset(seed = 1) {
    rng = mulberry32((seed >>> 0) || 1);
    for (const b of bases) { root.remove(b.group); b.group.traverse(o => { if (o.isMesh && o.geometry !== reactorGeo && o.geometry !== pylonGeo && o.geometry !== orbGeo && o.geometry !== beamGeo && o.geometry !== turretBaseGeo && o.geometry !== gunHeadGeo && o.geometry !== flakHeadGeo) o.geometry.dispose(); }); }
    bases = []; ships = []; bombs = []; sparks = []; infect = []; craterList = []; fxQueue = [];
    time = 0; waveNo = 0; waveSayT = 0; intens = 0; shotsRecent = 0; homeHits = 0; infectVer++;
    placeBases();
    // standing patrols so the world is alive before anything wakes
    for (const b of bases) {
      const list = composeWave(b, Math.ceil(b.tier.wave * 0.5));
      const squad = { members: [], leader: null, engaged: false };
      for (const type of list) {
        if (ships.length >= maxShips) break;
        const a = R(TAU), at = new THREE.Vector3(b.x + Math.cos(a) * b.tier.patrolR, 0, b.z + Math.sin(a) * b.tier.patrolR);
        at.y = floorAt(at.x, at.z) + ROSTER[type].alt;
        const s = spawnShip(type, b, type === 'seeder' ? null : squad, type === 'seeder' ? 'seed' : 'patrol', at);
        if (s.squad && s.squad.leader !== s) { s.state = 'form'; s.pos.x += R(-10, 10); s.pos.z += R(-10, 10); }
        s.orb = a; s.vel.set(0, 0, 0);
      }
    }
    render(0);
  }

  reset(ctx.seed ?? 1);

  return {
    update, hitTest, reset,
    contacts() {
      const out = [];
      for (const b of bases) if (b.alive) out.push({ x: b.x, z: b.z, kind: 'base', tier: b.tierKey, color: b.tintHex, size: b.tier.radar, critical: b.critical > 0 });
      for (const s of ships) out.push({ x: s.pos.x, z: s.pos.z, kind: s.type, color: s.tintHex, size: s.def.radar });
      return out;
    },
    bases: () => bases.map(b => ({
      x: b.x, z: b.z, y: b.y, r: b.r, tier: b.tierKey, name: b.name, hp: Math.max(0, Math.round(b.hp * 10) / 10), maxHp: b.maxHp,
      shields: shieldsUp(b), maxShields: b.pylons.length, turrets: b.turrets.filter(t => t.alive).length, alive: b.alive,
      critical: b.critical > 0 ? b.critical : 0, awake: b.awake, flying: b.flying, color: b.tintHex, army: b.armyCost,
    })),
    infection: () => infect,                 // [{x, z, r}] (live objects; r grows toward max). Read-only.
    infectionVersion: () => infectVer,       // bumps when infection changes, for cheap re-upload checks
    craters: () => craterList,               // [{x, z, r, y}] bomb craters and base blast scars
    intensity: () => intens,
    heightAt,                                // base foundation top at (x,z), or -Infinity: main can do max(groundY, heightAt)
    setDrawDistance(m) { drawDist = Math.max(50, +m || 300); },
    setMaxShips(n) { maxShips = clamp(Math.round(+n || 70), 0, CAP); },
    setShowInfection(v) { showInfection = !!v; },
    setDifficulty(k) { diff = clamp(+k || 1, 0.3, 2); },   // 1 = default; scales enemy reload speed and accuracy
    stats() {
      const by = {}; for (const t of SHIP_TYPES) by[t] = 0;
      for (const s of ships) by[s.type]++;
      return { ships: ships.length, byType: by, bombs: bombs.length, infection: infect.length, craters: craterList.length, waves: waveNo, homeHits,
        basesAlive: bases.filter(b => b.alive).length, time, maxShips, drawDist };
    },
    // debug: world positions of a base's targetable parts (dev page / tests / lock-on)
    targets(i) {
      const b = bases[i]; if (!b) return [];
      return [...b.pylons.map(p => ({ kind: 'pylon', p: p.wp.clone(), alive: p.alive, hp: p.hp })), ...b.turrets.map(t => ({ kind: 'turret', p: t.wp.clone(), alive: t.alive, hp: t.hp })),
        { kind: 'reactor', p: b.reactor.wp.clone(), alive: b.alive && !b.critical, hp: b.hp }];
    },
    get root() { return root; },
    get ships() { return ships; },
  };
}
