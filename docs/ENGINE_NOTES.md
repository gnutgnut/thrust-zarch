# Thrust/Zarch engine notes (for module authors)

Game: `game/` (static site, open `index.html` via `start.bat` or `tools/snap.mjs`). Three.js r170 at `game/vendor/three.module.min.js`
(import as `'three'` via importmap; addons under `three/addons/` are NOT vendored - write what you need).

## Ownership
`game/js/main.js` is owned by the integrator. Module authors do NOT edit main.js or index.html; they ship a module plus a dev page
`game/dev/<module>.html` that exercises it standalone. The integrator wires modules into main.js.

## World (Zarch mode)
- Units ~1 m. Y up. Playfield x,z in [-BOUND, BOUND], BOUND = 360. Ship ~3.4 m long, wings 4.4 m.
- Terrain height: `rawH(x,z)` (sum of sines, see main.js; identical GLSL copy in the terrain vertex shader), blended to the flat
  base pad height PAD_H = 6 inside radius BASE_R = 18..60, then raised to >= PAD_H+1 inside the cave strip |x|<76, |z|<9 (14 m falloff).
  `groundY(x,z) = max(terrainH, 0)`; heights <= 0 are water (drawn at y = 0, blue checker).
- A rectangular hole |x| < 5.6, |z| < 4.8 at the origin is the cave shaft mouth (terrain fragments discarded there).
- Scene: `zScene` with Fog(HORIZON 0xbfd9f2, near 120, far 380), HemisphereLight + DirectionalLight sun (0.5,1,0.3).
  Camera: `zCam` PerspectiveCamera (fov 62 in 3D, blends to 38 in the cave), far 1200. Renderer: WebGLRenderer(antialias), pixelRatio <= 2.
- Frame: `requestAnimationFrame(frame)`; dt clamped to 0.05; ends with `renderer.render(zScene, zCam)`.
- Particles today: CPU arrays drawn as additive `THREE.Points` (class Cloud). Bullets likewise.

## Cave (Thrust mode)
- Level grid from `level.js` (W=64, H=56 cells, `solid` Uint8Array, y up). Rendered by `cave3d.js` inside `caveGroup`
  (scale CS = 1.6, position (-32.5*CS, PAD_H - 56*CS, 0)), so cave cell (cx,cy) -> world ((cx-32.5)*1.6, 6+(cy-56)*1.6, 0).
- Gameplay is 2D in the plane world z = 0; rock slab spans z in [-4.8, 4.8]. Side camera at +z looking -z.
- Camera blends 3D->side over 1.3 s (`camB` 0..1) when the ship dives into the shaft.

## Testing
`cd tools && node snap.mjs --query "dev/<module>.html" --steps "wait 2000" "shot a"` serves game/ and screenshots any page.
Headless GPU is SwiftShader (software), so fps there is ~5-10x lower than a real GPU; judge relative cost, not absolute.
`?debug` exposes `window.__G` in the game.
