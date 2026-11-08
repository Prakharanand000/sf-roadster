// Bay water: one big plane with a custom shader (procedural animated normals, fresnel sky reflection,
// sun glint, depth-based colour from the baked bathymetry, shoreline foam, fog). Lakes reuse it.
import * as THREE from 'three';

const VERT = /* glsl */ `
varying vec3 vWorld;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uSky;
uniform vec3 uHorizon;
uniform float uNight;
uniform sampler2D uDepth;
uniform vec4 uDepthRect;   // x0, z0, 1/width, 1/depth
uniform float uLake;
varying vec3 vWorld;
#include <fog_pars_fragment>

float wh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float wn(vec2 p){ vec2 i = floor(p), f = fract(p); vec2 u = f*f*(3.0-2.0*f);
  return mix(mix(wh(i), wh(i+vec2(1,0)), u.x), mix(wh(i+vec2(0,1)), wh(i+vec2(1,1)), u.x), u.y); }
vec2 wgrad(vec2 p){ float e = 0.05; return vec2(wn(p+vec2(e,0.0)) - wn(p-vec2(e,0.0)), wn(p+vec2(0.0,e)) - wn(p-vec2(0.0,e))) / (2.0*e); }

vec3 waveNormal(vec2 p, float t, float dist) {
  vec2 g = vec2(0.0);
  // directional swell (sum of sines) + two noise octaves
  vec2 d1 = normalize(vec2(0.8, 0.6)), d2 = normalize(vec2(-0.3, 1.0)), d3 = normalize(vec2(1.0, -0.4));
  g += d1 * cos(dot(p, d1) * 0.071 + t * 0.8 + wn(p * 0.004) * 6.0) * 0.022;
  g += d2 * cos(dot(p, d2) * 0.13 + t * 1.1 + wn(p * 0.006 + 3.0) * 6.0) * 0.018;
  g += d3 * cos(dot(p, d3) * 0.27 + t * 1.7) * 0.012;
  g += wgrad(p * 0.05 + vec2(t * 0.02, t * 0.013)) * 0.05;
  g += wgrad(p * 0.17 + vec2(t * 0.05, -t * 0.04)) * 0.04;
  g += wgrad(p * 0.6 - vec2(t * 0.13, -t * 0.09)) * 0.02;
  float fade = 1.0 - smoothstep(100.0, 1800.0, dist);
  g *= mix(0.15, 1.0, fade) * (uLake > 0.5 ? 0.35 : 1.0);
  return normalize(vec3(-g.x, 1.0, -g.y));
}

void main() {
  vec3 toCam = cameraPosition - vWorld;
  float dist = length(toCam);
  vec3 V = toCam / dist;
  vec3 N = waveNormal(vWorld.xz, uTime, dist);
  float NdV = max(dot(N, V), 0.0);
  float fres = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);
  vec3 R = reflect(-V, N);
  vec3 sky = mix(uHorizon, uSky, clamp(R.y * 1.6, 0.0, 1.0));
  // depth
  vec2 duv = (vWorld.xz - uDepthRect.xy) * uDepthRect.zw;
  float depth = 30.0;
  if (uLake < 0.5 && duv.x > 0.0 && duv.x < 1.0 && duv.y > 0.0 && duv.y < 1.0) depth = texture2D(uDepth, duv).r * 25.5;
  if (uLake > 0.5) depth = 2.5;
  vec3 deep = vec3(0.020, 0.085, 0.115), shallow = vec3(0.07, 0.24, 0.24);
  vec3 water = mix(shallow, deep, smoothstep(0.5, 16.0, depth));
  float sunUp = clamp(uSunDir.y * 3.0, 0.0, 1.0);
  float diff = max(dot(N, uSunDir), 0.0);
  vec3 body = water * (0.35 + 0.65 * diff * sunUp + 0.25) * (1.0 - uNight * 0.75);
  vec3 col = mix(body, sky, fres * 0.85);
  float sd = max(dot(R, uSunDir), 0.0);
  col += uSunColor * (pow(sd, 900.0) * 9.0 + pow(sd, 90.0) * 0.35) * sunUp;
  // shoreline foam
  float foamZone = 1.0 - smoothstep(0.0, 1.6, depth);
  float fn = wn(vWorld.xz * 0.35 + vec2(uTime * 0.25, 0.0)) * 0.6 + wn(vWorld.xz * 1.3 - uTime * 0.4) * 0.4;
  float foam = foamZone * smoothstep(0.45, 0.75, fn + foamZone * 0.3);
  col = mix(col, vec3(0.86, 0.9, 0.92) * (1.0 - uNight * 0.7), foam * 0.8 * (1.0 - uLake));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}`;

export function createWaterMaterial(depthTex, rect, lake = false) {
  const uniforms = THREE.UniformsUtils.merge([THREE.UniformsLib.fog, {
    uTime: { value: 0 }, uSunDir: { value: new THREE.Vector3(0.3, 0.8, 0.2).normalize() },
    uSunColor: { value: new THREE.Color(1.0, 0.92, 0.8) }, uSky: { value: new THREE.Color(0.38, 0.58, 0.85) },
    uHorizon: { value: new THREE.Color(0.75, 0.82, 0.88) }, uNight: { value: 0 },
    uDepth: { value: null }, uDepthRect: { value: new THREE.Vector4() }, uLake: { value: lake ? 1 : 0 },
  }]);
  uniforms.uDepth.value = depthTex;
  uniforms.uDepthRect.value.copy(rect);
  return new THREE.ShaderMaterial({ uniforms, vertexShader: VERT, fragmentShader: FRAG, fog: true });
}

/** `mergeLakes`: one mesh for all lakes (the v2 map has ~200; one draw call instead of one each). */
export function buildWater(D, Q, { quality = 'high', mergeLakes = false } = {}) {
  const g = D.grid;
  // depth texture (0.1 m units, 0..25.5 m)
  const N = g.nx * g.nz;
  const dd = new Uint8Array(N);
  for (let i = 0; i < N; i++) dd[i] = Math.max(0, Math.min(255, Math.round(-D.H[i] * 10)));
  const depthTex = new THREE.DataTexture(dd, g.nx, g.nz, THREE.RedFormat, THREE.UnsignedByteType);
  depthTex.magFilter = depthTex.minFilter = THREE.LinearFilter;
  depthTex.needsUpdate = true;
  const W = (g.nx - 1) * g.cell, Dz = (g.nz - 1) * g.cell;
  // DataTexture texel centres: sample i is at u=(i+0.5)/nx -> shift rect by half a cell
  const rect = new THREE.Vector4(g.x0 - g.cell * 0.5, g.z0 - g.cell * 0.5, 1 / (g.nx * g.cell), 1 / (g.nz * g.cell));
  const mat = createWaterMaterial(depthTex, rect, false);
  const group = new THREE.Group();
  group.name = 'water';
  const size = 60000;
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2), mat);
  plane.position.set(g.x0 + W / 2, 0, g.z0 + Dz / 2);
  plane.receiveShadow = false;
  plane.renderOrder = -1;
  group.add(plane);
  // lakes
  const lakeMat = createWaterMaterial(depthTex, rect, true);
  lakeMat.uniforms = Object.assign(lakeMat.uniforms, {
    uTime: mat.uniforms.uTime, uSunDir: mat.uniforms.uSunDir, uSunColor: mat.uniforms.uSunColor,
    uSky: mat.uniforms.uSky, uHorizon: mat.uniforms.uHorizon, uNight: mat.uniforms.uNight,
  });
  const lakeGeos = [];
  for (const l of Q.lakes) {
    if (l.ring.length < 3) continue;
    const shape = new THREE.Shape(l.ring.map(([x, z]) => new THREE.Vector2(x, -z)));
    const geo = new THREE.ShapeGeometry(shape);
    geo.rotateX(-Math.PI / 2);   // (x, y=-z) -> (x, 0, z)
    if (mergeLakes) { geo.translate(0, l.level, 0); lakeGeos.push(geo); continue; }
    const m = new THREE.Mesh(geo, lakeMat);
    m.position.y = l.level;
    group.add(m);
  }
  if (lakeGeos.length) {
    let nv = 0, ni = 0;
    for (const g of lakeGeos) { nv += g.attributes.position.count; ni += g.index.count; }
    const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), uv = new Float32Array(nv * 2), idx = new Uint32Array(ni);
    let vo = 0, io = 0;
    for (const g of lakeGeos) {
      pos.set(g.attributes.position.array, vo * 3); nor.set(g.attributes.normal.array, vo * 3); uv.set(g.attributes.uv.array, vo * 2);
      const gi = g.index.array;
      for (let i = 0; i < gi.length; i++) idx[io + i] = gi[i] + vo;
      vo += g.attributes.position.count; io += gi.length;
      g.dispose();
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.computeBoundingSphere();
    group.add(new THREE.Mesh(geo, lakeMat));
  }
  const tmpV = new THREE.Vector3();
  let sun = null, frameCount = 0;
  function update(dt, camera, env, parent) {
    mat.uniforms.uTime.value += dt;
    // loadWorld may receive a Group: look up the real scene root for fog / sun
    let scene = parent;
    while (scene && scene.parent) scene = scene.parent;
    plane.position.x = Math.round(camera.position.x / 1000) * 1000;
    plane.position.z = Math.round(camera.position.z / 1000) * 1000;
    if (!sun && scene && (frameCount++ % 60 === 0)) scene.traverse((o) => { if (!sun && o.isDirectionalLight) sun = o; });
    if (sun) {
      tmpV.copy(sun.position).sub(sun.target.position).normalize();
      mat.uniforms.uSunDir.value.copy(tmpV);
      mat.uniforms.uSunColor.value.copy(sun.color).multiplyScalar(Math.min(2.0, sun.intensity / 2.5));
    }
    if (scene && scene.fog) mat.uniforms.uHorizon.value.copy(scene.fog.color);
    else if (scene && scene.background && scene.background.isColor) mat.uniforms.uHorizon.value.copy(scene.background);
    const night = env && env.night != null ? env.night : mat.uniforms.uNight.value;
    mat.uniforms.uNight.value = night;
    const h = mat.uniforms.uHorizon.value;
    mat.uniforms.uSky.value.setRGB(h.r * 0.55, h.g * 0.72, Math.min(1, h.b * 1.05));
  }
  return { group, update, material: mat, lakeMaterial: lakeMat, depthTex };
}
