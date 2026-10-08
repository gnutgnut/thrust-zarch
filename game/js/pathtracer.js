import * as THREE from 'three';

// Optional real-time path tracer for the Thrust/Zarch world.
// The scene is analytic (heightfield + voxel slab + a few dozen spheres/boxes), so there is no BVH: one fullscreen
// fragment shader traces 1 path per pixel per frame at reduced resolution, accumulates temporally (with reprojection)
// into a half/float ping-pong target, optionally runs an edge-aware a-trous denoise, then tonemaps (ACES) to LDR.
//
//   const pt = createPathTracer(renderer);
//   pt.render(camera, desc, target /* WebGLRenderTarget or null = screen */);
//
// desc = { time, sunDir:[x,y,z], base: true,
//          spheres:[{p:[x,y,z], r, albedo:[r,g,b], emit:[r,g,b]}],        // linear albedo 0..1, emit = linear radiance (HDR)
//          boxes:[{p:[x,y,z], half:[x,y,z], rot:[qx,qy,qz,qw], albedo, emit}],
//          caveOn, caveSolid: Uint8Array(W*H, y up) | null, cavePad: Uint8Array | null, caveW, caveH,
//          settings:{ scale, spp, bounces, accumulate, denoise, exposure, ... see DEFAULTS } }
// Emissive spheres are the light sources (next-event estimation); emissive boxes only glow (no NEE).

// ---- world constants (must match main.js) ----
const PAD_H = 6, BASE_R = 18, STRIP_X = 76, STRIP_Z = 9, CS = 1.6, CAVE_OX = 32.5, CAVE_DEPTH = 6;
const HOLE_X = 3.5 * CS, HOLE_Z = CAVE_DEPTH / 2 * CS, MARGIN = 12;
const f1 = v => v.toFixed(4);

export const PT_DEFAULTS = {
  scale: 0.35,       // internal resolution relative to the output
  spp: 1,            // paths per pixel per frame
  bounces: 2,        // indirect segments after the primary hit (1..4)
  accumulate: true,  // temporal accumulation (reprojected EMA while moving, running mean while still)
  denoise: 1,        // a-trous iterations (0..2); true == 1
  exposure: 1.0,
  moveBlend: 0.25,   // weight of the new frame while the camera moves
  dynBlend: 0.1,     // min weight of the new frame while objects move (static camera)
  maxSamples: 256,   // running-mean cap when everything is still
  clamp: 12,         // firefly clamp (max luminance of one sample)
  primSteps: 88,     // terrain march steps: primary rays
  secSteps: 44,      //   bounce rays
  shadowSteps: 28,   //   shadow rays
  sunE: 2.4,         // sun irradiance (linear)
  skyLight: 0.4,     // sky radiance used as a light source, relative to the camera-visible sky (which matches the raster dome)
  sunAngle: 0.035,   // sun cone half-angle (rad) - wider than real for soft, less noisy shadows
  caveAmb: 0.22,     // cave rock self-ambient
  underAmb: [0.05, 0.055, 0.07], // radiance of 'earth' seen from underground
  ambTerm: [0.2, 0.22, 0.25],   // terminal-vertex ambient (approximates the bounces we did not trace)
  beam: 1,           // base light beam glow
  waterSpec: 0.6,    // scale on the water Fresnel reflectance
};

const BASE_BOXES = (() => {
  const out = [];
  for (let i = 0; i < 7; i++) {
    const a = i / 7 * Math.PI * 2, h = -a / 2;
    out.push({
      p: [Math.cos(a) * 14.5, PAD_H + 1.5 + (i % 4) * 0.7, Math.sin(a) * 14.5],
      half: [(4 + (i % 3)) / 2, (3 + (i % 4) * 1.5) / 2, 2],
      rot: [0, Math.sin(h), 0, Math.cos(h)], albedo: [0.26, 0.29, 0.36], emit: [0, 0, 0],
    });
  }
  return out;
})();

const VERT = `varying vec2 vUv; void main(){ vUv = position.xy * .5 + .5; gl_Position = vec4(position.xy, 0., 1.); }`;

function traceFrag(MAX_SPH, MAX_BOX) {
  return /* glsl */`
precision highp float; precision highp int; precision highp sampler2D;
#define MAX_SPH ${MAX_SPH}
#define MAX_BOX ${MAX_BOX}
#define PI 3.14159265
varying vec2 vUv;
uniform vec2 uRes; uniform int uFrame; uniform float uTime;
uniform mat4 uCamWorld, uInvProj, uPrevVP; uniform vec3 uCamPos, uPrevCamPos;
uniform sampler2D uPrev; uniform float uAlpha; uniform bool uStill;
uniform int uSpp, uBounces, uPrimSteps, uSecSteps, uShadowSteps;
uniform vec3 uSunDir, uSunE; uniform float uSunCos, uExposure, uClamp, uBeam;
uniform int uNS, uNL, uNB, uNBase; uniform float uWaterSpec;
uniform vec4 uSph[MAX_SPH], uSphA[MAX_SPH], uSphE[MAX_SPH];
uniform vec4 uBoxP[MAX_BOX], uBoxH[MAX_BOX], uBoxQ[MAX_BOX], uBoxA[MAX_BOX], uBoxE[MAX_BOX];
uniform bool uCaveOn; uniform sampler2D uCave; uniform vec2 uCaveWH;
uniform float uCaveAmb, uSkyLight; uniform vec3 uUnderAmb, uAmbTerm;

// ---------------------------------------------------------------- rng
uint gSeed;
uint pcg(){ gSeed = gSeed * 747796405u + 2891336453u; uint w = ((gSeed >> ((gSeed >> 28u) + 4u)) ^ gSeed) * 277803737u; return (w >> 22u) ^ w; }
float rnd(){ return float(pcg()) * (1. / 4294967296.); }

vec3 lin(vec3 c){ return pow(c, vec3(2.2)); }
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
// inverse of the ACES fit used by the output pass, so the camera-visible sky matches the raster sky dome exactly
vec3 invACES(vec3 y){ vec3 a = 2.51 - 2.43 * y, b = .03 - .59 * y, c = -.14 * y; return (-b + sqrt(b * b - 4. * a * c)) / (2. * a); }
vec3 skyRad(vec3 d){ vec3 c = mix(vec3(.75, .85, .95), vec3(.22, .42, .85), smoothstep(0., .55, d.y)); return invACES(lin(c)) / uExposure; }

// ---------------------------------------------------------------- terrain (identical to main.js rawH/terrainH)
float rawH(vec2 p){return 14.*sin(p.x*.035+1.3)*cos(p.y*.04)+9.*sin(p.x*.09+p.y*.07)+5.*sin(p.y*.13-p.x*.05)+2.5*sin(p.x*.31)*sin(p.y*.27)+8.;}
float terrH(vec2 p){
  float h = mix(${f1(PAD_H)}, rawH(p), smoothstep(${f1(BASE_R)}, 60., length(p)));
  vec2 sd = max(abs(p) - vec2(${f1(STRIP_X)}, ${f1(STRIP_Z)}), 0.);
  return mix(max(h, ${f1(PAD_H)}), h, smoothstep(0., 14., length(sd)));
}
bool inHole(vec2 p){ return abs(p.x) < ${f1(HOLE_X)} && abs(p.y) < ${f1(HOLE_Z)}; }
float gH(vec2 p){ return inHole(p) ? -1e4 : max(terrH(p), 0.); }
// below the ground surface (the shaft column counts as underground below the cave top)
bool underground(vec3 p){ return inHole(p.xz) ? p.y < ${f1(PAD_H)} : p.y < terrH(p.xz) - .05; }

// relax = assumed max terrain slope: step = clearance / (slope + descent rate), overshoot is caught by bisection
float marchTerrain(vec3 ro, vec3 rd, float t0, float tmax, int steps, float relax){
  float tlo = t0, thi = tmax;
  if (abs(rd.y) > 1e-6) { float ta = (38.6 - ro.y) / rd.y, tb = (-.02 - ro.y) / rd.y; tlo = max(tlo, min(ta, tb)); thi = min(thi, max(ta, tb)); }
  else if (ro.y > 38.6 || ro.y < 0.) return -1.;
  if (tlo >= thi) return -1.;
  float t = tlo, lt = tlo;
  for (int i = 0; i < 200; i++) {
    if (i >= steps || t > thi) break;
    vec3 p = ro + rd * t; float h = p.y - gH(p.xz);
    if (h < 0.) {
      float a = lt, b = t;
      for (int k = 0; k < 6; k++) { float m = .5 * (a + b); vec3 q = ro + rd * m; if (q.y - gH(q.xz) < 0.) b = m; else a = m; }
      return b;
    }
    lt = t; t += max(min(h, p.y + 1.) / (relax + max(-rd.y, 0.)), .03 + .005 * t);
  }
  // over flat water the clearance step shrinks geometrically: finish analytically on the sea plane
  if (rd.y < 0.) {
    float tw = -ro.y / rd.y; vec2 q = ro.xz + rd.xz * tw;
    if (tw >= lt && tw <= tmax && terrH(q) <= 0. && !inHole(q)) return tw;
  }
  return -1.;
}

vec3 terrNormal(vec2 p){ float e = .15; return normalize(vec3(terrH(p - vec2(e, 0)) - terrH(p + vec2(e, 0)), 2. * e, terrH(p - vec2(0, e)) - terrH(p + vec2(0, e)))); }

// ---------------------------------------------------------------- hits
struct Hit { float t; vec3 n; vec3 alb; vec3 em; int mat; bool dyn; }; // mat 0 diffuse, 1 water, 2 light, 3 cave

void terrainHit(vec3 ro, vec3 rd, float t, inout Hit h){
  vec3 p = ro + rd * t;
  float raw = terrH(p.xz);
  vec2 g = floor(p.xz / 6.); float chk = mod(g.x + g.y, 2.);
  if (raw <= 0. && !inHole(p.xz)) {
    if (abs(rd.y) > 1e-5) { float tw = -ro.y / rd.y; if (tw > 0.) t = tw; }
    h.t = t; h.n = vec3(0, 1, 0); h.alb = lin(mix(vec3(.04, .18, .5), vec3(.07, .25, .6), chk)); h.em = vec3(0); h.mat = 1; h.dyn = false; return;
  }
  vec3 land = mix(vec3(.17, .5, .15), vec3(.25, .6, .19), chk), rock = mix(vec3(.45, .37, .27), vec3(.52, .43, .32), chk);
  vec3 c = mix(land, rock, smoothstep(24., 38., p.y));
  c = mix(vec3(.78, .72, .45), c, smoothstep(0., 3., p.y));
  float d = length(p.xz);
  if (d < ${f1(BASE_R)}) { c = vec3(.5, .52, .58); if (d < 8.5) { float r = d / 8.5; c = mix(vec3(.15, .16, .2), vec3(.95, .8, .1), step(.5, fract(r * 4.))); } }
  h.t = t; h.n = terrNormal(p.xz); h.alb = lin(c); h.em = vec3(0); h.mat = 0; h.dyn = false;
}

vec3 qrot(vec4 q, vec3 v){ return v + 2. * cross(q.xyz, cross(q.xyz, v) + q.w * v); }
vec3 safeDir(vec3 d){ return mix(d, vec3(1e-7), lessThan(abs(d), vec3(1e-7))); }

void objectsHit(vec3 ro, vec3 rd, inout Hit h){
  for (int i = 0; i < MAX_SPH; i++) {
    if (i >= uNS) break;
    vec4 s = uSph[i]; vec3 oc = ro - s.xyz; float b = dot(oc, rd), c = dot(oc, oc) - s.w * s.w, disc = b * b - c;
    if (disc < 0.) continue;
    float sq = sqrt(disc), t = -b - sq; if (t < 1e-3) t = -b + sq;
    if (t > 1e-3 && t < h.t) { h.t = t; h.n = normalize(oc + rd * t); h.alb = uSphA[i].rgb; h.em = uSphE[i].rgb; h.mat = i < uNL ? 2 : 0; h.dyn = true; }
  }
  for (int i = 0; i < MAX_BOX; i++) {
    if (i >= uNB) break;
    vec4 q = uBoxQ[i], qi = vec4(-q.xyz, q.w); vec3 hs = uBoxH[i].xyz;
    vec3 lo = qrot(qi, ro - uBoxP[i].xyz), ld = safeDir(qrot(qi, rd)), inv = 1. / ld;
    vec3 t1 = (-hs - lo) * inv, t2 = (hs - lo) * inv, tmn = min(t1, t2), tmx = max(t1, t2);
    float tn = max(max(tmn.x, tmn.y), tmn.z), tf = min(min(tmx.x, tmx.y), tmx.z);
    if (tf < max(tn, 1e-3)) continue;
    float t = tn > 1e-3 ? tn : tf;
    if (t < h.t) {
      vec3 nl = tn > 1e-3 ? -sign(ld) * step(tmn.yzx, tmn) * step(tmn.zxy, tmn) : sign(ld) * step(tmx, tmx.yzx) * step(tmx, tmx.zxy);
      h.t = t; h.n = qrot(q, nl); h.alb = uBoxA[i].rgb; h.em = uBoxE[i].rgb; h.mat = 0; h.dyn = i >= uNBase;
    }
  }
}
bool objectsOcc(vec3 ro, vec3 rd, float tmax){
  for (int i = 0; i < MAX_SPH; i++) {
    if (i >= uNS) break;
    if (i < uNL) continue; // lights do not cast shadows
    vec4 s = uSph[i]; vec3 oc = ro - s.xyz; float b = dot(oc, rd), c = dot(oc, oc) - s.w * s.w, disc = b * b - c;
    if (disc < 0.) continue;
    float sq = sqrt(disc), t = -b - sq; if (t < 1e-3) t = -b + sq;
    if (t > 1e-3 && t < tmax) return true;
  }
  for (int i = 0; i < MAX_BOX; i++) {
    if (i >= uNB) break;
    vec4 q = uBoxQ[i], qi = vec4(-q.xyz, q.w); vec3 hs = uBoxH[i].xyz;
    vec3 lo = qrot(qi, ro - uBoxP[i].xyz), ld = safeDir(qrot(qi, rd)), inv = 1. / ld;
    vec3 t1 = (-hs - lo) * inv, t2 = (hs - lo) * inv, tmn = min(t1, t2), tmx = max(t1, t2);
    float tn = max(max(tmn.x, tmn.y), tmn.z), tf = min(min(tmx.x, tmx.y), tmx.z);
    if (tf >= max(tn, 1e-3) && max(tn, 1e-3) < tmax) return true;
  }
  return false;
}

// ---------------------------------------------------------------- cave voxel slab (cell units: x right, y up, z depth)
float hash2(vec2 p){ return fract(sin(p.x * 12.9898 + p.y * 78.233) * 43758.5453); }
float cellV(ivec2 c){
  ivec2 wh = ivec2(uCaveWH);
  if (c.y >= wh.y || c.x < -${MARGIN} || c.y < -${MARGIN} || c.x >= wh.x + ${MARGIN}) return 0.;
  return texelFetch(uCave, c + ivec2(${MARGIN}), 0).r;
}
void caveMat(ivec2 c, vec3 pc, vec3 n, inout Hit h){
  float v = cellV(c), H = uCaveWH.y;
  h.n = n; h.mat = 3; h.dyn = false;
  if (v < .25) { // open cell: back wall, darker toward the bottom
    float d = .5 + .5 * pc.y / H;
    h.alb = lin(vec3(.05 * d + .01, .1 * d + .015, .24 * d + .04) * 3.);
    h.em = lin(vec3(.024, .047, .11));
    return;
  }
  float j = hash2(vec2(c));
  bool pad = v < .75;
  vec3 col = pad ? vec3(.1, .75, .35) : vec3(.36 + j * .1, .25 + j * .08, .21 + j * .07);
  h.alb = lin(col);
  h.em = h.alb * uCaveAmb + (pad ? lin(vec3(.04, .25, .12)) : vec3(0));
  if (!pad && n.z > .5) { // neon silhouette edges on the front face
    vec2 f = pc.xy - vec2(c); float w = .07, e = 0.;
    if (cellV(c + ivec2(0, 1)) < .25 && f.y > 1. - w) e = 1.;
    if (cellV(c - ivec2(0, 1)) < .25 && f.y < w) e = 1.;
    if (cellV(c + ivec2(1, 0)) < .25 && f.x > 1. - w) e = 1.;
    if (cellV(c - ivec2(1, 0)) < .25 && f.x < w) e = 1.;
    h.em += e * vec3(.15, .8, 1.) * 1.5;
  }
}
// 0 = misses the slab box, 1 = hit (h updated), 2 = escapes through the top inside the shaft hole (tEsc),
// 3 = escapes elsewhere (into the earth), 4 = reached tmax inside the box with no hit
int caveTrace(vec3 ro, vec3 rd, float tmax, inout Hit h, out float tEsc){
  tEsc = 0.;
  float W = uCaveWH.x, H = uCaveWH.y;
  vec3 CO = vec3(${f1(-CAVE_OX * CS)}, ${(PAD_H - 0.15).toFixed(2)} - H * ${f1(CS)}, 0.);
  vec3 o = (ro - CO) / ${f1(CS)}, d = safeDir(rd), inv = 1. / d;
  vec3 bmin = vec3(-${MARGIN}., -${MARGIN}., -${f1(CAVE_DEPTH / 2)}), bmax = vec3(W + ${MARGIN}., H, ${f1(CAVE_DEPTH / 2)});
  vec3 t1 = (bmin - o) * inv, t2 = (bmax - o) * inv, tmn = min(t1, t2), tmx = max(t1, t2);
  float tn = max(max(tmn.x, tmn.y), tmn.z), tf = min(min(tmx.x, tmx.y), tmx.z);
  float tm = tmax / ${f1(CS)};
  if (tf <= max(tn, 0.) || tn > tm) return 0;
  float t = max(tn, 0.);
  vec3 p = o + d * t;
  ivec2 c = ivec2(floor(p.xy));
  ivec2 cmax = ivec2(int(W) + ${MARGIN - 1}, int(H) - 1);
  if (tn > 0.) {
    if (tmn.x == tn) c.x = d.x > 0. ? -${MARGIN} : cmax.x;
    else if (tmn.y == tn) c.y = d.y > 0. ? -${MARGIN} : cmax.y;
  }
  c = clamp(c, ivec2(-${MARGIN}), cmax);
  bool fromBack = tn > 0. && tmn.z == tn && d.z > 0.;
  if (cellV(c) > .25 || fromBack) {
    vec3 n = tn > 0. ? -sign(d) * step(tmn.yzx, tmn) * step(tmn.zxy, tmn) : -rd;
    h.t = t * ${f1(CS)}; caveMat(c, p, n, h); return 1;
  }
  ivec2 st = ivec2(sign(d.xy));
  vec2 tDel = abs(inv.xy);
  vec2 tM = (vec2(c) + step(0., d.xy) - o.xy) * inv.xy;
  for (int i = 0; i < 160; i++) {
    float tN = min(tM.x, tM.y);
    if (tN >= tf) break;
    if (tN > tm) return 4;
    int ax;
    if (tM.x < tM.y) { c.x += st.x; tM.x += tDel.x; ax = 0; } else { c.y += st.y; tM.y += tDel.y; ax = 1; }
    if (c.y >= int(H) || c.y < -${MARGIN} || c.x < -${MARGIN} || c.x > cmax.x) break;
    if (cellV(c) > .25) {
      vec3 n = ax == 0 ? vec3(-float(st.x), 0, 0) : vec3(0, -float(st.y), 0);
      h.t = tN * ${f1(CS)}; caveMat(c, o + d * tN, n, h); return 1;
    }
  }
  if (tf > tm) return 4;
  if (d.z < 0. && tmx.z <= tf + 1e-4) { // back wall behind open cells
    h.t = tf * ${f1(CS)}; caveMat(c, o + d * tf, vec3(0, 0, 1), h); return 1;
  }
  tEsc = tf * ${f1(CS)};
  if (d.y > 0. && tmx.y <= tf + 1e-4) { vec3 pw = ro + rd * tEsc; if (inHole(pw.xz)) return 2; }
  return 3;
}

// ---------------------------------------------------------------- scene queries
// returns false on miss; missUnder = the ray left an underground region into the earth
bool trace(vec3 ro, vec3 rd, int steps, out Hit h, out bool missUnder){
  h.t = 1e9; h.mat = -1; h.n = vec3(0, 1, 0); h.alb = vec3(0); h.em = vec3(0); h.dyn = false;
  missUnder = false;
  objectsHit(ro, rd, h);
  bool ug = underground(ro);
  float tEsc;
  if (!ug) {
    float tt = marchTerrain(ro, rd, 0., min(h.t, 600.), steps, 1.1);
    if (tt > 0.) terrainHit(ro, rd, tt, h);
    if (uCaveOn) caveTrace(ro, rd, min(h.t, 600.), h, tEsc);
  } else if (uCaveOn) {
    int k = caveTrace(ro, rd, min(h.t, 600.), h, tEsc);
    if (k == 2) { float tt = marchTerrain(ro, rd, tEsc, min(h.t, 600.), steps, 1.1); if (tt > 0.) terrainHit(ro, rd, tt, h); }
    else if (k != 1 && h.mat < 0) missUnder = true;
  } else missUnder = h.mat < 0;
  return h.mat >= 0;
}
bool occluded(vec3 ro, vec3 rd, float tmax){
  if (objectsOcc(ro, rd, tmax)) return true;
  bool ug = underground(ro);
  Hit h; h.t = tmax; float tEsc;
  if (!ug) {
    if (marchTerrain(ro, rd, 0., tmax, uShadowSteps, .9) > 0.) return true;
    if (uCaveOn && caveTrace(ro, rd, tmax, h, tEsc) == 1) return true;
    return false;
  }
  if (!uCaveOn) return true;
  int k = caveTrace(ro, rd, tmax, h, tEsc);
  if (k == 4) return false;
  if (k == 2) return marchTerrain(ro, rd, tEsc, tmax, uShadowSteps, .9) > 0.;
  return true;
}

// ---------------------------------------------------------------- sampling
mat3 basis(vec3 n){ vec3 t = normalize(abs(n.y) < .99 ? cross(n, vec3(0, 1, 0)) : cross(n, vec3(1, 0, 0))); return mat3(t, cross(n, t), n); }
vec3 cosDir(vec3 n){ float ph = 2. * PI * rnd(), r2 = rnd(), s = sqrt(r2); return basis(n) * vec3(cos(ph) * s, sin(ph) * s, sqrt(1. - r2)); }
vec3 coneDir(vec3 a, float cosMax){ float ct = mix(1., cosMax, rnd()), st = sqrt(max(0., 1. - ct * ct)), ph = 2. * PI * rnd(); return basis(a) * vec3(cos(ph) * st, sin(ph) * st, ct); }

// direct light (to be multiplied by albedo): sun + one importance-picked emissive sphere
vec3 directLight(vec3 p, vec3 n){
  vec3 L = vec3(0);
  if (dot(n, uSunDir) > 0.) {
    vec3 l = coneDir(uSunDir, uSunCos); float c = dot(n, l);
    if (c > 0. && !occluded(p, l, 1e4)) L += uSunE * c / PI;
  }
  if (uNL > 0) {
    float ws = 0.;
    for (int i = 0; i < MAX_SPH; i++) { if (i >= uNL) break; vec3 dv = uSph[i].xyz - p; float r = uSph[i].w;
      ws += lum(uSphE[i].rgb) * r * r / max(dot(dv, dv), r * r) * step(-r, dot(dv, n)); }
    if (ws > 0.) {
      float x = rnd() * ws, acc = 0.; int sel = -1; float wsel = 0.;
      for (int i = 0; i < MAX_SPH; i++) { if (i >= uNL) break; vec3 dv = uSph[i].xyz - p; float r = uSph[i].w;
        float w = lum(uSphE[i].rgb) * r * r / max(dot(dv, dv), r * r) * step(-r, dot(dv, n));
        acc += w; if (sel < 0 && acc >= x && w > 0.) { sel = i; wsel = w; } }
      if (sel >= 0) {
        vec3 dv = uSph[sel].xyz - p; float r = uSph[sel].w, d2 = dot(dv, dv), d = sqrt(d2);
        vec3 E = uSphE[sel].rgb * ws / wsel;
        if (d <= r * 1.001) L += E;
        else {
          float cm = sqrt(max(0., 1. - r * r / d2)); vec3 l = coneDir(dv / d, cm); float c = dot(n, l);
          if (c > 0.) {
            float b = dot(l, dv), tl = b - sqrt(max(r * r - (d2 - b * b), 0.));
            if (!occluded(p, l, tl * .999)) L += E * c * 2. * (1. - cm);
          }
        }
      }
    }
  }
  return L;
}

vec3 skyLight(vec3 rd){ vec3 c = skyRad(rd); return mix(c, vec3(lum(c)), .35) * uSkyLight; }
vec3 sunDisk(vec3 rd){ return dot(rd, uSunDir) > uSunCos ? uSunE / (2. * PI * (1. - uSunCos)) : vec3(0); }

void main(){
  gSeed = uint(gl_FragCoord.x) * 1973u + uint(gl_FragCoord.y) * 9277u + uint(uFrame) * 26699u | 1u;
  pcg(); pcg();
  vec3 sum = vec3(0); float tPrim = 1e4; bool dynPrim = false;
  for (int s = 0; s < 16; s++) {
    if (s >= uSpp) break;
    vec2 ndc = (gl_FragCoord.xy + vec2(rnd(), rnd()) - .5) / uRes * 2. - 1.;
    vec4 v = uInvProj * vec4(ndc, 1., 1.); vec3 rd = normalize(mat3(uCamWorld) * (v.xyz / v.w)), ro = uCamPos;
    vec3 L = vec3(0), thr = vec3(1); bool spec = true; float tp = 1e4; bool dp = false; bool primUnder = underground(ro);
    for (int b = 0; b < 5; b++) {
      Hit h; bool mu;
      if (!trace(ro, rd, b == 0 ? uPrimSteps : uSecSteps, h, mu)) {
        if (b == 0 && primUnder) { L += skyRad(rd); break; }
        L += thr * (mu ? uUnderAmb : spec ? skyRad(rd) + sunDisk(rd) : skyLight(rd));
        break;
      }
      if (b == 0) { tp = h.t; dp = h.dyn; }
      if (h.mat != 2 || spec) L += thr * h.em;
      if (h.mat == 2) break;
      if (b >= uBounces) { if (h.mat != 3) L += thr * h.alb * uAmbTerm; break; }
      vec3 p = ro + rd * h.t;
      vec3 n = dot(h.n, rd) > 0. ? -h.n : h.n;
      p += n * (2e-3 + h.t * 2e-4);
      float wd = 1.;
      bool doSpec = false;
      if (h.mat == 1) {
        float F = (.02 + .98 * pow(1. - max(dot(-rd, n), 0.), 5.)) * uWaterSpec, ps = clamp(F + .1, .1, .95);
        if (rnd() < ps) { doSpec = true; thr *= F / ps; }
        else wd = (1. - F) / (1. - ps);
      }
      if (doSpec) {
        vec3 r = reflect(rd, n); r = normalize(r + (vec3(rnd(), rnd(), rnd()) - .5) * .06); if (dot(r, n) < 0.) r = reflect(r, n);
        ro = p; rd = r; spec = true; continue;
      }
      thr *= h.alb * wd;
      L += thr * directLight(p, n);
      ro = p; rd = cosDir(n); spec = false;
      if (max(thr.r, max(thr.g, thr.b)) < .01) break;
    }
    if (!primUnder && tp < 1e4) { vec3 fogC = invACES(lin(vec3(.749, .851, .949))) / uExposure; L = mix(L, fogC, smoothstep(130., 370., tp)); }
    float l = lum(L); if (l > uClamp) L *= uClamp / l;
    sum += L;
    if (s == 0) { tPrim = tp; dynPrim = dp; }
  }
  vec3 cur = sum / float(uSpp);
  // centre ray (unjittered) for depth / reprojection
  vec4 vc = uInvProj * vec4(vUv * 2. - 1., 1., 1.); vec3 dc = normalize(mat3(uCamWorld) * (vc.xyz / vc.w));
  // base beam (additive, primary only)
  if (uBeam > 0.) {
    vec2 o2 = uCamPos.xz, d2 = dc.xz; float dd = dot(d2, d2);
    if (dd > 1e-6) { float ts = -dot(o2, d2) / dd; float y = uCamPos.y + dc.y * ts; float r = length(o2 + d2 * ts);
      if (ts > 0. && ts < tPrim && y > ${f1(PAD_H)} && y < 96.) cur += uBeam * vec3(.12, .5, .7) * exp(-r * r * 4.) * .5; }
  }
  if (any(isnan(cur)) || any(isinf(cur))) cur = vec3(0);
  vec3 hp = uCamPos + dc * tPrim;
  // history: alpha channel = primary distance, negative when the primary hit is a moving object
  vec4 res = vec4(cur, dynPrim ? -tPrim : tPrim);
  if (uAlpha < 1.) {
    vec2 puv = vUv; bool ok = true;
    float ed = tPrim;
    if (!uStill) {
      vec4 clip = uPrevVP * vec4(hp, 1.); puv = clip.xy / clip.w * .5 + .5;
      ok = clip.w > 0. && all(greaterThanEqual(puv, vec2(0))) && all(lessThanEqual(puv, vec2(1)));
      ed = length(hp - uPrevCamPos);
    }
    if (ok) {
      vec4 hst = texture(uPrev, puv);
      bool hdyn = hst.a < 0.; float hd = abs(hst.a);
      float tol = (dynPrim || hdyn) ? .03 * ed + .1 : uStill ? 1e9 : .1 * ed + .3;
      if (hdyn == dynPrim && abs(hd - ed) < tol) {
        float a = dynPrim ? max(uAlpha, .5) : uAlpha;
        res.rgb = mix(hst.rgb, cur, a);
        if (!uStill) res.a = (dynPrim ? -1. : 1.) * mix(ed, tPrim, max(a, .5));
      }
    }
  }
  gl_FragColor = res;
}`;
}

const DENOISE_FRAG = /* glsl */`
precision highp float; varying vec2 vUv;
uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uStep, uSigL;
float lum(vec3 c){ return dot(c, vec3(.2126, .7152, .0722)); }
void main(){
  vec4 c = texture(uSrc, vUv); float lc = lum(c.rgb);
  vec3 acc = vec3(0); float ws = 0.;
  for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
    vec4 s = texture(uSrc, vUv + vec2(i, j) * uTexel * uStep);
    float k = (i == 0 ? .5 : .25) * (j == 0 ? .5 : .25);
    float w = k * exp(-abs(abs(s.a) - abs(c.a)) / (.02 * abs(c.a) + .05)) * exp(-abs(lum(s.rgb) - lc) / (uSigL * (lc + .05)));
    acc += s.rgb * w; ws += w;
  }
  gl_FragColor = vec4(acc / ws, c.a);
}`;

const OUT_FRAG = /* glsl */`
precision highp float; varying vec2 vUv;
uniform sampler2D uSrc; uniform float uExposure;
vec3 aces(vec3 x){ return clamp((x * (2.51 * x + .03)) / (x * (2.43 * x + .59) + .14), 0., 1.); }
void main(){ gl_FragColor = vec4(pow(aces(max(texture(uSrc, vUv).rgb, 0.) * uExposure), vec3(1. / 2.2)), 1.); }`;

export function createPathTracer(renderer) {
  const maxFU = renderer.capabilities.maxFragmentUniforms || 1024;
  // budget fragment uniform vectors: 3 per sphere, 5 per box, ~48 for the rest
  let MAX_SPH = 64, MAX_BOX = 32;
  while (MAX_SPH * 3 + MAX_BOX * 5 + 48 > maxFU && MAX_SPH > 8) { MAX_SPH >>= 1; MAX_BOX >>= 1; }
  const gl = renderer.getContext();
  const floatOK = renderer.extensions.has('EXT_color_buffer_float') && renderer.extensions.has('OES_texture_float_linear');
  const accType = floatOK ? THREE.FloatType : THREE.HalfFloatType;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const ocam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const quad = new THREE.Mesh(geo); quad.frustumCulled = false;
  const scene = new THREE.Scene(); scene.add(quad);

  const dummy = new THREE.DataTexture(new Uint8Array([0]), 1, 1, THREE.RedFormat, THREE.UnsignedByteType); dummy.needsUpdate = true;
  const F = n => new Float32Array(n * 4);
  const U = {
    uRes: { value: new THREE.Vector2() }, uFrame: { value: 0 }, uTime: { value: 0 },
    uCamWorld: { value: new THREE.Matrix4() }, uInvProj: { value: new THREE.Matrix4() }, uPrevVP: { value: new THREE.Matrix4() },
    uCamPos: { value: new THREE.Vector3() }, uPrevCamPos: { value: new THREE.Vector3() },
    uPrev: { value: null }, uAlpha: { value: 1 }, uStill: { value: false },
    uSpp: { value: 1 }, uBounces: { value: 2 }, uPrimSteps: { value: 88 }, uSecSteps: { value: 44 }, uShadowSteps: { value: 28 },
    uSunDir: { value: new THREE.Vector3(.5, 1, .3).normalize() }, uSunE: { value: new THREE.Vector3() }, uSunCos: { value: Math.cos(.035) },
    uExposure: { value: 1 }, uClamp: { value: 12 }, uBeam: { value: 1 },
    uNS: { value: 0 }, uNL: { value: 0 }, uNB: { value: 0 }, uNBase: { value: 0 }, uWaterSpec: { value: .6 },
    uSph: { value: F(MAX_SPH) }, uSphA: { value: F(MAX_SPH) }, uSphE: { value: F(MAX_SPH) },
    uBoxP: { value: F(MAX_BOX) }, uBoxH: { value: F(MAX_BOX) }, uBoxQ: { value: F(MAX_BOX) }, uBoxA: { value: F(MAX_BOX) }, uBoxE: { value: F(MAX_BOX) },
    uCaveOn: { value: false }, uCave: { value: dummy }, uCaveWH: { value: new THREE.Vector2(64, 56) },
    uCaveAmb: { value: .22 }, uSkyLight: { value: .4 }, uUnderAmb: { value: new THREE.Vector3() }, uAmbTerm: { value: new THREE.Vector3() },
  };
  const traceMat = new THREE.ShaderMaterial({ uniforms: U, vertexShader: VERT, fragmentShader: traceFrag(MAX_SPH, MAX_BOX), depthTest: false, depthWrite: false });
  const dnMat = new THREE.ShaderMaterial({ uniforms: { uSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uStep: { value: 1 }, uSigL: { value: 1 } }, vertexShader: VERT, fragmentShader: DENOISE_FRAG, depthTest: false, depthWrite: false });
  const outMat = new THREE.ShaderMaterial({ uniforms: { uSrc: { value: null }, uExposure: { value: 1 } }, vertexShader: VERT, fragmentShader: OUT_FRAG, depthTest: false, depthWrite: false });

  const mkRT = (w, h, filter) => new THREE.WebGLRenderTarget(w, h, { type: accType === THREE.FloatType && filter === THREE.NearestFilter ? THREE.HalfFloatType : accType, format: THREE.RGBAFormat, minFilter: filter, magFilter: filter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
  let acc = [], dn = [], rw = 0, rh = 0, sizeOverride = null;
  let n = 0, frame = 0, valid = false, lastSamples = 0;
  const prevW = new Float32Array(16), prevP = new Float32Array(16);
  const prevVP = new THREE.Matrix4(), prevCam = new THREE.Vector3();
  let prevObj = null;
  let caveTex = null, caveKey = '';
  const tmpV = new THREE.Vector2();

  function ensure(w, h) {
    if (w === rw && h === rh && acc.length) return;
    for (const t of [...acc, ...dn]) t.dispose();
    acc = [mkRT(w, h, THREE.LinearFilter), mkRT(w, h, THREE.LinearFilter)];
    dn = [mkRT(w, h, THREE.NearestFilter), mkRT(w, h, THREE.NearestFilter)];
    rw = w; rh = h; valid = false; n = 0;
  }
  const lum = c => c ? .2126 * c[0] + .7152 * c[1] + .0722 * c[2] : 0;
  function pack(desc) {
    const sph = (desc.spheres || []).filter(s => s && s.r > 0);
    const lights = sph.filter(s => lum(s.emit) > 0), plain = sph.filter(s => !(lum(s.emit) > 0));
    const all = lights.concat(plain).slice(0, MAX_SPH);
    const nL = Math.min(lights.length, MAX_SPH);
    const S = U.uSph.value, SA = U.uSphA.value, SE = U.uSphE.value;
    all.forEach((s, i) => {
      const k = i * 4, a = s.albedo || [.7, .7, .7], e = s.emit || [0, 0, 0];
      S[k] = s.p[0]; S[k + 1] = s.p[1]; S[k + 2] = s.p[2]; S[k + 3] = s.r;
      SA[k] = a[0]; SA[k + 1] = a[1]; SA[k + 2] = a[2]; SE[k] = e[0]; SE[k + 1] = e[1]; SE[k + 2] = e[2];
    });
    const bx = (desc.base === false ? [] : BASE_BOXES).concat(desc.boxes || []).slice(0, MAX_BOX);
    const BP = U.uBoxP.value, BH = U.uBoxH.value, BQ = U.uBoxQ.value, BA = U.uBoxA.value, BE = U.uBoxE.value;
    bx.forEach((b, i) => {
      const k = i * 4, a = b.albedo || [.7, .7, .7], e = b.emit || [0, 0, 0], q = b.rot || [0, 0, 0, 1];
      const ql = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
      BP[k] = b.p[0]; BP[k + 1] = b.p[1]; BP[k + 2] = b.p[2];
      BH[k] = b.half[0]; BH[k + 1] = b.half[1]; BH[k + 2] = b.half[2];
      BQ[k] = q[0] / ql; BQ[k + 1] = q[1] / ql; BQ[k + 2] = q[2] / ql; BQ[k + 3] = q[3] / ql;
      BA[k] = a[0]; BA[k + 1] = a[1]; BA[k + 2] = a[2]; BE[k] = e[0]; BE[k + 1] = e[1]; BE[k + 2] = e[2];
    });
    U.uNS.value = all.length; U.uNL.value = nL; U.uNB.value = bx.length; U.uNBase.value = desc.base === false ? 0 : Math.min(BASE_BOXES.length, MAX_BOX);
    // change detection (for the static-camera blend floor)
    const sig = new Float32Array(all.length * 12 + bx.length * 20 + 4);
    let o = 0;
    for (const arr of [S, SA, SE]) { sig.set(arr.subarray(0, all.length * 4), o); o += all.length * 4; }
    for (const arr of [BP, BH, BQ, BA, BE]) { sig.set(arr.subarray(0, bx.length * 4), o); o += bx.length * 4; }
    const sd = desc.sunDir || [.5, 1, .3]; sig.set([sd[0], sd[1], sd[2], desc.caveOn ? 1 : 0], o);
    let changed = !prevObj || prevObj.length !== sig.length;
    if (!changed) for (let i = 0; i < sig.length; i++) if (sig[i] !== prevObj[i]) { changed = true; break; }
    prevObj = sig;
    return changed;
  }
  function updateCave(desc) {
    const on = !!(desc.caveOn && desc.caveSolid);
    U.uCaveOn.value = on;
    if (!on) return false;
    const W = desc.caveW || 64, H = desc.caveH || 56, sol = desc.caveSolid, pad = desc.cavePad;
    let hsh = 0; for (let i = 0; i < sol.length; i++) hsh = (hsh * 31 + sol[i] + (pad ? pad[i] * 7 : 0)) | 0;
    const key = W + 'x' + H + ':' + hsh;
    if (key === caveKey) return false;
    caveKey = key;
    const TW = W + 2 * MARGIN, TH = H + MARGIN, data = new Uint8Array(TW * TH).fill(255);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      data[(y + MARGIN) * TW + x + MARGIN] = pad && pad[i] ? 128 : sol[i] ? 255 : 0;
    }
    if (caveTex) caveTex.dispose();
    caveTex = new THREE.DataTexture(data, TW, TH, THREE.RedFormat, THREE.UnsignedByteType);
    caveTex.unpackAlignment = 1; caveTex.needsUpdate = true;
    U.uCave.value = caveTex; U.uCaveWH.value.set(W, H);
    return true;
  }
  function draw(mat, target) { quad.material = mat; renderer.setRenderTarget(target); renderer.render(scene, ocam); }

  return {
    get maxSpheres() { return MAX_SPH; }, get maxBoxes() { return MAX_BOX; },
    render(camera, desc = {}, target = null) {
      const st = { ...PT_DEFAULTS, ...(desc.settings || {}) };
      const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear;
      renderer.autoClear = false;
      let ow, oh;
      if (target) { ow = target.width; oh = target.height; }
      else if (sizeOverride) [ow, oh] = sizeOverride;
      else { renderer.getDrawingBufferSize(tmpV); ow = tmpV.x; oh = tmpV.y; }
      const sc = Math.min(1, Math.max(0.02, st.scale));
      ensure(Math.max(1, Math.round(ow * sc)), Math.max(1, Math.round(oh * sc)));

      camera.updateMatrixWorld();
      const W = camera.matrixWorld.elements, P = camera.projectionMatrix.elements;
      let moved = false;
      for (let i = 0; i < 16; i++) if (Math.abs(W[i] - prevW[i]) > 1e-5 || Math.abs(P[i] - prevP[i]) > 1e-6) { moved = true; break; }
      prevW.set(W); prevP.set(P);
      const objChanged = pack(desc);
      const caveChanged = updateCave(desc);
      if (caveChanged) valid = false;

      let alpha;
      if (!valid || !st.accumulate) { alpha = 1; n = 1; }
      else if (moved) { alpha = st.moveBlend; n = Math.round(1 / st.moveBlend); }
      else { n = Math.min(n + 1, st.maxSamples); alpha = Math.max(1 / n, objChanged ? st.dynBlend : 0); }
      lastSamples = alpha >= 1 ? 1 : Math.round(1 / alpha);

      const sd = desc.sunDir || [.5, 1, .3];
      U.uSunDir.value.set(sd[0], sd[1], sd[2]).normalize();
      const sunC = st.sunColor || [1, .94, .82];
      U.uSunE.value.set(sunC[0] * st.sunE, sunC[1] * st.sunE, sunC[2] * st.sunE);
      U.uSunCos.value = Math.cos(st.sunAngle);
      U.uRes.value.set(rw, rh); U.uFrame.value = frame++; U.uTime.value = desc.time || 0;
      U.uCamWorld.value.copy(camera.matrixWorld); U.uInvProj.value.copy(camera.projectionMatrixInverse);
      U.uCamPos.value.setFromMatrixPosition(camera.matrixWorld);
      U.uPrevVP.value.copy(prevVP); U.uPrevCamPos.value.copy(prevCam);
      U.uAlpha.value = alpha; U.uStill.value = !moved;
      U.uSpp.value = Math.max(1, Math.min(16, st.spp | 0)); U.uBounces.value = Math.max(0, Math.min(4, st.bounces | 0));
      U.uPrimSteps.value = st.primSteps; U.uSecSteps.value = st.secSteps; U.uShadowSteps.value = st.shadowSteps;
      U.uExposure.value = st.exposure; U.uClamp.value = st.clamp; U.uBeam.value = desc.base === false ? 0 : st.beam;
      U.uCaveAmb.value = st.caveAmb; U.uSkyLight.value = st.skyLight; U.uWaterSpec.value = st.waterSpec; U.uUnderAmb.value.fromArray(st.underAmb); U.uAmbTerm.value.fromArray(st.ambTerm);
      U.uPrev.value = acc[1].texture;
      draw(traceMat, acc[0]);
      let src = acc[0];
      const it = st.denoise === true ? 1 : Math.max(0, Math.min(3, st.denoise | 0));
      for (let i = 0; i < it; i++) {
        const d = dn[i & 1];
        dnMat.uniforms.uSrc.value = src.texture; dnMat.uniforms.uTexel.value.set(1 / rw, 1 / rh);
        dnMat.uniforms.uStep.value = 1 << i; dnMat.uniforms.uSigL.value = 2.5 / Math.sqrt(lastSamples);
        draw(dnMat, d); src = d;
      }
      outMat.uniforms.uSrc.value = src.texture; outMat.uniforms.uExposure.value = st.exposure;
      draw(outMat, target);
      acc.reverse();
      prevVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      prevCam.copy(U.uCamPos.value);
      valid = true;
      renderer.setRenderTarget(prevTarget); renderer.autoClear = prevAuto;
    },
    reset() { valid = false; n = 0; },
    setSize(w, h) { sizeOverride = w && h ? [w, h] : null; valid = false; },
    stats() { return { res: [rw, rh], samples: lastSamples, maxSpheres: MAX_SPH, maxBoxes: MAX_BOX, accum: accType === THREE.FloatType ? 'float' : 'half' }; },
    dispose() { for (const t of [...acc, ...dn]) t.dispose(); acc = []; dn = []; traceMat.dispose(); dnMat.dispose(); outMat.dispose(); geo.dispose(); dummy.dispose(); if (caveTex) caveTex.dispose(); },
  };
}
