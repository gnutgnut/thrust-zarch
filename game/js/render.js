import * as THREE from 'three';

// =====================================================================================================================
// render.js - "modern indie demake into PS2-era polys" render pipeline.
//
//   scene --> low-res target (renderScale * dynScale of the canvas, sRGB8 storage, depth)
//         --> [bloom: bright-pass downsample to 1/4 res -> blur H -> blur V]           (skipped when bloom = 0)
//         --> style pass AT LOW RES (skipped if nothing enabled): chroma shift, bloom add, sRGB encode, grade, grain,
//             colour-depth reduction with 4x4 Bayer dither -> style target
//         --> present pass to the screen: 1 fetch, nearest-neighbour upscale, scanlines + vignette.
//
// Every optional stage is compiled in/out with #defines (a toggle costs one cached program switch, never per-pixel work),
// so a stage set to 0 costs nothing. Targets are allocated once per canvas/renderScale change; dynScale <= 1 only
// shrinks the viewport inside the existing target, so a dynamic-resolution controller never triggers allocations.
//
// Colour: the low-res and bloom targets use SRGB8_ALPHA8 storage (hardware encodes on write and decodes on read), so
// 8-bit storage has no dark-tone banding and no HalfFloat target is needed anywhere. The style pass encodes to sRGB
// itself and quantises in sRGB space like the real hardware did; the style target stores those display values as-is.
// =====================================================================================================================

export const DEFAULT_SETTINGS = {
  renderScale: 0.5,      // low-res target size relative to the canvas drawing buffer
  retroLook: true,       // master switch for the stylisation (snap, dither, grade, scanlines, crisp pixels)
  vertexSnap: 0.5,       // 0..1 PS1/PS2 vertex wobble (0 = off)
  ditherStrength: 0.7,   // 0..1 ordered dither amount
  colorBits: 5,          // 3..8 bits per channel (5 = PS1/PS2 15-bit framebuffer)
  scanlines: 0.25,       // 0..1
  bloom: 0.6,            // 0..1
  chromaShift: 0.3,      // 0..1 (edge-weighted, whole low-res pixels)
  drawDistance: 260,     // metres - stored here; apply it with applyDrawDistance() (the integrator owns fog)
  pixelRatioCap: 1,      // devicePixelRatio cap for the canvas
  // --- "make it pop" extras (all optional; 0 disables) ---
  saturation: 1.12,      // slight saturation boost: demakes read best with bold, slightly candy colours
  splitTone: 0.6,        // warm highlights / cool shadows split-tone: gives flat Lambert lighting a "graded" modern feel
  contrast: 0.12,        // gentle S-curve: deeper shadows without crushing, keeps low-bit bands readable
  grain: 0.03,           // subtle per-virtual-pixel animated grain: breaks up big flat fog/sky areas, hides banding
  vignette: 0.22,        // slight vignette: frames the action like a CRT, pulls the eye to the ship
  bloomThreshold: 0.9,   // bright-pass key threshold (see brightKey below)
};

// ---------------------------------------------------------------------------------------------------- vertex snapping
// Shared by every patched material and by custom ShaderMaterials that paste retroSnapGLSL (spread these into uniforms).
export const retroUniforms = {
  uSnapRes: { value: new THREE.Vector2(320, 240) },   // virtual grid size in pixels (set by the pipeline each frame)
  uSnapAmt: { value: 0 },                              // 0..1 blend between smooth and snapped positions
  // three sizes points from the CANVAS height even inside a smaller target, so the pipeline rescales patched
  // PointsMaterials by (target height / canvas height) to keep particles the same size on screen at any renderScale
  uPointScale: { value: 1 },
};
// Fog near/far mirror for custom shaders (the terrain shader): applyDrawDistance() keeps these in sync with scene.fog.
export const drawDistanceUniforms = { uFogNear: { value: 120 }, uFogFar: { value: 380 } };

// Paste above main() of a custom vertex shader, then: gl_Position = retroSnap(projectionMatrix * ...);
export const retroSnapGLSL = /* glsl */`
uniform vec2 uSnapRes;
uniform float uSnapAmt;
vec4 retroSnap(vec4 clip) {
  if (uSnapAmt <= 0.0 || clip.w <= 0.0) return clip;   // behind the camera: leave alone (no wild spikes)
  vec2 ndc = clip.xy / clip.w;
  vec2 h = uSnapRes * 0.5;                               // NDC spans 2 units
  vec2 snapped = (floor(ndc * h) + 0.5) / h;             // snap to virtual pixel centres
  clip.xy = mix(ndc, snapped, uSnapAmt) * clip.w;        // depth/w untouched: z-buffer and fog stay correct
  return clip;
}
`;

// Patch a built-in material so its clip-space position snaps to the virtual grid. Idempotent; chains any existing
// onBeforeCompile. Fog, vertex colours, instancing and lighting are unaffected (only gl_Position.xy changes, after
// <project_vertex>; mvPosition used by fog_vertex is left alone). PointsMaterial gets the point-size fix instead of
// snapping (particles stay smooth; see uPointScale).
export function retroizeMaterial(material) {
  if (!material || material.isShaderMaterial || material.userData.__retro) return material;
  material.userData.__retro = true;
  const pts = !!material.isPointsMaterial;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    if (pts) {
      shader.uniforms.uPointScale = retroUniforms.uPointScale;
      shader.vertexShader = shader.vertexShader
        .replace('void main() {', 'uniform float uPointScale;\nvoid main() {')
        .replace('#include <logdepthbuf_vertex>', 'gl_PointSize *= uPointScale;\n\t#include <logdepthbuf_vertex>');
      return;
    }
    shader.uniforms.uSnapRes = retroUniforms.uSnapRes;
    shader.uniforms.uSnapAmt = retroUniforms.uSnapAmt;
    shader.vertexShader = shader.vertexShader
      .replace('void main() {', retroSnapGLSL + '\nvoid main() {')
      .replace('#include <project_vertex>', '#include <project_vertex>\n\tgl_Position = retroSnap( gl_Position );');
  };
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = function () { return prevKey.call(this) + (pts ? '|retroPts' : '|retroSnap'); };
  material.needsUpdate = true;
  return material;
}

// Traverse and patch every non-ShaderMaterial on meshes (snap) and points (size fix); lines are left alone. Cheap and
// idempotent: re-run it after adding objects with new materials (e.g. after building a cave or spawning a new enemy).
export function retroizeScene(root) {
  root.traverse(o => {
    if (o.isLine || !(o.isMesh || o.isPoints)) return;
    if (Array.isArray(o.material)) o.material.forEach(retroizeMaterial); else retroizeMaterial(o.material);
  });
  return root;
}

// ------------------------------------------------------------------------------------------- display-space shaders
// Built-in materials output linear colour into a render target and sRGB only when drawing straight to the canvas.
// The game's hand-written ShaderMaterials (sky, terrain) write display-space (sRGB) values directly, which looks right
// on the canvas but washes out once the scene goes through a render target. fixDisplayShader(material) patches such a
// ShaderMaterial (via onBeforeCompile, no source edits) so its final gl_FragColor is treated as display-space:
// sRGB -> linear -> linearToOutputTexel(). On the canvas that round-trips to exactly what it drew before; into the
// pipeline's target it is now correct. Assumes main() ends at the last '}' and does not `return` early.
export const displayOutGLSL = /* glsl */`
vec4 retroDisplayOut(vec4 c) {
  vec3 lin = mix(c.rgb / 12.92, pow((c.rgb + 0.055) / 1.055, vec3(2.4)), step(0.04045, c.rgb));
  return linearToOutputTexel(vec4(lin, c.a));
}
`;
export function fixDisplayShader(material) {
  if (!material || !material.isShaderMaterial || material.isRawShaderMaterial || material.userData.__display) return material;
  material.userData.__display = true;
  const prev = material.onBeforeCompile;
  material.onBeforeCompile = function (shader, renderer) {
    if (prev) prev.call(this, shader, renderer);
    let f = shader.fragmentShader;
    const i = f.lastIndexOf('}');
    f = f.slice(0, i) + '  gl_FragColor = retroDisplayOut(gl_FragColor);\n' + f.slice(i);
    shader.fragmentShader = f.replace(/void\s+main\s*\(/, displayOutGLSL + '\nvoid main(');
  };
  const prevKey = material.customProgramCacheKey;
  material.customProgramCacheKey = function () { return prevKey.call(this) + '|display'; };
  material.needsUpdate = true;
  return material;
}

// ------------------------------------------------------------------------------------------------ PS2 draw distance
// Short draw distance is a deliberate style and the main FPS lever: fog closes in at 45% of `metres`, fully fogged at
// `metres`, and camera.far = metres * 1.15 clips everything beyond. Optional opts.sky: a sky dome centred on the camera
// (radius opts.skyRadius, default its boundingSphere radius) is scaled to stay inside the far plane.
export function applyDrawDistance(scene, camera, metres, fogColor, opts = {}) {
  const near = metres * 0.45;
  if (!scene.fog) scene.fog = new THREE.Fog(fogColor ?? 0x000000, near, metres);
  if (fogColor !== undefined && fogColor !== null) scene.fog.color.set(fogColor);
  if (scene.fog.isFog) { scene.fog.near = near; scene.fog.far = metres; }
  else scene.fog.density = 2.2 / metres;   // FogExp2: ~90% fogged at `metres`
  drawDistanceUniforms.uFogNear.value = near; drawDistanceUniforms.uFogFar.value = metres;
  const far = metres * 1.15;
  if (camera && camera.far !== far) { camera.far = far; camera.updateProjectionMatrix(); }
  if (opts.sky) {
    let r = opts.skyRadius;
    if (!r) { const g = opts.sky.geometry; if (!g.boundingSphere) g.computeBoundingSphere(); r = g.boundingSphere.radius; }
    opts.sky.scale.setScalar(far * 0.9 / r);
  }
}

// ------------------------------------------------------------------------------------------------------- the passes
const FS_VERT = /* glsl */`
varying vec2 vUv;
void main() { vUv = position.xy * 0.5 + 0.5; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

const passMat = (fragmentShader, uniforms, defines = {}) => new THREE.ShaderMaterial({
  vertexShader: FS_VERT, fragmentShader, uniforms, defines,
  depthTest: false, depthWrite: false, blending: THREE.NoBlending, toneMapped: false, fog: false,
});

// Bright pass + 4x downsample. 4 bilinear taps cover the 4x4 source block, so 1-pixel bullets never flicker out.
// brightKey works on display-space value: max channel, minus a penalty for pale (unsaturated) colours, plus a boost for
// clipped pixels. Neon edges, exhaust, bullets, explosions and emissive/basic materials sit at value ~1 and pass; the
// sky (value <= 0.95, pale at the horizon), fog and lit terrain stay below the threshold, so the world never smears.
const BRIGHT_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 uTexel; uniform vec2 uUvScale; uniform vec2 uUvMax; uniform float uThresh;
varying vec2 vUv;
float brightKey(vec3 c) {
  vec3 s = pow(max(c, 0.0), vec3(1.0 / 2.2));
  float mx = max(max(s.r, s.g), s.b), mn = min(min(s.r, s.g), s.b);
  float sat = (mx - mn) / max(mx, 1e-4);
  return mx - 0.08 * (1.0 - sat) + smoothstep(0.97, 1.0, mx) * 0.25;
}
vec3 tap(vec2 uv) {
  vec3 c = texture2D(tSrc, min(uv, uUvMax)).rgb;
  return c * smoothstep(uThresh - 0.02, uThresh + 0.08, brightKey(c));
}
void main() {
  vec2 uv = vUv * uUvScale;
  vec3 c = tap(uv + uTexel * vec2(-1.0, -1.0)) + tap(uv + uTexel * vec2(1.0, -1.0))
         + tap(uv + uTexel * vec2(-1.0, 1.0)) + tap(uv + uTexel * vec2(1.0, 1.0));
  gl_FragColor = vec4(c * 0.25, 1.0);
}`;

// 9-tap gaussian in 5 bilinear taps.
const BLUR_FRAG = /* glsl */`
uniform sampler2D tSrc; uniform vec2 uDir;
varying vec2 vUv;
void main() {
  vec3 c = texture2D(tSrc, vUv).rgb * 0.2270270;
  vec2 o1 = uDir * 1.3846154, o2 = uDir * 3.2307692;
  c += (texture2D(tSrc, vUv + o1).rgb + texture2D(tSrc, vUv - o1).rgb) * 0.3162162;
  c += (texture2D(tSrc, vUv + o2).rgb + texture2D(tSrc, vUv - o2).rgb) * 0.0702703;
  gl_FragColor = vec4(c, 1.0);
}`;

// Style pass, run at the LOW resolution (every effect here is per virtual pixel anyway, so doing it before the
// upscale is 1/renderScale^2 cheaper than per screen pixel). Order: fetch (+chroma) -> + bloom -> sRGB -> grade ->
// grain -> quantise with ordered dither. Output: display-space (sRGB) values in a plain RGBA8 target.
const STYLE_FRAG = /* glsl */`
uniform sampler2D tScene; uniform sampler2D tBloom;
uniform vec2 uSrcSize;    // allocated size of the low-res targets
uniform vec2 uActive;     // active (rendered) size inside them
uniform float uBloom, uLevels, uDither, uChroma, uSat, uSplit, uContrast, uGrain, uSeed;
varying vec2 vUv;         // 0..1 over the active rect (the pass viewport is the active rect)

vec3 fetch(vec2 p) {      // p in active low-res pixels, snapped to texel centres => exact texel reads
  p = clamp(floor(p) + 0.5, vec2(0.5), uActive - 0.5);
  return texture2D(tScene, p / uSrcSize).rgb;
}
vec3 toSRGB(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
float bayer2(vec2 a) { return mod(2.0 * a.x + 3.0 * a.y, 4.0); }               // [[0,2],[3,1]]
float bayer4(vec2 a) { a = mod(a, 4.0); return (4.0 * bayer2(mod(a, 2.0)) + bayer2(floor(a * 0.5))) / 16.0; }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }

void main() {
  vec2 p = vUv * uActive;
#ifdef CHROMA
  // Lateral chromatic shift growing with r^2: zero in the centre, ~3 low-res px at the corners at chromaShift = 1.
  vec2 d = vUv - 0.5;
  vec2 off = d * dot(d, d) * 12.0 * uChroma;
  vec3 c = vec3(fetch(p + off).r, fetch(p).g, fetch(p - off).b);
#else
  vec3 c = fetch(p);
#endif
#ifdef BLOOM
  c += texture2D(tBloom, vUv).rgb * uBloom;
#endif
  vec3 s = toSRGB(c);
#ifdef GRADE
  float l = dot(s, vec3(0.299, 0.587, 0.114));
  s = mix(vec3(l), s, uSat);                                       // saturation boost
  s = mix(s, s * s * (3.0 - 2.0 * s), uContrast);                  // gentle S-curve
  // split-tone: shadows lean teal-blue, highlights lean warm amber (luma-weighted, very small offsets)
  s += mix(vec3(-0.025, 0.004, 0.04), vec3(0.035, 0.012, -0.03), smoothstep(0.15, 0.85, l)) * uSplit;
#endif
#ifdef GRAIN
  s += (hash12(floor(p) + uSeed) - 0.5) * uGrain;                  // per virtual pixel, new pattern every frame
#endif
#ifdef QUANT
  float b = bayer4(floor(p)) - 0.46875;                            // centred 4x4 ordered-dither threshold
  s = floor(s * uLevels + 0.5 + b * uDither) / uLevels;
#endif
  gl_FragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

// Present pass at screen resolution: one texture fetch (nearest-neighbour via texel-centre snapping when CRISP), then
// the display-side effects (scanlines, vignette), which belong after the "console" output, as on a real CRT.
const PRESENT_FRAG = /* glsl */`
uniform sampler2D tSrc;
uniform vec2 uSrcSize, uActive;
uniform float uScan, uScanPeriod, uVig;
varying vec2 vUv;
void main() {
  vec2 p = vUv * uActive;
#ifdef CRISP
  p = floor(p) + 0.5;
#endif
  p = clamp(p, vec2(0.5), uActive - 0.5);
  vec3 s = texture2D(tSrc, p / uSrcSize).rgb;
#ifdef SRC_LINEAR
  s = mix(s * 12.92, 1.055 * pow(s, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, s));   // reading the scene target directly
#endif
#ifdef SCAN
  float f = fract(gl_FragCoord.y / uScanPeriod);
  // dark lower half of each scan row; lit rows are lifted so the average brightness stays the same
  s *= (1.0 - uScan * 0.5 * step(0.5, f)) / (1.0 - uScan * 0.25);
#endif
#ifdef VIGNETTE
  vec2 d = vUv - 0.5;
  s *= 1.0 - uVig * smoothstep(0.08, 0.5, dot(d, d));
#endif
  gl_FragColor = vec4(clamp(s, 0.0, 1.0), 1.0);
}`;

// --------------------------------------------------------------------------------------------------------- pipeline
export function createPipeline(renderer, { scene, camera } = {}) {
  const S = { ...DEFAULT_SETTINGS };
  let dyn = 1, override = null, cssW = 0, cssH = 0, seed = 0;
  let sceneCalls = 0, sceneTris = 0, postPasses = 0, lastDirect = false;
  const active = [16, 16], alloc = [0, 0], bloomSize = [0, 0];
  const _v = new THREE.Vector2();
  renderer.info.autoReset = false;   // we reset once per frame so info() covers scene + post

  const rtOpts = (depth) => ({
    type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: depth, stencilBuffer: false,
    minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false, colorSpace: THREE.SRGBColorSpace,
  });
  const sceneRT = new THREE.WebGLRenderTarget(16, 16, rtOpts(true));
  const bloomA = new THREE.WebGLRenderTarget(4, 4, rtOpts(false));
  const bloomB = new THREE.WebGLRenderTarget(4, 4, rtOpts(false));
  for (const t of [sceneRT, bloomA, bloomB]) t.texture.colorSpace = THREE.SRGBColorSpace;
  // the style target holds display-space values already => plain RGBA8, no hardware sRGB conversion
  const styleRT = new THREE.WebGLRenderTarget(16, 16, { ...rtOpts(false), colorSpace: THREE.NoColorSpace });
  styleRT.texture.colorSpace = THREE.NoColorSpace;
  sceneRT.texture.name = 'retroScene'; styleRT.texture.name = 'retroStyle';

  const brightMat = passMat(BRIGHT_FRAG, {
    tSrc: { value: sceneRT.texture }, uTexel: { value: new THREE.Vector2() }, uUvScale: { value: new THREE.Vector2(1, 1) },
    uUvMax: { value: new THREE.Vector2(1, 1) }, uThresh: { value: S.bloomThreshold },
  });
  const blurH = passMat(BLUR_FRAG, { tSrc: { value: bloomA.texture }, uDir: { value: new THREE.Vector2() } });
  const blurV = passMat(BLUR_FRAG, { tSrc: { value: bloomB.texture }, uDir: { value: new THREE.Vector2() } });
  const styleU = {
    tScene: { value: sceneRT.texture }, tBloom: { value: bloomA.texture },
    uSrcSize: { value: new THREE.Vector2() }, uActive: { value: new THREE.Vector2() },
    uBloom: { value: 0 }, uLevels: { value: 31 }, uDither: { value: 0 }, uChroma: { value: 0 }, uSat: { value: 1 },
    uSplit: { value: 0 }, uContrast: { value: 0 }, uGrain: { value: 0 }, uSeed: { value: 0 },
  };
  const styleMat = passMat(STYLE_FRAG, styleU);
  const presentU = {
    tSrc: { value: styleRT.texture }, uSrcSize: styleU.uSrcSize, uActive: styleU.uActive,
    uScan: { value: 0 }, uScanPeriod: { value: 2 }, uVig: { value: 0 },
  };
  const presentMat = passMat(PRESENT_FRAG, presentU);
  let useStyle = false, styleKey = null, presentKey = null;

  const tri = new THREE.BufferGeometry();
  tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(tri, presentMat); quad.frustumCulled = false;
  const postScene = new THREE.Scene(); postScene.add(quad);
  const postCam = new THREE.Camera();
  const pass = (mat, target) => {
    quad.material = mat; renderer.setRenderTarget(target); renderer.render(postScene, postCam); postPasses++;
  };

  function applyPixelRatio() {
    const pr = Math.min(window.devicePixelRatio || 1, S.pixelRatioCap || 1);
    if (renderer.getPixelRatio() !== pr) renderer.setPixelRatio(pr);
    if (cssW > 0) renderer.setSize(cssW, cssH, false);
  }

  // Lazily (re)size targets. Allocation follows renderScale (and dynScale only when it exceeds 1); the active rect
  // inside the target follows renderScale * dynScale.
  function ensureSize() {
    renderer.getDrawingBufferSize(_v);
    const bw = _v.x * S.renderScale, bh = _v.y * S.renderScale;
    const aw = Math.max(16, Math.round(bw * Math.max(1, dyn))), ah = Math.max(16, Math.round(bh * Math.max(1, dyn)));
    if (aw !== alloc[0] || ah !== alloc[1]) {
      alloc[0] = aw; alloc[1] = ah;
      sceneRT.setSize(aw, ah); styleRT.setSize(aw, ah);
      bloomSize[0] = Math.max(4, Math.ceil(aw / 4)); bloomSize[1] = Math.max(4, Math.ceil(ah / 4));
      bloomA.setSize(bloomSize[0], bloomSize[1]); bloomB.setSize(bloomSize[0], bloomSize[1]);
      styleU.uSrcSize.value.set(aw, ah);
      brightMat.uniforms.uTexel.value.set(1 / aw, 1 / ah);
      blurH.uniforms.uDir.value.set(1 / bloomSize[0], 0); blurV.uniforms.uDir.value.set(0, 1 / bloomSize[1]);
    }
    active[0] = Math.min(alloc[0], Math.max(16, Math.round(bw * dyn)));
    active[1] = Math.min(alloc[1], Math.max(16, Math.round(bh * dyn)));
    for (const t of [sceneRT, styleRT]) {
      t.viewport.set(0, 0, active[0], active[1]);
      t.scissor.set(0, 0, active[0], active[1]);
      t.scissorTest = active[0] < alloc[0] || active[1] < alloc[1];
    }
    styleU.uActive.value.set(active[0], active[1]);
    brightMat.uniforms.uUvScale.value.set(active[0] / alloc[0], active[1] / alloc[1]);
    brightMat.uniforms.uUvMax.value.set((active[0] - 0.5) / alloc[0], (active[1] - 0.5) / alloc[1]);
    // scanline period in screen pixels: one per virtual row when the upscale is >= 2x, else every other screen row
    presentU.uScanPeriod.value = Math.max(2, Math.round(_v.y / active[1]));
  }

  // Map settings -> uniforms + #defines (program switch only when the enabled-stage set changes).
  function syncUniforms() {
    const R = !!S.retroLook;
    const bits = Math.round(Math.min(8, Math.max(3, S.colorBits ?? 8)));
    const quant = R && (bits < 8 || S.ditherStrength > 0);
    const SD = {}, PD = {};
    if (S.bloom > 0) SD.BLOOM = '';
    if (R && S.chromaShift > 0) SD.CHROMA = '';
    if (R && ((S.saturation ?? 1) !== 1 || S.splitTone > 0 || S.contrast > 0)) SD.GRADE = '';
    if (R && S.grain > 0) SD.GRAIN = '';
    if (quant) SD.QUANT = '';
    useStyle = Object.keys(SD).length > 0;
    if (R) PD.CRISP = '';
    if (!useStyle) PD.SRC_LINEAR = '';
    if (R && S.scanlines > 0) PD.SCAN = '';
    if (R && S.vignette > 0) PD.VIGNETTE = '';
    const sk = Object.keys(SD).join(), pk = Object.keys(PD).join();
    if (sk !== styleKey) { styleKey = sk; styleMat.defines = SD; styleMat.needsUpdate = true; }
    if (pk !== presentKey) { presentKey = pk; presentMat.defines = PD; presentMat.needsUpdate = true; }
    presentU.tSrc.value = useStyle ? styleRT.texture : sceneRT.texture;
    styleU.uBloom.value = S.bloom * 1.6;
    styleU.uLevels.value = Math.pow(2, bits) - 1;
    styleU.uDither.value = S.ditherStrength;
    styleU.uChroma.value = S.chromaShift;
    styleU.uSat.value = S.saturation ?? 1;
    styleU.uSplit.value = S.splitTone ?? 0;
    styleU.uContrast.value = S.contrast ?? 0;
    styleU.uGrain.value = S.grain ?? 0;
    presentU.uScan.value = S.scanlines;
    presentU.uVig.value = S.vignette ?? 0;
    brightMat.uniforms.uThresh.value = S.bloomThreshold ?? 0.9;
  }
  syncUniforms();

  const api = {
    settings: S,
    setSettings(s) {
      const prc = S.pixelRatioCap;
      // accepts a flat object or settings.js' nested { display, world, retro } (flattened, nested wins)
      for (const [k, v] of Object.entries(s)) if (v === null || typeof v !== 'object') S[k] = v;
      for (const g of ['display', 'world', 'retro']) if (s[g] && typeof s[g] === 'object') Object.assign(S, s[g]);
      if (S.pixelRatioCap !== prc) applyPixelRatio();
      syncUniforms();
    },
    setDynScale(x) { dyn = Math.max(0.1, +x || 1); },
    resize(w, h) { cssW = w; cssH = h; applyPixelRatio(); },
    setOverride(fn) { override = fn || null; },
    setScene(s, c) { if (s) scene = s; if (c) camera = c; },
    render(dt = 1 / 60) {
      renderer.info.reset();
      postPasses = 0;
      const R = !!S.retroLook;
      const v = R ? Math.min(1, Math.max(0, S.vertexSnap || 0)) : 0;
      // Clean path: nothing to post-process and full resolution -> plain render, zero overhead.
      const direct = !override && !R && !(S.bloom > 0) && S.renderScale * dyn >= 0.999;
      lastDirect = direct;
      if (direct) {
        renderer.getDrawingBufferSize(_v); active[0] = _v.x; active[1] = _v.y;
        retroUniforms.uSnapAmt.value = 0; retroUniforms.uPointScale.value = 1;
        renderer.setRenderTarget(null); renderer.render(scene, camera);
        sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles;
        return;
      }
      ensureSize();
      // vertex snap: a coarser grid (down to 1/3.5 of the render res) and a stronger blend as vertexSnap rises
      retroUniforms.uSnapRes.value.set(active[0] / (1 + 2.5 * v), active[1] / (1 + 2.5 * v));
      retroUniforms.uSnapAmt.value = Math.min(1, v * 4);
      retroUniforms.uPointScale.value = active[1] / Math.max(1, _v.y);
      seed = (seed + 1) % 4096; styleU.uSeed.value = seed * 7.13;

      renderer.setRenderTarget(sceneRT);
      if (override) override(sceneRT, { width: active[0], height: active[1], dt });
      else renderer.render(scene, camera);
      sceneCalls = renderer.info.render.calls; sceneTris = renderer.info.render.triangles;

      const ac = renderer.autoClear; renderer.autoClear = false;   // every post pass overwrites its whole target
      if (S.bloom > 0) { pass(brightMat, bloomA); pass(blurH, bloomB); pass(blurV, bloomA); }
      if (useStyle) pass(styleMat, styleRT);
      pass(presentMat, null);
      renderer.autoClear = ac;
    },
    info() {
      return { res: [active[0], active[1]], drawCalls: sceneCalls, triangles: sceneTris, postPasses, direct: lastDirect,
        alloc: [alloc[0], alloc[1]] };
    },
    target: sceneRT,
    dispose() { [sceneRT, styleRT, bloomA, bloomB, tri, brightMat, blurH, blurV, styleMat, presentMat].forEach(o => o.dispose()); },
  };
  return api;
}
