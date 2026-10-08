import * as THREE from 'three';

// 2.5D (LittleBigPlanet-style) cave visuals. Units = level cells: x right, y up, z depth, play plane z = 0.
const hash = (x, y) => { const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return s - Math.floor(s); };
const litM = (c, e = 0x000000, o = {}) => new THREE.MeshLambertMaterial({ color: c, emissive: e, ...o });
const geom = (pos, col) => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (col) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (col) g.computeVertexNormals(); // non-indexed => flat face normals
  return g;
};

export function buildCaveMesh(L, { depth = 10, margin = 12 } = {}) {
  const { W, H } = L, zf = depth / 2, zb = -depth / 2, M = margin;
  // extended solidity: rock margin left/right/below, open sky above the level
  const sol = (x, y) => {
    if (y >= H) return 0;
    if (x < 0 || x >= W || y < 0) return 1;
    return L.solid[y * W + x];
  };
  const isPad = (x, y) => x >= 0 && x < W && y >= 0 && y < H && L.pad[y * W + x] === 1;
  const rp = [], rc = [], bp = [], bc = [], ln = [], lnB = [];
  // quad a,b,c,d (CCW seen from outside); per-vertex shade darkens toward the back
  const quad = (P, C, v, c, f) => {
    for (const i of [0, 1, 2, 0, 2, 3]) {
      const p = v[i], k = f * (p[2] < 0 ? .62 : 1);
      P.push(p[0], p[1], p[2]); C.push(c[0] * k, c[1] * k, c[2] * k);
    }
  };
  for (let y = -M; y < H; y++) for (let x = -M; x < W + M; x++) {
    const j = hash(x, y), X = x + 1, Y = y + 1;
    if (!sol(x, y)) {
      // recessed backdrop with vertical gradient (per-vertex y)
      const d0 = .5 + .5 * y / H, d1 = .5 + .5 * Y / H, cb = d => [.05 * d + .01, .1 * d + .015, .24 * d + .04];
      const c0 = cb(d0), c1 = cb(d1);
      for (const [p, c] of [[[x, y], c0], [[X, y], c0], [[X, Y], c1], [[x, y], c0], [[X, Y], c1], [[x, Y], c1]]) {
        bp.push(p[0], p[1], zb); bc.push(c[0], c[1], c[2]);
      }
      continue;
    }
    const pad = isPad(x, y);
    const c = pad ? [.1, .75, .35] : [.36 + j * .1, .25 + j * .08, .21 + j * .07];
    quad(rp, rc, [[x, y, zf], [X, y, zf], [X, Y, zf], [x, Y, zf]], c, 1);
    if (!sol(x, y + 1)) quad(rp, rc, [[x, Y, zb], [x, Y, zf], [X, Y, zf], [X, Y, zb]], c, .82);
    if (!sol(x, y - 1)) quad(rp, rc, [[x, y, zb], [X, y, zb], [X, y, zf], [x, y, zf]], c, .55);
    if (!sol(x + 1, y)) quad(rp, rc, [[X, y, zf], [X, y, zb], [X, Y, zb], [X, Y, zf]], c, .68);
    if (!sol(x - 1, y)) quad(rp, rc, [[x, y, zb], [x, y, zf], [x, Y, zf], [x, Y, zb]], c, .68);
    if (pad) continue;
    // neon silhouette edges (front) + dim back edges
    const e = (a, b, cc, d) => { ln.push(a, b, zf + .02, cc, d, zf + .02); lnB.push(a, b, zb + .02, cc, d, zb + .02); };
    if (!sol(x, y + 1)) e(x, Y, X, Y);
    if (!sol(x, y - 1)) e(x, y, X, y);
    if (!sol(x - 1, y)) e(x, y, x, Y);
    if (!sol(x + 1, y)) e(X, y, X, Y);
  }
  const grp = new THREE.Group();
  grp.name = 'cave3d';
  const rock = new THREE.Mesh(geom(rp, rc), new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x2a1c16, flatShading: true }));
  const back = new THREE.Mesh(geom(bp, bc), new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x060c1c }));
  rock.name = 'rock'; back.name = 'backwall';
  grp.add(rock, back);
  grp.add(new THREE.LineSegments(geom(ln), new THREE.LineBasicMaterial({ color: 0x66e8ff })));
  grp.add(new THREE.LineSegments(geom(lnB), new THREE.LineBasicMaterial({ color: 0x1d5a6e })));
  // landing pad: raised green slab on top of pad cells (top surface = L.padTop) + light outline
  const pl = [], padM = litM(0x1abf59, 0x0a4020);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!isPad(x, y) || isPad(x - 1, y)) continue;
    let x1 = x; while (isPad(x1 + 1, y)) x1++;
    const w = x1 - x + 1, top = L.padTop + .03, h = .35; // top sits a hair above padTop (no z-fight with rock)
    const slab = new THREE.Mesh(new THREE.BoxGeometry(w + .2, h, depth + .3), padM);
    slab.position.set(x + w / 2, top - h / 2, .15);
    grp.add(slab);
    const zl = zf + .32;
    pl.push(x - .1, top, zl, x1 + 1.1, top, zl, x - .1, top - h, zl, x1 + 1.1, top - h, zl);
  }
  grp.add(new THREE.LineSegments(geom(pl), new THREE.LineBasicMaterial({ color: 0xaaffcc })));
  return grp;
}

export function makeTurret() {
  const g = new THREE.Group(), body = litM(0xff4433, 0x501008);
  const dome = new THREE.Mesh(new THREE.SphereGeometry(.9, 18, 12), body);
  dome.scale.set(1, .72, .9);
  const base = new THREE.Mesh(new THREE.BoxGeometry(1.7, .45, 1.3), litM(0x992a22, 0x300806)); // symmetric: works on floors and ceilings
  const hub = new THREE.Mesh(new THREE.SphereGeometry(.32, 12, 8), litM(0xffbb55, 0x553311));
  hub.position.z = .55;
  const barrel = new THREE.Mesh(new THREE.CylinderGeometry(.16, .18, 1.5, 10).rotateZ(-Math.PI / 2).translate(.75, 0, 0), litM(0xffbb55, 0x553311));
  barrel.position.z = .55;
  g.add(dome, base, hub, barrel);
  g.userData.barrel = barrel;
  return g;
}

export function makeTank() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(.8, .8, 1.6, 20).rotateZ(Math.PI / 2), litM(0x225533, 0x0a1a10));
  const capM = litM(0x557766, 0x101c16);
  for (const s of [-1, 1]) {
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(.82, .82, .15, 20).rotateZ(Math.PI / 2), capM);
    cap.position.x = s * .875; g.add(cap);
  }
  const frame = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.35), new THREE.MeshBasicMaterial({ color: 0x0b1a10 }));
  frame.position.z = .82;
  // fill bar: origin at its bottom so scale.y shrinks it downward from the top
  const bar = new THREE.Mesh(new THREE.PlaneGeometry(1.6, 1.2).translate(0, .6, 0), new THREE.MeshBasicMaterial({ color: 0x44ff88 }));
  bar.position.set(0, -.6, .84);
  g.add(body, frame, bar);
  g.userData.bar = bar;
  return g;
}

export function makePod() {
  const g = new THREE.Group();
  const ball = new THREE.Mesh(new THREE.SphereGeometry(.8, 24, 16), new THREE.MeshPhongMaterial({ color: 0xff55dd, emissive: 0x661150, shininess: 60 }));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(.86, .07, 8, 32).rotateX(Math.PI / 2), litM(0xffffff, 0x777777));
  g.add(ball, ring);
  return g;
}

export function makeRope() {
  const obj = new THREE.Mesh(new THREE.CylinderGeometry(.08, .08, 1, 6), new THREE.MeshBasicMaterial({ color: 0xffff88 }));
  const a = new THREE.Vector3(), b = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const set = (ax, ay, az, bx, by, bz) => {
    a.set(ax, ay, az); b.set(bx, by, bz).sub(a);
    const len = b.length();
    obj.position.copy(a).addScaledVector(b, .5);
    obj.scale.set(1, Math.max(len, 1e-4), 1);
    if (len > 1e-6) obj.quaternion.setFromUnitVectors(up, b.divideScalar(len));
  };
  return { obj, set };
}
