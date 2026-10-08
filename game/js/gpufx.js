// gpufx.js - GPU particle, water-surface and cave-liquid simulation for Thrust/Zarch.
//
//   import { createGpuFx, waterGLSL, waterUniforms } from './gpufx.js';
//   const fx = createGpuFx(renderer, zScene, { budget: 32768 });
//   fx.setCave({ solid: L.solid, W: L.W, H: L.H, cellSize: CS, origin: { x: -CAVE_OX * CS, y: CAVE_TOP - L.H * CS } });   // CAVE_TOP = PAD_H - 0.15
//   ...each frame, before renderer.render():  fx.update(dt, { camera: zCam, playerPos: Z.pos, inCave });
//
// Everything runs on the GPU with ping-pong render targets; the CPU only queues emit requests (O(requests) per frame,
// never O(particles)) and nothing is read back. See the bottom of this file / the report for the full API.
import * as THREE from 'three';

// ------------------------------------------------------------------ world constants (mirror main.js)
const PAD_H = 6, BASE_R = 18, STRIP_X = 76, STRIP_Z = 9, HOLE_X = 5.6, HOLE_Z = 4.8;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
export const rawH = (x, z) => 14 * Math.sin(x * .035 + 1.3) * Math.cos(z * .04) + 9 * Math.sin(x * .09 + z * .07) + 5 * Math.sin(z * .13 - x * .05) + 2.5 * Math.sin(x * .31) * Math.sin(z * .27) + 8;
const stripW = (x, z) => smooth(0, 14, Math.hypot(Math.max(Math.abs(x) - STRIP_X, 0), Math.max(Math.abs(z) - STRIP_Z, 0)));
export const terrainH = (x, z) => { const h = lerp(PAD_H, rawH(x, z), smooth(BASE_R, 60, Math.hypot(x, z))); return lerp(Math.max(h, PAD_H), h, stripW(x, z)); };
export const inHole = (x, z) => Math.abs(x) < HOLE_X && Math.abs(z) < HOLE_Z;

// GLSL copy of the heightfield (identical to the terrain vertex shader in main.js)
export const terrainGLSL = /* glsl */`
float rawH(vec2 p){return 14.*sin(p.x*.035+1.3)*cos(p.y*.04)+9.*sin(p.x*.09+p.y*.07)+5.*sin(p.y*.13-p.x*.05)+2.5*sin(p.x*.31)*sin(p.y*.27)+8.;}
float terrainH(vec2 p){
  float h=mix(${PAD_H.toFixed(1)},rawH(p),smoothstep(${BASE_R.toFixed(1)},60.,length(p)));
  vec2 sd=max(abs(p)-vec2(${STRIP_X.toFixed(1)},${STRIP_Z.toFixed(1)}),0.);
  return mix(max(h,${PAD_H.toFixed(1)}),h,smoothstep(0.,14.,length(sd)));
}
bool inHole(vec2 p){return abs(p.x)<${HOLE_X.toFixed(2)}&&abs(p.y)<${HOLE_Z.toFixed(2)};}
vec3 terrainN(vec2 p){float e=.6;float hx=terrainH(p+vec2(e,0.))-terrainH(p-vec2(e,0.));float hz=terrainH(p+vec2(0.,e))-terrainH(p-vec2(0.,e));return normalize(vec3(-hx,2.*e,-hz));}
`;

// ------------------------------------------------------------------ water surface: shared uniforms + GLSL chunk
// Spread these into any ShaderMaterial (uniforms: { ...waterUniforms, ... }) - the {value} objects are shared, so
// they follow the simulation every frame. uWaterWin = (minX, minZ, size, texelSize) in world metres.
const _blackTex = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
_blackTex.needsUpdate = true;
export const waterUniforms = {
  uWaterTex: { value: _blackTex },
  uWaterWin: { value: new THREE.Vector4(-128, -128, 256, 1) },
  uWaterTime: { value: 0 },
  uWaterAmb: { value: 0.06 },   // ambient swell amplitude (m); 0 = flat except for the simulated waves
};
// float waterHeight(vec2 xz) - surface height (y) at world xz (0 = rest level)
// vec3  waterNormal(vec2 xz) - surface normal
// float waterFoam(vec2 xz)   - 0..1 foam (steep slopes and fresh splashes, decays over ~2 s)
export const waterGLSL = /* glsl */`
uniform sampler2D uWaterTex; uniform vec4 uWaterWin; uniform float uWaterTime; uniform float uWaterAmb;
vec4 waterSample(vec2 xz){
  vec2 uv=(xz-uWaterWin.xy)/uWaterWin.z;
  if(uv.x<=0.||uv.y<=0.||uv.x>=1.||uv.y>=1.) return vec4(0.);
  vec2 e=min(uv,1.-uv); float edge=smoothstep(0.,.08,min(e.x,e.y));
  return texture(uWaterTex,uv)*edge;
}
float waterAmbient(vec2 p){float t=uWaterTime;return uWaterAmb*(.5*sin(p.x*.21+t*1.3)+.5*sin(p.y*.17-t*1.1)+.35*sin((p.x+p.y)*.43+t*2.1)+.2*sin((p.x-p.y)*.9-t*2.7));}
float waterHeight(vec2 xz){return waterSample(xz).r+waterAmbient(xz);}
vec3 waterNormal(vec2 xz){
  float e=max(uWaterWin.w,.25);
  float hx=waterHeight(xz+vec2(e,0.))-waterHeight(xz-vec2(e,0.));
  float hz=waterHeight(xz+vec2(0.,e))-waterHeight(xz-vec2(0.,e));
  return normalize(vec3(-hx,2.*e,-hz));
}
float waterFoam(vec2 xz){return clamp(waterSample(xz).b,0.,1.);}
`;

// ------------------------------------------------------------------ kinds
export const KIND = { spark: 0, ember: 1, smoke: 2, dust: 3, debris: 4, exhaust: 5, spray: 6, fuel: 7, shock: 8, trail: 9 };
const KNAMES = Object.keys(KIND);
const ADDITIVE = [1, 1, 0, 0, 0, 1, 0, 0, 1, 1];           // region 0 = additive pool, region 1 = alpha pool
const KDEF = [   // default life (s), random speed (m/s), position jitter (m)
  { life: 0.9, speed: 14, spread: 0.15 },   // spark
  { life: 2.2, speed: 6, spread: 0.4 },     // ember
  { life: 3.6, speed: 2, spread: 0.8 },     // smoke
  { life: 2.6, speed: 3, spread: 0.6 },     // dust
  { life: 4.5, speed: 10, spread: 0.3 },    // debris
  { life: 0.45, speed: 2.5, spread: 0.12 }, // exhaust
  { life: 1.6, speed: 5, spread: 0.3 },     // spray
  { life: 7, speed: 2.5, spread: 0.25 },    // fuel
  { life: 0.6, speed: 0, spread: 0 },       // shock (size = max radius, m)
  { life: 0.35, speed: 0.5, spread: 0.04 }, // trail
];
const MODE = { sphere: 0, ringXZ: 1, ringXY: 2, segment: 3 };
export const LIQUID = { fuel: 0, coolant: 1, water: 2 };

const MAXREQ = 512, MAXFREQ = 64, NWASH = 4, NBLAST = 8, NSPLASH = 32, NFBLAST = 4;

// ------------------------------------------------------------------ GLSL: shared helpers
const RNG = /* glsl */`
uint pcg(uint v){uint s=v*747796405u+2891336453u;uint w=((s>>((s>>28u)+4u))^s)*277803737u;return (w>>22u)^w;}
float rnd(inout uint s){s=pcg(s);return float(s)*(1./4294967296.);}
vec3 rndUnit(inout uint s){float z=rnd(s)*2.-1.;float a=rnd(s)*6.2831853;float r=sqrt(max(0.,1.-z*z));return vec3(r*cos(a),z,r*sin(a));}
`;
const FSQ_VERT = /* glsl */`
in vec3 position;
void main(){gl_Position=vec4(position.xy,0.,1.);}
`;

// particle update: MRT out P(pos,life) V(vel,kind+flags) A(maxLife,size,colour,aux)
const UPDATE_FRAG = /* glsl */`
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D tP,tV,tA,tSpawn,tWater,tSolid;
uniform int uW,uRegion;
uniform vec4 uSpawn0,uSpawn1;            // cursor, count, firstReq, nReq   (per region)
uniform float uDt,uTime,uFrame;
uniform vec4 uWash[${NWASH}],uWashDir[${NWASH}],uWashG[${NWASH}]; uniform int uNWash;
uniform vec4 uBlast[${NBLAST}]; uniform float uBlastK[${NBLAST}]; uniform int uNBlast;
uniform vec4 uWaterWin;                   // minX,minZ,size,on
uniform vec4 uCave; uniform vec2 uCaveWH; // originX,originY,cellSize,on ; W,H
layout(location=0) out vec4 oP; layout(location=1) out vec4 oV; layout(location=2) out vec4 oA;
${RNG}
${terrainGLSL}
//                       spark ember smoke dust debris exh  spray fuel shock trail
const float KG[10]=float[10](9.,  2.2, -1.4, .9,  9.8,  0.,  9.8, 9.8, 0.,  0.);
const float KD[10]=float[10](.5,  1.,  1.3,  1.5, .08,  2.6, .4,  .25, 0.,  1.6);
const float KB[10]=float[10](.45, .3,  0.,   .05, .32,  .15, 0.,  0.,  0.,  .4);
const float KF[10]=float[10](.25, .5,  .9,   .9,  .45,  .6,  1.,  .97, 0.,  .5);
const float KT[10]=float[10](0.,  2.,  2.6,  1.5, 0.,   .9,  .25, 0.,  0.,  .3);
const float KW[10]=float[10](.25, .8,  1.,   .8,  .12,  .5,  .8,  .5,  0.,  .4);
// divergence-free turbulence (curl of a sine potential), two octaves
vec3 curl1(vec3 p,float t){
  float a=sin(1.3*p.y+t),b=cos(1.7*p.z-.5*t),c=sin(1.5*p.z+.7*t),d=cos(1.1*p.x+.3*t),e=sin(1.9*p.x-.6*t),f=cos(1.2*p.y+.8*t);
  float dzy=-1.2*e*sin(1.2*p.y+.8*t), dyz=1.5*cos(1.5*p.z+.7*t)*d;
  float dxz=-1.7*a*sin(1.7*p.z-.5*t), dzx=1.9*cos(1.9*p.x-.6*t)*f;
  float dyx=-1.1*c*sin(1.1*p.x+.3*t), dxy=1.3*cos(1.3*p.y+t)*b;
  return vec3(dzy-dyz,dxz-dzx,dyx-dxy);
}
vec3 curl(vec3 p,float t){return curl1(p*.18,t*.6)+.5*curl1(p*.47+11.,t*1.1);}
float waterY(vec2 xz){
  if(uWaterWin.w<.5) return 0.;
  vec2 uv=(xz-uWaterWin.xy)/uWaterWin.z;
  if(uv.x<=0.||uv.y<=0.||uv.x>=1.||uv.y>=1.) return 0.;
  return texture(tWater,uv).r;
}
bool caveRegion(vec3 p){
  if(uCave.w<.5) return false;
  vec2 g=(p.xy-uCave.xy)/uCave.z;
  return g.y<uCaveWH.y&&g.y>-14.&&g.x>-14.&&g.x<uCaveWH.x+14.&&abs(p.z)<9.;
}
bool caveSolid(vec2 g){
  if(g.y>=uCaveWH.y) return false;
  if(g.x<0.||g.y<0.||g.x>=uCaveWH.x) return true;
  return texelFetch(tSolid,ivec2(g),0).r>.5;
}
void spawn(int region,int o,vec4 S,int slot){
  int lo=int(S.z),hi=lo+int(S.w)-1;
  for(int k=0;k<12;k++){ if(lo>=hi) break; int mid=(lo+hi+1)/2; if(float(o)>=texelFetch(tSpawn,ivec2(mid,0),0).w) lo=mid; else hi=mid-1; }
  vec4 r0=texelFetch(tSpawn,ivec2(lo,0),0),r1=texelFetch(tSpawn,ivec2(lo,1),0),r2=texelFetch(tSpawn,ivec2(lo,2),0),
       r3=texelFetch(tSpawn,ivec2(lo,3),0),r4=texelFetch(tSpawn,ivec2(lo,4),0);
  uint s=pcg(uint(slot)*1973u+uint(uFrame)*9277u+uint(lo)*26699u);
  float kind=r1.w; int k=int(kind);
  vec3 pos=r0.xyz, vel=r1.xyz;
  float spread=r2.x,spd=r2.y,life=r2.z,size=r2.w;
  float mode=mod(r3.w,8.), orient=floor(r3.w/8.);
  float idx=float(o)-r0.w, f=(idx+rnd(s))/max(r3.y,1.);
  if(mode<.5){                       // sphere
    vec3 u=rndUnit(s); pos+=rndUnit(s)*spread*pow(rnd(s),.333); vel+=u*spd*mix(.25,1.,rnd(s));
  } else if(mode<2.5){               // radial ring in XZ (1) or XY (2)
    float a=rnd(s)*6.2831853; vec3 rd=mode<1.5?vec3(cos(a),0.,sin(a)):vec3(cos(a),sin(a),0.);
    pos+=rd*spread*mix(.5,1.,rnd(s)); vel+=rd*spd*mix(.45,1.,rnd(s));
    if(mode>1.5) { pos.z+=(rnd(s)-.5)*2.; vel.z+=(rnd(s)-.5)*spd*.4; }
  } else {                           // segment pos -> pos+seg
    pos+=r4.xyz*f+rndUnit(s)*spread*rnd(s); vel+=rndUnit(s)*spd*rnd(s);
  }
  if(k!=8){ life*=mix(.6,1.,rnd(s)); size*=mix(.7,1.25,rnd(s)); }
  oP=vec4(pos,life); oV=vec4(vel,kind); oA=vec4(life,size,r3.x,k==4?rnd(s)*6.28:orient);
}
void main(){
  ivec2 c=ivec2(gl_FragCoord.xy);
  int slot=c.y*uW+c.x;
  int region=slot>=uRegion?1:0;
  vec4 S=region==0?uSpawn0:uSpawn1;
  int local=slot-region*uRegion;
  int o=(local-int(S.x)+uRegion)%uRegion;
  if(o<int(S.y)){ spawn(region,o,S,slot); return; }
  vec4 P=texelFetch(tP,c,0),V=texelFetch(tV,c,0),A=texelFetch(tA,c,0);
  int k=int(mod(V.w,16.));
  if(P.w<=0.){ oP=P; oV=vec4(V.xyz,float(k)); oA=A; return; }   // dead: clear flags
  float dt=uDt;
  bool floating=mod(V.w,32.)>=16.;
  vec3 p=P.xyz, v=V.xyz;
  float life=P.w-dt;
  if(k==8){ oP=vec4(p,life); oV=V; oA=A; return; }                 // shockwave: static, ages only
  vec3 acc=vec3(0.,-KG[k],0.);
  if(KT[k]>0.) acc+=curl(p,uTime)*KT[k]*3.;
  // thrust downwash: jet column + radial outflow along the ground plane
  vec3 aw=vec3(0.);
  for(int i=0;i<${NWASH};i++){
    if(i>=uNWash) break;
    vec3 S0=uWash[i].xyz, D=uWashDir[i].xyz; float R=uWash[i].w, kk=uWashDir[i].w;
    vec3 rel=p-S0; float al=dot(rel,D); vec3 perp=rel-D*al; float dr=length(perp);
    if(al>-1.&&al<R*1.4){ float w=1.+max(al,0.)*.35; aw+=D*kk*55.*exp(-dr*dr/(w*w))*(1.-max(al,0.)/(R*1.4)); }
    if(uWashG[i].w>.5){
      vec3 q=p-uWashG[i].xyz; float hh=-dot(q,D); vec3 qp=q+D*hh; float dq=length(qp);
      float wgt=smoothstep(R*1.8,0.,dq)*smoothstep(5.,0.,abs(hh))*(dq/(dq+1.2));
      aw+=(qp/max(dq,1e-3))*kk*34.*wgt - D*kk*5.*wgt;
    }
  }
  acc+=aw*KW[k];
  v+=acc*dt;
  // one-frame blast impulses (explosions push existing smoke, dust, debris, floating fuel...)
  for(int i=0;i<${NBLAST};i++){
    if(i>=uNBlast) break;
    vec3 d=p-uBlast[i].xyz; float L=length(d), R=uBlast[i].w;
    if(L<R){ float f=1.-L/R; v+=d/max(L,.3)*f*f*uBlastK[i]*KW[k]; if(k==7) floating=false; }
  }
  v*=exp(-KD[k]*dt);
  if(floating){ v.y=0.; v.xz*=exp(-1.5*dt); }
  vec3 np=p+v*dt;
  float flag=floating?16.:0.;
  if(caveRegion(np)){
    vec2 g0=(p.xy-uCave.xy)/uCave.z, g1=(np.xy-uCave.xy)/uCave.z;
    if(!caveSolid(g0)&&caveSolid(g1)){
      bool bx=caveSolid(vec2(g1.x,g0.y)), by=caveSolid(vec2(g0.x,g1.y));
      vec3 n=vec3(0.);
      if(bx){ np.x=p.x; n.x=-sign(v.x); }
      if(by){ np.y=p.y; n.y=-sign(v.y); }
      if(!bx&&!by){ np.xy=p.xy; n.xy=-normalize(v.xy+1e-5); }
      n=normalize(n);
      float vn=dot(v,n);
      if(vn<0.){ vec3 vt=v-n*vn; v=vt*(1.-KF[k])-n*vn*KB[k]; }
      if(k==6||k==9) life=0.;
    }
    if(abs(np.z)>4.4){ np.z=sign(np.z)*4.4; v.z*=-.3; }
  } else {
    bool hole=inHole(np.xz);
    float th=hole?-1e4:terrainH(np.xz);
    if(th<=0.&&!hole){
      float wy=waterY(np.xz);
      if(np.y<wy||floating){
        if(k==2||k==3||k==5){ np.y=wy+.05; v.y=abs(v.y)*.3; }
        else if(k==7){ np.y=wy+.03; v.y=0.; flag=16.; }
        else { life=0.; flag=32.; np.y=wy; }
      }
    } else if(np.y<th){
      vec3 n=terrainN(np.xz); np.y=th+.02;
      float vn=dot(v,n);
      if(vn<0.){ vec3 vt=v-n*vn; v=vt*(1.-KF[k])-n*vn*KB[k]; }
      if(k==6||k==9) life=0.;
      if(k==7) flag=0.;
    }
  }
  float aux=A.w;
  if(k==4) aux+=dt*length(v)*1.4;     // debris tumble angle
  oP=vec4(np,life); oV=vec4(v,float(k)+flag); oA=vec4(A.xyz,aux);
}
`;

// particle rendering: instanced camera-facing quads, one draw per blend pool
const RENDER_VERT = /* glsl */`
precision highp sampler2D;
uniform sampler2D tP,tV,tA; uniform int uW,uBase,uStart,uRegion; uniform float uBits,uTime;
uniform vec3 uSun; uniform vec2 uFogRange;
varying vec2 vUv; varying vec4 vCol; varying float vShape; varying float vFog;
vec3 unpackCol(float p){float m=exp2(uBits);float r=floor(p/(m*m));float g=floor((p-r*m*m)/m);float b=p-r*m*m-g*m;return vec3(r,g,b)/(m-1.);}
float h1(float n){return fract(sin(n*12.9898)*43758.5453);}
void main(){
  int slot=uBase+(uStart+gl_InstanceID)%uRegion; ivec2 c=ivec2(slot%uW,slot/uW);
  vec4 P=texelFetch(tP,c,0);
  if(P.w<=0.){gl_Position=vec4(0.,0.,-2.,1.);return;}
  vec4 V=texelFetch(tV,c,0),A=texelFetch(tA,c,0);
  int k=int(mod(V.w,16.)); bool floating=mod(V.w,32.)>=16.;
  float t=clamp(1.-P.w/max(A.x,1e-3),0.,1.), sd=h1(float(slot));
  vec3 tint=unpackCol(A.z);
  vec3 R=vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0]), U=vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1]);
  vec3 ax=R, ay=U; vec2 q=position.xy; float sx, sy, shape=0., a=1.; vec3 col;
  float sz=A.y;
  if(k==0){        // spark: hot streak
    sz*=.09; col=mix(vec3(1.,.95,.7)*3.,vec3(1.,.35,.05),t); a=1.-t*t;
  } else if(k==1){ // ember: flickering, cooling
    sz*=.16*(1.-.5*t); col=mix(vec3(1.,.6,.15)*1.8,vec3(.6,.08,0.),t)*(.6+.4*sin(uTime*25.+sd*40.)); a=1.-t;
  } else if(k==2){ // smoke: grows, soft
    sz*=1.+3.2*sqrt(t); col=vec3(mix(.16,.5,t)+.08*sd)*vec3(1.,.97,.93); a=.6*min(t*14.,1.)*pow(1.-t,1.4);
  } else if(k==3){ // dust
    sz*=.7*(1.+2.6*sqrt(t)); col=vec3(.66,.56,.4)*(.85+.25*sd); a=.62*min(t*10.,1.)*(1.-t);
  } else if(k==4){ // debris: tumbling lit chunk
    sz*=.22*min(1.,P.w*2.); float an=A.w;
    float cs=cos(an),sn=sin(an); q=vec2(q.x*cs-q.y*sn,q.x*sn+q.y*cs);
    vec3 n=normalize(vec3(cos(an*1.3+sd*6.),sin(an*.7)+.7,sin(an*1.3+sd*6.)));
    col=vec3(.34,.29,.25)*(.75+.5*sd)*(.3+.85*max(dot(n,uSun),0.)); shape=1.;
  } else if(k==5){ // exhaust plasma
    sz*=.32*(1.+2.2*t);
    col=t<.22?mix(vec3(.8,.9,1.)*2.4,vec3(1.,.6,.2)*1.7,t/.22):mix(vec3(1.,.6,.2)*1.7,vec3(.3,.07,.02),(t-.22)/.78); a=1.-t;
  } else if(k==6){ // spray droplets
    sz*=.13*(1.+t); col=vec3(.86,.93,1.); a=.8*(1.-t*t);
  } else if(k==7){ // fuel droplets / slick
    sz*=floating?.5:.17; col=vec3(.95,.68,.12)*(floating?.7:1.); a=.9*min(1.,P.w*.5);
  } else if(k==8){ // shockwave ring
    sz=A.y*(1.-pow(1.-t,3.)); col=mix(vec3(1.,.92,.75)*1.6,vec3(1.,.45,.15),t); a=pow(1.-t,1.5); shape=2.;
    if(A.w>.5&&A.w<1.5){ ax=vec3(1.,0.,0.); ay=vec3(0.,0.,1.); } else if(A.w>1.5){ ax=vec3(1.,0.,0.); ay=vec3(0.,1.,0.); }
  } else {         // plasma bolt trail
    sz*=.13*(1.-.6*t); col=vec3(.45,1.,1.)*2.; a=1.-t;
  }
  sx=sz; sy=sz;
  if(k==0||k==9||k==5){   // velocity-stretched streaks
    vec3 vd=normalize(P.xyz-cameraPosition); vec3 vp=V.xyz-vd*dot(V.xyz,vd); float L=length(vp);
    if(L>.5){ ax=vp/L; ay=normalize(cross(vd,ax)); sx=sz+L*(k==5?.012:.03); }
  }
  vec3 w=P.xyz+ax*q.x*sx+ay*q.y*sy;
  vec4 mv=viewMatrix*vec4(w,1.); gl_Position=projectionMatrix*mv;
  vFog=smoothstep(uFogRange.x,uFogRange.y,-mv.z); vUv=position.xy; vCol=vec4(col*tint,a); vShape=shape;
}
`;
const RENDER_FRAG = /* glsl */`
uniform float uAlphaPass; uniform vec3 uFogColor;
varying vec2 vUv; varying vec4 vCol; varying float vShape; varying float vFog;
void main(){
  float r2=dot(vUv,vUv), a;
  if(vShape<.5){ if(r2>1.) discard; a=1.-r2; a*=a; }
  else if(vShape<1.5){ vec2 e=abs(vUv); a=smoothstep(1.,.8,max(e.x,e.y)); }
  else { float r=sqrt(r2); if(r>1.) discard; a=smoothstep(.14,0.,abs(r-.86))+.18*smoothstep(.86,.2,r)*r; }
  a*=vCol.a; if(a<.004) discard;
  vec3 c=vCol.rgb;
  if(uAlphaPass>.5) gl_FragColor=vec4(mix(c,uFogColor,vFog),min(a,1.));
  else gl_FragColor=vec4(c*(1.-vFog),a);
}
`;

// particles that hit the water this frame splat a downward impulse into the wave sim
const WSPLAT_VERT = /* glsl */`
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D tP,tV; uniform int uW,uRegion; uniform vec4 uWin,uSpan; out float vS;
void main(){
  int id=gl_VertexID, n0=int(uSpan.y);
  int slot=id<n0?(int(uSpan.x)+id)%uRegion:uRegion+(int(uSpan.z)+id-n0)%uRegion; ivec2 c=ivec2(slot%uW,slot/uW);
  vec4 V=texelFetch(tV,c,0);
  if(V.w<32.){gl_Position=vec4(2.,2.,2.,1.);gl_PointSize=1.;vS=0.;return;}
  vec4 P=texelFetch(tP,c,0);
  int k=int(mod(V.w,16.)); float m=k==4?3.:k==6?.5:k==7?.6:1.;
  vS=min(length(V.xyz),30.)*m*.02;
  gl_Position=vec4((P.xz-uWin.xy)/uWin.z*2.-1.,0.,1.); gl_PointSize=3.;
}
`;
const SPLAT_FRAG = /* glsl */`
precision highp float; in float vS; out vec4 o;
void main(){vec2 q=gl_PointCoord*2.-1.;float r2=dot(q,q);if(r2>1.)discard;o=vec4(vS*(1.-r2),0.,0.,0.);}
`;
// wave equation on a scrolling window: R=h, G=dh/dt, B=foam
const WATER_FRAG = /* glsl */`
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D tPrev,tDist; uniform int uN; uniform ivec2 uShift; uniform float uDt,uC2,uDamp,uFirst;
uniform vec4 uWin; uniform vec4 uSplash[${NSPLASH}]; uniform int uNS;
out vec4 o;
${terrainGLSL}
vec4 get(ivec2 c){c+=uShift;if(c.x<0||c.y<0||c.x>=uN||c.y>=uN)return vec4(0.);return texelFetch(tPrev,c,0);}
void main(){
  ivec2 c=ivec2(gl_FragCoord.xy);
  vec2 xz=uWin.xy+(vec2(c)+.5)*uWin.w;
  if(terrainH(xz)>0.||inHole(xz)){o=vec4(0.);return;}
  vec4 s=get(c); float h=s.r,v=s.g,f=s.b;
  float hl=get(c+ivec2(-1,0)).r,hr=get(c+ivec2(1,0)).r,hd=get(c+ivec2(0,-1)).r,hu=get(c+ivec2(0,1)).r;
  v+=uC2*(hl+hr+hd+hu-4.*h)*uDt;
  if(uFirst>.5){
    float d=texelFetch(tDist,c,0).r; v-=d; f+=d*.6;
    for(int i=0;i<${NSPLASH};i++){ if(i>=uNS) break; vec2 q=xz-uSplash[i].xy; float r=uSplash[i].z; float w=exp(-dot(q,q)/(r*r)); v-=uSplash[i].w*w; f+=abs(uSplash[i].w)*w*.25; }
  }
  v*=uDamp; h+=v*uDt; h*=1.-.05*uDt;
  int e=min(min(c.x,c.y),min(uN-1-c.x,uN-1-c.y)); if(e<6){ float k=float(e)/6.; v*=mix(.85,1.,k); h*=mix(.9,1.,k); }
  float sl=length(vec2(hr-hl,hu-hd))/(2.*uWin.w);
  f=max(f*exp(-.7*uDt),clamp(sl*2.2-.35,0.,1.));
  o=vec4(clamp(h,-6.,6.),clamp(v,-40.,40.),min(f,2.),1.);
}
`;

// ---- cave liquid: 2D particles (cave cell units) + additive density/velocity grid
const FSPLAT_VERT = /* glsl */`
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D tF0,tF1; uniform int uW,uN,uStart; uniform vec2 uGrid; uniform float uG,uRad; out vec4 vD;
void main(){
  int slot=(uStart+gl_VertexID)%uN; ivec2 c=ivec2(slot%uW,slot/uW); vec4 a=texelFetch(tF0,c,0);
  if(a.z<=0.){gl_Position=vec4(2.,2.,2.,1.);gl_PointSize=1.;vD=vec4(0.);return;}
  vec4 b=texelFetch(tF1,c,0); float fade=min(1.,a.z/2.);
  gl_Position=vec4(a.xy*uG/uGrid*2.-1.,0.,1.); gl_PointSize=uRad*2.;
  vD=vec4(1.,b.x,b.y,a.w)*fade/(3.14159*uRad*uRad/3.);
}
`;
const FSPLAT_FRAG = /* glsl */`
precision highp float; in vec4 vD; out vec4 o;
void main(){vec2 q=gl_PointCoord*2.-1.;float r2=dot(q,q);if(r2>1.)discard;float w=(1.-r2)*(1.-r2);o=vD*w;}
`;
const FUPDATE_FRAG = /* glsl */`
precision highp float; precision highp int; precision highp sampler2D;
uniform sampler2D tF0,tF1,tGrid,tSpawn,tSolid; uniform int uW,uN; uniform vec4 uSpawn;
uniform vec2 uGrid,uCaveWH; uniform float uG,uDt,uTime,uFrame,uKp,uR0,uVisc,uGrav;
uniform vec4 uWash,uWashK; uniform vec4 uBlast[${NFBLAST}]; uniform int uNBlast;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
${RNG}
bool sol(vec2 q){ if(q.y>=uCaveWH.y) return false; if(q.x<0.||q.x>=uCaveWH.x||q.y<0.) return true; return texelFetch(tSolid,ivec2(q),0).r>.5; }
float Pr(vec2 g,float pc){ if(sol(g/uG)) return pc; return max(texture(tGrid,g/uGrid).r-uR0,0.); }
void main(){
  ivec2 c=ivec2(gl_FragCoord.xy); int slot=c.y*uW+c.x;
  int o=(slot-int(uSpawn.x)+uN)%uN;
  if(o<int(uSpawn.y)){
    int lo=0,hi=int(uSpawn.w)-1;
    for(int k=0;k<8;k++){ if(lo>=hi) break; int mid=(lo+hi+1)/2; if(float(o)>=texelFetch(tSpawn,ivec2(mid,0),0).z) lo=mid; else hi=mid-1; }
    vec4 r0=texelFetch(tSpawn,ivec2(lo,0),0),r1=texelFetch(tSpawn,ivec2(lo,1),0),r2=texelFetch(tSpawn,ivec2(lo,2),0);
    uint s=pcg(uint(slot)*7919u+uint(uFrame)*104729u);
    float a=rnd(s)*6.2831853, rr=sqrt(rnd(s));
    vec2 p=r0.xy+vec2(cos(a),sin(a))*rr*r1.w;
    float b=rnd(s)*6.2831853;
    vec2 v=r1.xy+vec2(cos(b),sin(b))*r2.x*rnd(s);
    float life=r2.y*mix(.8,1.,rnd(s));
    o0=vec4(p,life,r1.z); o1=vec4(v,life,0.); return;
  }
  vec4 F0=texelFetch(tF0,c,0),F1=texelFetch(tF1,c,0);
  if(F0.z<=0.){o0=F0;o1=F1;return;}
  float dt=uDt; vec2 p=F0.xy, v=F1.xy;
  vec2 g=p*uG; vec4 S=texture(tGrid,g/uGrid);
  float pc=max(S.r-uR0,0.);
  vec2 grad=vec2(Pr(g+vec2(1.,0.),pc)-Pr(g-vec2(1.,0.),pc),Pr(g+vec2(0.,1.),pc)-Pr(g-vec2(0.,1.),pc))*.5*uG;
  vec2 acc=-uKp*grad+vec2(0.,-uGrav);
  uint s=pcg(uint(slot)*31u+uint(uFrame)*7u);
  acc+=(vec2(rnd(s),rnd(s))-.5)*1.5;
  if(uWashK.x>0.){   // ship thrust pushes the liquid: jet + sideways spread near its end
    vec2 rel=p-uWash.xy, D=uWash.zw; float al=dot(rel,D); vec2 perp=rel-D*al; float dr=length(perp), R=uWashK.y;
    if(al>-.5&&al<R){ float w=1.+max(al,0.)*.3; float f=exp(-dr*dr/(w*w))*(1.-al/R)*uWashK.x;
      acc+=(D*45.+perp/max(dr,.05)*35.*smoothstep(0.,R*.5,al))*f; }
  }
  if(S.r>1e-4){ vec2 av=S.gb/S.r; v=mix(v,av,1.-exp(-uVisc*dt)); }
  v+=acc*dt;
  for(int i=0;i<${NFBLAST};i++){ if(i>=uNBlast) break; vec2 d=p-uBlast[i].xy; float L=length(d); if(L<uBlast[i].z){ float f=1.-L/uBlast[i].z; v+=d/max(L,.2)*f*f*uBlast[i].w; } }
  float sp=length(v); if(sp>30.) v*=30./sp;
  vec2 np=p+v*dt;
  if(!sol(p)&&sol(np)){
    bool bx=sol(vec2(np.x,p.y)), by=sol(vec2(p.x,np.y));
    if(bx){ np.x=p.x; v.x*=-.1; v.y*=.96; }
    if(by){ np.y=p.y; v.y*=-.1; v.x*=.96; }
    if(!bx&&!by){ np=p; v*=-.1; }
  } else if(sol(p)){ np=p+vec2(0.,dt*4.); }   // spawned inside rock: float out
  float life=F0.z-dt;
  if(np.y>uCaveWH.y+30.) life=0.;
  o0=vec4(np,life,F0.w); o1=vec4(v,F1.z,0.);
}
`;
const FRENDER_VERT = /* glsl */`
uniform vec2 uGrid; varying vec2 vG; varying float vFogD;
void main(){ vG=uv*uGrid; vec4 mv=modelViewMatrix*vec4(position,1.); vFogD=-mv.z; gl_Position=projectionMatrix*mv; }
`;
const FRENDER_FRAG = /* glsl */`
uniform sampler2D tGrid; uniform vec2 uGrid; uniform float uTime,uTh; uniform vec3 uFogColor; uniform vec2 uFogRange;
varying vec2 vG; varying float vFogD;
float rho(vec2 g){return texture2D(tGrid,g/uGrid).r;}
void main(){
  vec4 s=texture2D(tGrid,vG/uGrid); float r=s.r;
  float a=smoothstep(uTh,uTh*1.7,r); if(a<.01) discard;
  vec2 gr=vec2(rho(vG+vec2(1.,0.))-rho(vG-vec2(1.,0.)),rho(vG+vec2(0.,1.))-rho(vG-vec2(0.,1.)));
  vec3 n=normalize(vec3(-gr*2.5,1.));
  float kd=clamp(s.a/max(r,1e-4),0.,2.);
  vec3 fuel=vec3(1.,.62,.08), cool=vec3(.15,.95,.85), wat=vec3(.2,.45,1.);
  vec3 col=kd<1.?mix(fuel,cool,kd):mix(cool,wat,kd-1.);
  vec3 L=normalize(vec3(.35,.7,.6));
  float dif=.7+.3*dot(n,L), spec=pow(max(reflect(-L,n).z,0.),24.);
  float rim=1.-smoothstep(uTh*1.4,uTh*3.,r);
  float ripple=.06*sin(vG.x*1.3+uTime*3.+sin(vG.y*.9-uTime*2.)*2.);
  vec3 c=col*(dif*.9+ripple)+vec3(spec*.6)+col*rim*.5;
  c=mix(c,uFogColor,smoothstep(uFogRange.x,uFogRange.y,vFogD));
  gl_FragColor=vec4(c,a*.9);
}
`;

const INIT_FRAG = /* glsl */`
precision highp float;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1; layout(location=2) out vec4 o2;
void main(){o0=vec4(0.);o1=vec4(0.);o2=vec4(0.);}
`;
const INIT_FRAG2 = /* glsl */`
precision highp float;
layout(location=0) out vec4 o0; layout(location=1) out vec4 o1;
void main(){o0=vec4(0.);o1=vec4(0.);}
`;

// ------------------------------------------------------------------ helpers
const pow2 = (n, lo, hi) => { n = clamp(Math.round(n) || lo, lo, hi); return 1 << Math.round(Math.log2(n)); };
const X = v => Array.isArray(v) ? v[0] : (v ? v.x : 0) || 0;
const Y = v => Array.isArray(v) ? v[1] : (v ? v.y : 0) || 0;
const Zc = v => Array.isArray(v) ? (v[2] || 0) : (v ? v.z : 0) || 0;
const _col = new THREE.Color();
function packColor(c, bits) {
  let r = 1, g = 1, b = 1;
  if (c != null) {
    if (typeof c === 'number' || typeof c === 'string') { _col.set(c); r = _col.r; g = _col.g; b = _col.b; }
    else if (Array.isArray(c)) [r, g, b] = c;
    else ({ r, g, b } = c);
  }
  const m = (1 << bits) - 1, q = x => Math.round(clamp(x, 0, 1) * m);
  return q(r) * (m + 1) * (m + 1) + q(g) * (m + 1) + q(b);
}
const rawMat = (frag, uniforms, vert = FSQ_VERT, extra = {}) => new THREE.RawShaderMaterial({
  glslVersion: THREE.GLSL3, vertexShader: vert, fragmentShader: frag, uniforms,
  depthTest: false, depthWrite: false, ...extra,
});
const ADD_BLEND = { transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor };

class GpuFx {
  constructor(renderer, scene, o = {}) {
    this.renderer = renderer; this.scene = scene;
    const ex = renderer.extensions;
    this.floatOK = ex.has('EXT_color_buffer_float');
    this.halfOK = this.floatOK || ex.has('EXT_color_buffer_half_float');
    this.stateType = this.floatOK ? THREE.FloatType : THREE.HalfFloatType;
    this.bits = this.floatOK ? 8 : 3;
    this.cfg = { particleBudget: 16384, waterSim: true, waterRes: 256, waterSize: 256, caveFluid: true, caveFluidRes: 8192, explosionScale: 1 };
    for (const k of Object.keys(this.cfg)) if (o[k] !== undefined) this.cfg[k] = o[k];
    if (o.budget) this.cfg.particleBudget = o.budget;
    this.sun = new THREE.Vector3(0.5, 1, 0.3).normalize();
    this.time = 0; this.frame = 0; this.dt = 1 / 60;
    this._cs = new THREE.Scene(); this._cam = new THREE.Camera();
    const tri = new THREE.BufferGeometry(); tri.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    this._quad = new THREE.Mesh(tri); this._quad.frustumCulled = false;
    this._init3 = rawMat(INIT_FRAG, {}); this._init2 = rawMat(INIT_FRAG2, {});
    this._req = [[], []]; this._nreq = 0; this._wash = []; this._blast = []; this._splash = []; this._freq = []; this._fblast = []; this._fwash = null;
    this._acc = new Map();
    this.waterUniforms = waterUniforms; this.waterGLSL = waterGLSL; this.terrainGLSL = terrainGLSL;
    this.cave = null;
    this._solidTex = new THREE.DataTexture(new Uint8Array(1), 1, 1, THREE.RedFormat, THREE.UnsignedByteType); this._solidTex.needsUpdate = true;
    this._v4 = n => Array.from({ length: n }, () => new THREE.Vector4());
    this.gpuMs = null; this.cpuMs = 0;
    const gl = renderer.getContext(); this._gl = gl; this._tq = gl.getExtension('EXT_disjoint_timer_query_webgl2');
    this._buildParticles(); this._buildWater(); this._buildFluid();
  }

  // ------------------------------------------------------------ GPU plumbing
  _pass(obj, target, clear = false) {
    const r = this.renderer;
    this._cs.add(obj);
    r.setRenderTarget(target);
    if (clear) r.clear(true, false, false);
    r.render(this._cs, this._cam);
    this._cs.remove(obj);
  }
  _fsq(mat, target) { this._quad.material = mat; this._pass(this._quad, target); }
  // run the current quad material over the texture rows holding ring slots [start, start+n) of a pool at slot offset off
  _scissorRows(rt, off, start, n, size, W) {
    if (n <= 0) return;
    const rows = (a, b) => { const r0 = Math.floor((off + a) / W), r1 = Math.floor((off + b - 1) / W); rt.scissor.set(0, r0, W, r1 - r0 + 1); rt.scissorTest = true; this._pass(this._quad, rt); };
    if (start + n <= size) rows(start, start + n); else { rows(start, size); rows(0, start + n - size); }
    rt.scissorTest = false;
  }
  // [end, count] pairs in spawn order: prune expired from the front; span = slots since the oldest live batch
  _span(B, size) {
    let f = 0; while (f < B.length && B[f] <= this.time) f += 2;
    if (f) B.splice(0, f);
    let alive = 0, span = 0;
    for (let i = 0; i < B.length; i += 2) { span += B[i + 1]; if (B[i] > this.time) alive += B[i + 1]; }
    if (B.length > 4096) B.splice(0, B.length - 4096);
    return { alive: Math.min(alive, size), span: Math.min(span, size) };
  }
  _rt(w, h, type, count = 1, linear = false) {
    const f = linear ? THREE.LinearFilter : THREE.NearestFilter;
    return new THREE.WebGLRenderTarget(w, h, { count, type, format: THREE.RGBAFormat, minFilter: f, magFilter: f, wrapS: THREE.ClampToEdgeWrapping, wrapT: THREE.ClampToEdgeWrapping, depthBuffer: false, stencilBuffer: false, generateMipmaps: false });
  }
  _begin() {
    const r = this.renderer;
    this._saved = { rt: r.getRenderTarget(), ac: r.autoClear, cc: r.getClearColor(new THREE.Color()), ca: r.getClearAlpha() };
    r.autoClear = false; r.setClearColor(0x000000, 0);
  }
  _end() { const r = this.renderer, s = this._saved; r.setRenderTarget(s.rt); r.autoClear = s.ac; r.setClearColor(s.cc, s.ca); }

  // ------------------------------------------------------------ particles
  _buildParticles() {
    const N = pow2(this.cfg.particleBudget, 4096, 262144), lg = Math.log2(N), W = 1 << Math.ceil(lg / 2), H = N / W;
    Object.assign(this, { N, PW: W, PH: H, region: N / 2, bscale: clamp(Math.sqrt(N / 16384), 0.5, 2.5) });
    this._prt = [this._rt(W, H, this.stateType, 3), this._rt(W, H, this.stateType, 3)]; this._pi = 0;
    this._cursor = [0, 0]; this._batches = [[], []]; this._alive = [0, 0]; this._spanS = [0, 0]; this._spanN = [0, 0];
    this._spawnData = new Float32Array(MAXREQ * 5 * 4);
    this._spawnTex = new THREE.DataTexture(this._spawnData, MAXREQ, 5, THREE.RGBAFormat, THREE.FloatType);
    this._updMat = rawMat(UPDATE_FRAG, {
      tP: { value: null }, tV: { value: null }, tA: { value: null }, tSpawn: { value: this._spawnTex }, tWater: { value: _blackTex }, tSolid: { value: this._solidTex },
      uW: { value: W }, uRegion: { value: N / 2 }, uSpawn0: { value: new THREE.Vector4() }, uSpawn1: { value: new THREE.Vector4() },
      uDt: { value: 0 }, uTime: { value: 0 }, uFrame: { value: 0 },
      uWash: { value: this._v4(NWASH) }, uWashDir: { value: this._v4(NWASH) }, uWashG: { value: this._v4(NWASH) }, uNWash: { value: 0 },
      uBlast: { value: this._v4(NBLAST) }, uBlastK: { value: new Float32Array(NBLAST) }, uNBlast: { value: 0 },
      uWaterWin: { value: new THREE.Vector4(0, 0, 1, 0) }, uCave: { value: new THREE.Vector4() }, uCaveWH: { value: new THREE.Vector2(1, 1) },
    });
    for (const rt of this._prt) { this._begin(); this._fsq(this._init3, rt); this._end(); }
    // render: one instanced-quad draw per blend pool
    const pg = new THREE.PlaneGeometry(2, 2);
    const mkMesh = (alpha) => {
      const g = new THREE.InstancedBufferGeometry(); g.index = pg.index; g.setAttribute('position', pg.attributes.position); g.instanceCount = N / 2;
      const m = new THREE.ShaderMaterial({
        vertexShader: RENDER_VERT, fragmentShader: RENDER_FRAG, transparent: true, depthWrite: false,
        blending: alpha ? THREE.NormalBlending : THREE.AdditiveBlending,
        uniforms: {
          tP: { value: null }, tV: { value: null }, tA: { value: null }, uW: { value: W }, uBase: { value: alpha ? N / 2 : 0 }, uStart: { value: 0 }, uRegion: { value: N / 2 },
          uBits: { value: this.bits }, uTime: { value: 0 }, uSun: { value: this.sun }, uFogRange: { value: new THREE.Vector2(1e4, 2e4) },
          uFogColor: { value: new THREE.Color() }, uAlphaPass: { value: alpha ? 1 : 0 },
        },
      });
      const mesh = new THREE.Mesh(g, m); mesh.frustumCulled = false; mesh.renderOrder = alpha ? 10 : 11; mesh.name = alpha ? 'gpufx-alpha' : 'gpufx-add';
      this.scene.add(mesh); return mesh;
    };
    this.alphaMesh = mkMesh(true); this.addMesh = mkMesh(false);
    // water-hit splats (attribute-less points, gl_VertexID = slot)
    const sg = new THREE.BufferGeometry(); sg.setDrawRange(0, N);
    this._wsplat = new THREE.Points(sg, rawMat(SPLAT_FRAG, { tP: { value: null }, tV: { value: null }, uW: { value: W }, uRegion: { value: N / 2 }, uWin: { value: new THREE.Vector4() }, uSpan: { value: new THREE.Vector4() } }, WSPLAT_VERT, ADD_BLEND));
    this._wsplat.frustumCulled = false;
    this._bindParticleTex();
  }
  _bindParticleTex() {
    const t = this._prt[this._pi].textures;
    [this.addMesh, this.alphaMesh].forEach((mesh, reg) => {
      const u = mesh.material.uniforms; u.tP.value = t[0]; u.tV.value = t[1]; u.tA.value = t[2];
      u.uStart.value = this._spanS[reg]; mesh.geometry.instanceCount = this._spanN[reg]; mesh.visible = this._spanN[reg] > 0;
    });
    const u = this._wsplat.material.uniforms; u.tP.value = t[0]; u.tV.value = t[1];
    u.uSpan.value.set(this._spanS[0], this._spanN[0], this._spanS[1], this._spanN[1]);
    this._wsplat.geometry.setDrawRange(0, this._spanN[0] + this._spanN[1]);
  }
  _disposeParticles() {
    for (const rt of this._prt) rt.dispose();
    for (const m of [this.alphaMesh, this.addMesh]) { this.scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
    this._spawnTex.dispose(); this._updMat.dispose(); this._wsplat.material.dispose();
  }
  _stepParticles(dt) {
    const D = this._spawnData, S = [new THREE.Vector4(), new THREE.Vector4()];
    let n = 0;
    for (let reg = 0; reg < 2; reg++) {
      let start = 0; const first = n, B = this._batches[reg];
      for (const q of this._req[reg]) {
        if (n >= MAXREQ) break;
        const cnt = Math.min(q.count, this.region - start); if (cnt <= 0) break;
        const w = (row, a, b, c, d) => { const i = (row * MAXREQ + n) * 4; D[i] = a; D[i + 1] = b; D[i + 2] = c; D[i + 3] = d; };
        w(0, q.px, q.py, q.pz, start); w(1, q.vx, q.vy, q.vz, q.k); w(2, q.spread, q.speed, q.life, q.size);
        w(3, q.col, cnt, 0, q.mode + 8 * q.orient); w(4, q.sx, q.sy, q.sz, 0);
        B.push(this.time + q.life * (q.k === 7 ? 1.5 : 1.05), cnt);
        start += cnt; n++;
      }
      S[reg].set(this._cursor[reg], start, first, n - first);
      this._cursor[reg] = (this._cursor[reg] + start) % this.region;
    }
    // live span per pool: batches are kept in spawn order and only pruned from the front, so every slot that can
    // still be alive lies in the last span slots behind the cursor. All passes and draws touch only that span.
    for (let reg = 0; reg < 2; reg++) {
      const r = this._span(this._batches[reg], this.region);
      this._alive[reg] = r.alive; this._spanN[reg] = r.span; this._spanS[reg] = (this._cursor[reg] - r.span + this.region) % this.region;
    }
    this._pStepped = false;
    this._bindParticleTex();
    if (this._spanN[0] + this._spanN[1] === 0) return;
    if (n) this._spawnTex.needsUpdate = true;
    const u = this._updMat.uniforms, src = this._prt[this._pi].textures;
    u.tP.value = src[0]; u.tV.value = src[1]; u.tA.value = src[2];
    u.uSpawn0.value.copy(S[0]); u.uSpawn1.value.copy(S[1]);
    u.uDt.value = dt; u.uTime.value = this.time; u.uFrame.value = this.frame % 65536;
    const nw = Math.min(this._wash.length, NWASH); u.uNWash.value = nw;
    for (let i = 0; i < nw; i++) {
      const w = this._wash[i];
      u.uWash.value[i].set(w.px, w.py, w.pz, w.R); u.uWashDir.value[i].set(w.dx, w.dy, w.dz, w.k);
      if (w.hit) u.uWashG.value[i].set(w.hit.x, w.hit.y, w.hit.z, 1); else u.uWashG.value[i].set(0, 0, 0, 0);
    }
    const nb = Math.min(this._blast.length, NBLAST); u.uNBlast.value = nb;
    for (let i = 0; i < nb; i++) { const b = this._blast[i]; u.uBlast.value[i].set(b.x, b.y, b.z, b.r); u.uBlastK.value[i] = b.k; }
    u.uWaterWin.value.copy(waterUniforms.uWaterWin.value); u.uWaterWin.value.w = this._wrt ? 1 : 0;
    u.tWater.value = this._wrt ? this._wrt[this._wi].texture : _blackTex;
    this._pi ^= 1;
    this._quad.material = this._updMat;
    for (let reg = 0; reg < 2; reg++) this._scissorRows(this._prt[this._pi], reg * this.region, this._spanS[reg], this._spanN[reg], this.region, this.PW);
    this._bindParticleTex();
    this._pStepped = true;
  }

  // ------------------------------------------------------------ water surface
  _buildWater() {
    this._wrt = null;
    waterUniforms.uWaterTex.value = _blackTex;
    if (!this.cfg.waterSim || !this.halfOK) return;
    const N = pow2(this.cfg.waterRes, 64, 512), size = this.cfg.waterSize;
    Object.assign(this, { WN: N, wcell: size / N });
    this._wrt = [this._rt(N, N, THREE.HalfFloatType, 1, true), this._rt(N, N, THREE.HalfFloatType, 1, true)]; this._wi = 0;
    this._wdist = this._rt(N, N, THREE.HalfFloatType, 1, false);
    this._wmin = null;
    this._wMat = rawMat(WATER_FRAG, {
      tPrev: { value: null }, tDist: { value: this._wdist.texture }, uN: { value: N }, uShift: { value: [0, 0] },
      uDt: { value: 0 }, uC2: { value: 0 }, uDamp: { value: 1 }, uFirst: { value: 1 }, uWin: { value: new THREE.Vector4() },
      uSplash: { value: this._v4(NSPLASH) }, uNS: { value: 0 },
    });
    this._begin(); for (const rt of [...this._wrt, this._wdist]) { this.renderer.setRenderTarget(rt); this.renderer.clear(true, false, false); } this._end();
    waterUniforms.uWaterTex.value = this._wrt[0].texture;
  }
  _disposeWater() { if (!this._wrt) return; for (const rt of [...this._wrt, this._wdist]) rt.dispose(); this._wMat.dispose(); this._wrt = null; }
  _stepWater(dt, pp) {
    const N = this.WN, cell = this.wcell, size = N * cell;
    const minX = Math.round(((pp ? pp.x : 0) - size / 2) / cell) * cell, minZ = Math.round(((pp ? pp.z : 0) - size / 2) / cell) * cell;
    let sx = 0, sz = 0;
    if (this._wmin) { sx = Math.round((minX - this._wmin[0]) / cell); sz = Math.round((minZ - this._wmin[1]) / cell); }
    this._wmin = [minX, minZ];
    const win = waterUniforms.uWaterWin.value; win.set(minX, minZ, size, cell);
    // disturbances: particles that hit the water this frame
    this.renderer.setRenderTarget(this._wdist); this.renderer.clear(true, false, false);
    if (this._pStepped) { this._wsplat.material.uniforms.uWin.value.set(minX, minZ, size, cell); this._pass(this._wsplat, this._wdist); }
    const u = this._wMat.uniforms, c = 9;
    const ns = Math.min(this._splash.length, NSPLASH); u.uNS.value = ns;
    for (let i = 0; i < ns; i++) { const s = this._splash[i]; u.uSplash.value[i].set(s.x, s.z, Math.max(s.r, cell), s.k); }
    const steps = clamp(Math.ceil(dt * c / (0.45 * cell)), 1, 4), h = dt / steps;
    u.uWin.value.copy(win); u.uC2.value = c * c / (cell * cell); u.uDt.value = h; u.uDamp.value = Math.exp(-0.5 * h);
    for (let i = 0; i < steps; i++) {
      u.tPrev.value = this._wrt[this._wi].texture; u.uShift.value = i === 0 ? [sx, sz] : [0, 0]; u.uFirst.value = i === 0 ? 1 : 0;
      this._wi ^= 1; this._fsq(this._wMat, this._wrt[this._wi]);
    }
    waterUniforms.uWaterTex.value = this._wrt[this._wi].texture;
  }

  // ------------------------------------------------------------ cave liquid
  _buildFluid() {
    this._frt = null;
    if (!this.cfg.caveFluid) return;
    const N = pow2(this.cfg.caveFluidRes, 1024, 65536), lg = Math.log2(N), W = 1 << Math.ceil(lg / 2), H = N / W;
    Object.assign(this, { FN: N, FW: W, FH: H, fG: 3 });
    this._frt = [this._rt(W, H, this.stateType, 2), this._rt(W, H, this.stateType, 2)]; this._fi = 0;
    this._fcursor = 0; this._fbatches = []; this._falive = 0;
    this._fData = new Float32Array(MAXFREQ * 3 * 4);
    this._fSpawnTex = new THREE.DataTexture(this._fData, MAXFREQ, 3, THREE.RGBAFormat, THREE.FloatType);
    this._fUpd = rawMat(FUPDATE_FRAG, {
      tF0: { value: null }, tF1: { value: null }, tGrid: { value: null }, tSpawn: { value: this._fSpawnTex }, tSolid: { value: this._solidTex },
      uW: { value: W }, uN: { value: N }, uSpawn: { value: new THREE.Vector4() }, uGrid: { value: new THREE.Vector2(1, 1) }, uCaveWH: { value: new THREE.Vector2(1, 1) },
      uG: { value: this.fG }, uDt: { value: 0 }, uTime: { value: 0 }, uFrame: { value: 0 }, uKp: { value: 60 }, uR0: { value: 0.08 }, uVisc: { value: 4 }, uGrav: { value: 12 },
      uWash: { value: new THREE.Vector4() }, uWashK: { value: new THREE.Vector4() }, uBlast: { value: this._v4(NFBLAST) }, uNBlast: { value: 0 },
    });
    const sg = new THREE.BufferGeometry(); sg.setDrawRange(0, N);
    this._fsplat = new THREE.Points(sg, rawMat(FSPLAT_FRAG, { tF0: { value: null }, tF1: { value: null }, uW: { value: W }, uN: { value: N }, uStart: { value: 0 }, uGrid: { value: new THREE.Vector2(1, 1) }, uG: { value: this.fG }, uRad: { value: 2.8 } }, FSPLAT_VERT, ADD_BLEND));
    this._fsplat.frustumCulled = false;
    for (const rt of this._frt) { this._begin(); this._fsq(this._init2, rt); this._end(); }
    if (this.cave) this._buildFluidGrid();
  }
  _buildFluidGrid() {
    if (!this._frt || !this.cave) return;
    const c = this.cave, GW = c.W * this.fG, GH = c.H * this.fG;
    if (this._fgrid) this._fgrid.dispose();
    this._fgrid = this._rt(GW, GH, THREE.HalfFloatType, 1, true);
    this._begin(); this.renderer.setRenderTarget(this._fgrid); this.renderer.clear(true, false, false); this._end();
    for (const u of [this._fUpd.uniforms, this._fsplat.material.uniforms]) u.uGrid.value.set(GW, GH);
    this._fUpd.uniforms.uCaveWH.value.set(c.W, c.H); this._fUpd.uniforms.tSolid.value = this._solidTex;
    if (this.liquidMesh) { this.scene.remove(this.liquidMesh); this.liquidMesh.geometry.dispose(); this.liquidMesh.material.dispose(); }
    const m = new THREE.ShaderMaterial({
      vertexShader: FRENDER_VERT, fragmentShader: FRENDER_FRAG, transparent: true, depthWrite: false,
      uniforms: { tGrid: { value: this._fgrid.texture }, uGrid: { value: new THREE.Vector2(GW, GH) }, uTime: { value: 0 }, uTh: { value: 0.07 }, uFogColor: { value: new THREE.Color() }, uFogRange: { value: new THREE.Vector2(1e4, 2e4) } },
    });
    const mesh = this.liquidMesh = new THREE.Mesh(new THREE.PlaneGeometry(c.W * c.cs, c.H * c.cs), m);
    mesh.position.set(c.ox + c.W * c.cs / 2, c.oy + c.H * c.cs / 2, c.zPlane);
    mesh.renderOrder = 9; mesh.frustumCulled = false; mesh.visible = false; mesh.name = 'gpufx-liquid';
    this.scene.add(mesh);
  }
  _disposeFluid() {
    if (!this._frt) return;
    for (const rt of this._frt) rt.dispose(); this._fUpd.dispose(); this._fsplat.material.dispose(); this._fSpawnTex.dispose();
    if (this._fgrid) { this._fgrid.dispose(); this._fgrid = null; }
    if (this.liquidMesh) { this.scene.remove(this.liquidMesh); this.liquidMesh.geometry.dispose(); this.liquidMesh.material.dispose(); this.liquidMesh = null; }
    this._frt = null;
  }
  _stepFluid(dt) {
    const D = this._fData; let n = 0, start = 0;
    for (const q of this._freq) {
      if (n >= MAXFREQ) break; const cnt = Math.min(q.count, this.FN - start); if (cnt <= 0) break;
      const w = (row, a, b, c, d) => { const i = (row * MAXFREQ + n) * 4; D[i] = a; D[i + 1] = b; D[i + 2] = c; D[i + 3] = d; };
      w(0, q.x, q.y, start, cnt); w(1, q.vx, q.vy, q.kind, q.spread); w(2, q.speed, q.life, 0, 0);
      this._fbatches.push(this.time + q.life, cnt); start += cnt; n++;
    }
    const sp = this._span(this._fbatches, this.FN), fs = (this._fcursor + start - sp.span + this.FN) % this.FN;
    this._falive = sp.alive;
    if (this.liquidMesh) this.liquidMesh.visible = sp.span > 0;
    if (!sp.span) return;
    if (n) this._fSpawnTex.needsUpdate = true;
    const u = this._fUpd.uniforms, su = this._fsplat.material.uniforms, sub = 2, h = dt / sub;
    u.uDt.value = h; u.uTime.value = this.time; u.uFrame.value = this.frame % 65536;
    const fw = this._fwash;
    if (fw) { u.uWash.value.set(fw.x, fw.y, fw.dx, fw.dy); u.uWashK.value.set(fw.k, fw.R, 0, 0); } else u.uWashK.value.set(0, 0, 0, 0);
    const nb = Math.min(this._fblast.length, NFBLAST); u.uNBlast.value = nb;
    for (let i = 0; i < nb; i++) { const b = this._fblast[i]; u.uBlast.value[i].set(b.x, b.y, b.r, b.k); }
    for (let s = 0; s < sub; s++) {
      const src = this._frt[this._fi].textures;
      su.tF0.value = src[0]; su.tF1.value = src[1];
      su.uStart.value = fs; this._fsplat.geometry.setDrawRange(0, sp.span);
      this._pass(this._fsplat, this._fgrid, true);
      u.tF0.value = src[0]; u.tF1.value = src[1]; u.tGrid.value = this._fgrid.texture;
      u.uSpawn.value.set(this._fcursor, s === 0 ? start : 0, 0, n);
      if (s === 1) u.uNBlast.value = 0;
      this._fi ^= 1; this._quad.material = this._fUpd; this._scissorRows(this._frt[this._fi], 0, fs, sp.span, this.FN, this.FW);
    }
    this._fcursor = (this._fcursor + start) % this.FN;
  }

  // ------------------------------------------------------------ public: setup
  setCave({ solid, W, H, cellSize = 1.6, origin = { x: 0, y: 0 }, zPlane = 0.6 }) {
    const d = new Uint8Array(W * H); for (let i = 0; i < W * H; i++) d[i] = solid[i] ? 255 : 0;
    this._solidTex.dispose();
    this._solidTex = new THREE.DataTexture(d, W, H, THREE.RedFormat, THREE.UnsignedByteType); this._solidTex.needsUpdate = true;
    this.cave = { solid, W, H, cs: cellSize, ox: X(origin), oy: Y(origin), zPlane };
    const u = this._updMat.uniforms; u.tSolid.value = this._solidTex; u.uCave.value.set(this.cave.ox, this.cave.oy, cellSize, 1); u.uCaveWH.value.set(W, H);
    this._buildFluidGrid();
  }
  setSettings(s = {}) {
    const old = { ...this.cfg }; Object.assign(this.cfg, s);
    const ch = k => old[k] !== this.cfg[k];
    if (ch('particleBudget') && pow2(old.particleBudget, 4096, 262144) !== pow2(this.cfg.particleBudget, 4096, 262144)) { this._disposeParticles(); this._buildParticles(); if (this.cave) this.setCave({ ...this.cave, cellSize: this.cave.cs, origin: { x: this.cave.ox, y: this.cave.oy } }); }
    if (ch('waterSim') || ch('waterRes') || ch('waterSize')) { this._disposeWater(); this._buildWater(); }
    if (ch('caveFluid') || ch('caveFluidRes')) { this._disposeFluid(); this._buildFluid(); }
    return this.cfg;
  }
  setSun(v) { this.sun.set(X(v), Y(v), Zc(v)).normalize(); }

  // ------------------------------------------------------------ public: per frame
  update(dt, { camera = null, playerPos = null, inCave = false } = {}) {
    const t0 = performance.now(), gl = this._gl;
    dt = clamp(dt || 0, 0, 0.05); this.dt = dt || 1 / 60; this.time += dt; this.frame++;
    waterUniforms.uWaterTime.value = this.time;
    if (this._q && !this._qOn && gl.getQueryParameter(this._q, gl.QUERY_RESULT_AVAILABLE)) {
      if (!gl.getParameter(this._tq.GPU_DISJOINT_EXT)) { const ms = gl.getQueryParameter(this._q, gl.QUERY_RESULT) / 1e6; this.gpuMs = this.gpuMs == null ? ms : lerp(this.gpuMs, ms, 0.1); }
      gl.deleteQuery(this._q); this._q = null;
    }
    if (this._tq && !this._q) { this._q = gl.createQuery(); gl.beginQuery(this._tq.TIME_ELAPSED_EXT, this._q); this._qOn = true; }
    this._begin();
    if (dt > 0) {
      this._stepParticles(dt);
      if (this._wrt && !inCave) this._stepWater(dt, playerPos);
      if (this._frt && this._fgrid && (inCave || this._freq.length)) this._stepFluid(dt);
    }
    this._end();
    if (this._qOn) { gl.endQuery(this._tq.TIME_ELAPSED_EXT); this._qOn = false; }
    // render uniforms
    const fog = this.scene.fog;
    for (const m of [this.alphaMesh.material, this.addMesh.material, this.liquidMesh && this.liquidMesh.material]) {
      if (!m) continue; const u = m.uniforms;
      u.uTime.value = this.time;
      if (fog && fog.isFog) { u.uFogColor.value.copy(fog.color); u.uFogRange.value.set(fog.near, fog.far); }
      else if (fog && fog.isFogExp2) { u.uFogColor.value.copy(fog.color); u.uFogRange.value.set(0, 2 / Math.max(fog.density, 1e-5)); }
      else u.uFogRange.value.set(1e5, 2e5);
    }
    this._req[0].length = 0; this._req[1].length = 0; this._nreq = 0;
    this._wash.length = 0; this._blast.length = 0; this._splash.length = 0; this._freq.length = 0; this._fblast.length = 0; this._fwash = null;
    this.cpuMs = performance.now() - t0;
  }
  stats() {
    return {
      alive: this._alive[0] + this._alive[1], additive: this._alive[0], alpha: this._alive[1], budget: this.N,
      liquid: this._frt ? this._falive : 0, liquidBudget: this._frt ? this.FN : 0, waterRes: this._wrt ? this.WN : 0,
      float: this.floatOK, ms: this.gpuMs, cpuMs: this.cpuMs,
    };
  }
  dispose() { this._disposeParticles(); this._disposeWater(); this._disposeFluid(); this._solidTex.dispose(); }

  // ------------------------------------------------------------ public: emission
  emit(kind, pos, vel, count = 1, o = {}) {
    const k = typeof kind === 'string' ? KIND[kind] : kind;
    if (k === undefined || k < 0 || k > 9) return;
    count = Math.round(count); if (count <= 0 || this._nreq >= MAXREQ) return;
    const d = KDEF[k], seg = o.seg;
    this._req[ADDITIVE[k] ? 0 : 1].push({
      k, px: X(pos), py: Y(pos), pz: Zc(pos), vx: X(vel), vy: Y(vel), vz: Zc(vel), count,
      spread: o.spread ?? d.spread, speed: o.speed ?? d.speed, life: o.life ?? d.life, size: o.size ?? (k === 8 ? 10 : 1),
      col: packColor(o.color, this.bits), mode: typeof o.mode === 'string' ? MODE[o.mode] : (o.mode || 0), orient: o.orient || 0,
      sx: X(seg), sy: Y(seg), sz: Zc(seg),
    });
    this._nreq++;
  }
  // frame-rate independent emission count for continuous emitters
  _rate(key, perSec) { const a = (this._acc.get(key) || 0) + perSec * this.dt; const n = Math.floor(a); this._acc.set(key, a - n); return n; }
  splash(x, z, radius = 2, strength = 3) { if (this._splash.length < NSPLASH) this._splash.push({ x, z, r: radius, k: strength }); }
  blast(pos, radius, strength) { if (this._blast.length < NBLAST) this._blast.push({ x: X(pos), y: Y(pos), z: Zc(pos), r: radius, k: strength }); }
  caveToWorld(x, y) { const c = this.cave; return { x: c.ox + x * c.cs, y: c.oy + y * c.cs, z: 0 }; }
  worldToCave(p) { const c = this.cave; return { x: (X(p) - c.ox) / c.cs, y: (Y(p) - c.oy) / c.cs }; }
  inCaveRegion(p) {
    const c = this.cave; if (!c) return false;
    const gx = (X(p) - c.ox) / c.cs, gy = (Y(p) - c.oy) / c.cs;
    return gy < c.H && gy > -14 && gx > -14 && gx < c.W + 14 && Math.abs(Zc(p)) < 9;
  }
  _caveSolid(gx, gy) { const c = this.cave; if (gy >= c.H) return false; if (gx < 0 || gy < 0 || gx >= c.W) return true; return !!c.solid[Math.floor(gy) * c.W + Math.floor(gx)]; }
  // march from p along unit d up to R: first hit with cave rock, land or water
  _ray(p, d, R) {
    let px = X(p), py = Y(p), pz = Zc(p), lx = px, ly = py;
    for (let t = 0; t <= R; t += 0.4) {
      const x = px + d.x * t, y = py + d.y * t, z = pz + d.z * t;
      if (this.inCaveRegion({ x, y, z })) {
        const c = this.cave, gx = (x - c.ox) / c.cs, gy = (y - c.oy) / c.cs;
        if (this._caveSolid(gx, gy)) {
          const ogx = (lx - c.ox) / c.cs, ogy = (ly - c.oy) / c.cs, n = { x: 0, y: 0, z: 0 };
          if (Math.floor(gx) !== Math.floor(ogx)) n.x = -Math.sign(d.x);
          if (Math.floor(gy) !== Math.floor(ogy)) n.y = -Math.sign(d.y);
          if (!n.x && !n.y) n.y = 1;
          const l = Math.hypot(n.x, n.y); n.x /= l; n.y /= l;
          return { x: lx, y: ly, z, t, n, cave: true, water: false };
        }
      } else if (!inHole(x, z)) {
        const th = terrainH(x, z);
        if (th <= 0 && y <= 0) return { x, y: 0, z, t, n: { x: 0, y: 1, z: 0 }, cave: false, water: true };
        if (th > 0 && y <= th) return { x, y: th, z, t, n: this._tn(x, z), cave: false, water: false };
      }
      lx = x; ly = y;
    }
    return null;
  }
  _tn(x, z) { const e = 0.6, hx = terrainH(x + e, z) - terrainH(x - e, z), hz = terrainH(x, z + e) - terrainH(x, z - e), l = Math.hypot(hx, 2 * e, hz); return { x: -hx / l, y: 2 * e / l, z: -hz / l }; }
  _surface(p) {   // {cave, water, gy, n} for a world point
    if (this.inCaveRegion(p)) return { cave: true, water: false, gy: -Infinity, n: null };
    const x = X(p), z = Zc(p);
    if (inHole(x, z)) return { cave: false, water: false, gy: -1e4, n: { x: 0, y: 1, z: 0 } };
    const th = terrainH(x, z);
    return th <= 0 ? { cave: false, water: true, gy: 0, n: { x: 0, y: 1, z: 0 } } : { cave: false, water: false, gy: th, n: this._tn(x, z) };
  }

  // thrust downwash: call every frame while thrusting. pos = nozzle, dir = exhaust direction (unit-ish), strength 0..1
  downwash(pos, dir, strength = 1) {
    const l = Math.hypot(X(dir), Y(dir), Zc(dir)) || 1, d = { x: X(dir) / l, y: Y(dir) / l, z: Zc(dir) / l };
    const k = clamp(strength, 0, 1.5), R = 6 + 12 * k;
    if (k <= 0.01) return;
    const hit = this._ray(pos, d, R);
    if (this._wash.length < NWASH) this._wash.push({ px: X(pos), py: Y(pos), pz: Zc(pos), dx: d.x, dy: d.y, dz: d.z, R, k, hit });
    if (this.cave && this.inCaveRegion(pos) && !this._fwash) {
      const c = this.cave; this._fwash = { x: (X(pos) - c.ox) / c.cs, y: (Y(pos) - c.oy) / c.cs, dx: d.x, dy: d.y, k: k, R: R / c.cs };
    }
    if (!hit) return;
    const prox = 1 - hit.t / R, I = k * prox, bs = this.bscale, key = this._wash.length;
    if (hit.water) {
      this.splash(hit.x, hit.z, 2 + 2.5 * prox, I * 30 * this.dt);
      this.emit('spray', { x: hit.x, y: 0.15, z: hit.z }, { x: 0, y: 2.5 + 4 * I, z: 0 }, this._rate('wws' + key, 160 * I * bs), { mode: 1, spread: 1.2 + 2 * prox, speed: 10 * I + 2, life: 1.1 });
      this.emit('smoke', { x: hit.x, y: 0.6, z: hit.z }, { x: 0, y: 1, z: 0 }, this._rate('wwm' + key, 10 * I * bs), { mode: 1, spread: 2, speed: 7 * I, life: 1.6, size: 0.8, color: 0xe8f2ff });
    } else if (hit.cave) {
      const n = hit.n, p = { x: hit.x + n.x * 0.3, y: hit.y + n.y * 0.3, z: 0 };
      this.emit('dust', p, { x: n.x * 2, y: n.y * 2, z: 0 }, this._rate('wwc' + key, 70 * I * bs), { mode: 2, spread: 0.6, speed: 9 * I + 1, life: 1.6, size: 0.7, color: 0xb0a090 });
    } else {
      const n = hit.n;
      this.emit('dust', { x: hit.x + n.x * 0.4, y: hit.y + n.y * 0.4, z: hit.z + n.z * 0.4 }, { x: n.x * 1.5, y: n.y * 1.5, z: n.z * 1.5 }, this._rate('wwd' + key, 110 * I * bs), { mode: 1, spread: 1 + 2.5 * prox, speed: 13 * I + 2, life: 2.2 });
      this.emit('debris', { x: hit.x, y: hit.y + 0.3, z: hit.z }, { x: 0, y: 3, z: 0 }, this._rate('wwp' + key, 5 * I * bs), { mode: 1, spread: 1.5, speed: 8 * I, size: 0.5, life: 2 });
    }
  }

  exhaust(pos, dir, throttle = 1, inherit = null) {
    if (throttle <= 0.02) return;
    const l = Math.hypot(X(dir), Y(dir), Zc(dir)) || 1, s = 14 + 8 * throttle, ivx = X(inherit) * 0.5, ivy = Y(inherit) * 0.5, ivz = Zc(inherit) * 0.5;
    const v = { x: X(dir) / l * s + ivx, y: Y(dir) / l * s + ivy, z: Zc(dir) / l * s + ivz };
    this.emit('exhaust', pos, v, this._rate('exh', 300 * throttle * this.bscale), { speed: 2.5, spread: 0.15, life: 0.35 + 0.15 * throttle, size: 0.8 + 0.5 * throttle });
    this.emit('smoke', pos, { x: v.x * 0.35, y: v.y * 0.35, z: v.z * 0.35 }, this._rate('exs', 9 * throttle * this.bscale), { speed: 1, spread: 0.3, life: 1.8, size: 0.5 });
  }
  muzzle(pos, dir, inherit = null) {
    const l = Math.hypot(X(dir), Y(dir), Zc(dir)) || 1, d = { x: X(dir) / l, y: Y(dir) / l, z: Zc(dir) / l };
    const iv = { x: X(inherit), y: Y(inherit), z: Zc(inherit) };
    this.emit('spark', pos, { x: d.x * 28 + iv.x, y: d.y * 28 + iv.y, z: d.z * 28 + iv.z }, 6, { speed: 7, life: 0.18 });
    this.emit('exhaust', pos, { x: d.x * 6 + iv.x, y: d.y * 6 + iv.y, z: d.z * 6 + iv.z }, 3, { speed: 1.5, life: 0.09, size: 1.8, color: 0xffeecc });
    this.emit('smoke', pos, { x: d.x * 3 + iv.x * 0.6, y: d.y * 3 + iv.y * 0.6, z: d.z * 3 + iv.z * 0.6 }, 1, { speed: 0.6, life: 0.9, size: 0.35 });
  }
  // plasma bolt trail between two points (call per bullet per frame)
  trail(from, to, color = 0x66ffff, density = 2.5) {
    const sx = X(to) - X(from), sy = Y(to) - Y(from), sz = Zc(to) - Zc(from), L = Math.hypot(sx, sy, sz);
    const n = clamp(Math.ceil(L * density), 1, 16);
    this.emit('trail', from, { x: 0, y: 0, z: 0 }, n, { mode: 3, seg: { x: sx, y: sy, z: sz }, color });
  }
  // kind: 'auto' | 'spark' | 'metal' | 'dirt' | 'water'
  impact(pos, normal = null, kind = 'auto') {
    let p = { x: X(pos), y: Y(pos), z: Zc(pos) }, n = normal ? { x: X(normal), y: Y(normal), z: Zc(normal) } : null;
    const sf = this._surface(p);
    if (sf.cave) {
      const c = this.cave, gx = (p.x - c.ox) / c.cs, gy = (p.y - c.oy) / c.cs;
      if (!n) {   // normal from the open neighbours of the hit cell
        const o = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([a, b]) => !this._caveSolid(gx + a * 0.6, gy + b * 0.6));
        n = { x: 0, y: 0, z: 0 }; for (const [a, b] of o) { n.x += a; n.y += b; }
        if (!n.x && !n.y) n.y = 1;
      }
      const l = Math.hypot(n.x, n.y, n.z) || 1; n.x /= l; n.y /= l; n.z /= l;
      for (let i = 0; i < 6 && this._caveSolid((p.x - c.ox) / c.cs, (p.y - c.oy) / c.cs); i++) { p.x += n.x * 0.25 * c.cs; p.y += n.y * 0.25 * c.cs; }
    } else {
      if (!n) n = sf.n || { x: 0, y: 1, z: 0 };
      if (p.y < sf.gy + 0.15) p.y = sf.gy + 0.15;
    }
    if (kind === 'auto') kind = sf.water && p.y < 1.5 ? 'water' : 'spark';
    const v = s => ({ x: n.x * s, y: n.y * s, z: n.z * s }), bs = Math.min(this.bscale, 1.5);
    if (kind === 'water') {
      this.emit('spray', p, { x: 0, y: 7, z: 0 }, 28 * bs, { speed: 3.5, spread: 0.2 });
      this.splash(p.x, p.z, 1.2, 2.5);
      return;
    }
    this.emit('spark', p, v(8), (kind === 'metal' ? 22 : 12) * bs, { speed: 9, life: 0.5 });
    if (kind === 'metal') this.emit('ember', p, v(3), 6 * bs, { speed: 4, life: 1 });
    this.emit('dust', p, v(2), (kind === 'dirt' ? 12 : 4) * bs, { speed: 2, size: 0.6, life: 1.4, color: sf.cave ? 0x9a8a80 : null });
    this.emit('debris', p, v(5), (kind === 'dirt' ? 6 : 2) * bs, { speed: 4, size: 0.6, life: 2 });
    this.emit('smoke', p, v(1.5), 2, { speed: 0.6, size: 0.4, life: 1.2 });
  }
  explosion(pos, power = 1) {
    const p = { x: X(pos), y: Y(pos), z: Zc(pos) }, sf = this._surface(p);
    const s = this.cfg.explosionScale * this.bscale * Math.pow(power, 0.75), n = c => Math.max(1, Math.round(c * s));
    const sp = Math.sqrt(power), alt = p.y - sf.gy, cave = sf.cave;
    if (!cave && alt < 0.4) p.y = sf.gy + 0.4;
    const up = cave ? 0 : 3;
    this.emit('spark', p, { x: 0, y: up, z: 0 }, n(70), { speed: 26 * sp, life: 1.1 });
    this.emit('ember', p, { x: 0, y: up, z: 0 }, n(40), { speed: 11 * sp, life: 2.4 });
    this.emit('exhaust', p, { x: 0, y: 0, z: 0 }, n(14), { speed: 6 * sp, life: 0.35, size: 3 * sp, spread: 0.6 * sp });   // fireball flash
    this.emit('smoke', p, { x: 0, y: cave ? 0.5 : 1.5, z: 0 }, n(18), { speed: 3.5 * sp, spread: 1.2 * sp, size: 1.5 * Math.pow(power, 0.4), life: 4 });
    this.emit('debris', p, { x: 0, y: cave ? 2 : 5, z: 0 }, n(18), { speed: 13 * sp, life: 4.5 });
    const ground = !cave && alt < 5;
    this.emit('shock', ground ? { x: p.x, y: sf.gy + 0.5, z: p.z } : p, { x: 0, y: 0, z: 0 }, 1, { size: 9 * Math.pow(power, 0.6) * this.cfg.explosionScale, life: 0.55, orient: cave ? 2 : ground ? 1 : 0 });
    if (!cave && !sf.water && alt < 10) {
      const f = 1 - Math.max(alt, 0) / 10;
      this.emit('dust', { x: p.x, y: sf.gy + 0.4, z: p.z }, { x: 0, y: 1.5, z: 0 }, n(45 * f), { mode: 1, spread: 1.5 * sp, speed: 11 * sp * f + 2, life: 3 });
    }
    if (!cave && sf.water && alt < 8) {
      const f = 1 - Math.max(alt, 0) / 8;
      this.emit('spray', { x: p.x, y: 0.2, z: p.z }, { x: 0, y: 10 * sp * f, z: 0 }, n(110 * f), { speed: 6 * sp, spread: 0.8 * sp, life: 1.8 });
      this.emit('spray', { x: p.x, y: 0.2, z: p.z }, { x: 0, y: 3, z: 0 }, n(60 * f), { mode: 1, speed: 9 * sp, spread: 1.5 * sp, life: 1.2 });
      this.splash(p.x, p.z, 2.5 + 2 * sp, 9 * power * f);
    }
    this.blast(p, 6 + 8 * sp, 16 * sp);
    if (cave && this.cave) {
      const c = this.cave, g = this.worldToCave(p);
      if (this._fblast.length < NFBLAST) this._fblast.push({ x: g.x, y: g.y, r: (3 + 3 * sp) * 1.6 / c.cs, k: 8 * sp });
    }
  }
  // 2D liquid in the cave plane. pos2d / vel2d in CAVE CELL units (same space as T.x/T.y in main.js).
  caveLiquid(pos2d, vel2d, count = 50, colorKind = 0, o = {}) {
    if (!this._frt || this._freq.length >= MAXFREQ) return;
    const kind = typeof colorKind === 'string' ? (LIQUID[colorKind] ?? 0) : colorKind;
    this._freq.push({ x: X(pos2d), y: Y(pos2d), vx: X(vel2d), vy: Y(vel2d), count: Math.round(count), kind, spread: o.spread ?? 0.4, speed: o.speed ?? 1, life: o.life ?? 60 });
  }
  caveBlast(pos2d, radius = 4, strength = 10) { if (this._fblast.length < NFBLAST) this._fblast.push({ x: X(pos2d), y: Y(pos2d), r: radius, k: strength }); }
}

export function createGpuFx(renderer, scene, opts = {}) { return new GpuFx(renderer, scene, opts); }
export { GpuFx };
