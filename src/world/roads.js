// Road ribbons draped on the terrain (asphalt + lane markings + crosswalks + cable-car rails in a shader),
// raised sidewalks with curbs on city streets, street-light poles and night glow sprites.
import * as THREE from 'three';

const CHUNK = 500;
const ROAD_Y = 0.1, WALK_Y = 0.24;
const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
const LIT = new Set(['trunk', 'primary', 'secondary', 'tertiary']);

export function createRoadMaterial(uniforms) {
  const mat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0.0 });
  mat.polygonOffset = true;
  mat.polygonOffsetFactor = -2;
  mat.polygonOffsetUnits = -4;
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uNight = uniforms.uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute vec2 ruv;\nattribute vec4 rinfo;\nattribute float rj;\nvarying vec2 vRuv;\nvarying vec4 vRinfo;\nvarying float vRj;\nvarying vec3 vWp;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvRuv = ruv; vRinfo = rinfo; vRj = rj; vWp = (modelMatrix * vec4(position, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
varying vec2 vRuv; varying vec4 vRinfo; varying float vRj; varying vec3 vWp;
uniform float uNight;
float rh(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
  return mix(mix(rh(i), rh(i+vec2(1,0)), f.x), mix(rh(i+vec2(0,1)), rh(i+vec2(1,1)), f.x), f.y); }
float band(float x, float c, float w, float aa){ return 1.0 - smoothstep(w*0.5 - aa, w*0.5 + aa, abs(x - c)); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float kind = vRinfo.w;
float markRough = 0.0;
float metalMark = 0.0;
vec3 rc;
float n1 = rn(vWp.xz * 0.9), n2 = rn(vWp.xz * 3.7), n3 = rn(vWp.xz * 0.06);
if (kind < 0.5) {
  rc = vec3(0.040, 0.041, 0.044) * (0.78 + 0.22 * n1 + 0.14 * n2 + 0.2 * n3);
  float lat = vRuv.x, along = vRuv.y, hw = vRinfo.x;
  float aa = max(fwidth(lat), 0.01);
  float info = vRinfo.y;            // centre type + 4 * lanes
  float ctype = mod(info, 4.0);
  float lanes = floor(info / 4.0);
  float fl = vRinfo.z;              // bit flags: 1 edge lines, 2 cable car, 4 crosswalks, 8 oneway
  float mW = 0.0; float mY = 0.0;
  float jd = vRj;
  if (jd > 4.0) {
    if (ctype > 0.5 && ctype < 1.5) {          // double yellow
      mY = max(band(lat, 0.17, 0.11, aa), band(lat, -0.17, 0.11, aa));
    } else if (ctype > 1.5 && ctype < 2.5) {   // dashed white centre
      mW = band(lat, 0.0, 0.12, aa) * step(fract(along / 9.0), 0.4);
    }
    if (lanes > 1.5) {
      bool oneway = mod(floor(fl / 8.0), 2.0) > 0.5;
      float per = oneway ? lanes : floor(lanes * 0.5);
      if (per > 1.5) {
        float lw = (oneway ? 2.0 * hw : hw) / per;
        float x0 = oneway ? lat + hw : abs(lat);
        float k = x0 / lw;
        float fk = fract(k);
        float dd = min(fk, 1.0 - fk) * lw;
        float inside = step(0.6, k) * step(k, per - 0.6);
        mW = max(mW, (1.0 - smoothstep(0.06 - aa, 0.06 + aa, dd)) * inside * step(fract(along / 12.0), 0.35));
      }
    }
    if (mod(fl, 2.0) > 0.5) mW = max(mW, band(abs(lat), hw - 0.45, 0.14, aa));
  }
  if (mod(floor(fl / 4.0), 2.0) > 0.5 && jd > 0.6 && jd < 3.6 && abs(lat) < hw - 0.3) {
    mW = max(mW, step(0.45, fract(lat / 1.1)));   // zebra crosswalk
  }
  vec3 markCol = vec3(0.70, 0.70, 0.66) * (0.85 + 0.15 * n2);
  vec3 yel = vec3(0.72, 0.42, 0.03);
  rc = mix(rc, markCol, mW * 0.92);
  rc = mix(rc, yel, mY * 0.92);
  markRough = max(mW, mY);
  if (mod(floor(fl / 2.0), 2.0) > 0.5) {       // cable car slot + rails, two tracks at +-1.75 m
    float t = abs(abs(lat) - 1.75);
    float rail = band(t, 0.53, 0.09, aa);
    float slot = band(t, 0.0, 0.05, aa);
    float bed = band(t, 0.0, 1.5, aa);
    rc = mix(rc, vec3(0.09, 0.085, 0.08) * (0.9 + 0.2 * n2), bed * 0.6);
    rc = mix(rc, vec3(0.40, 0.40, 0.42), rail);
    rc = mix(rc, vec3(0.03), slot);
    metalMark = rail;
  }
} else if (kind < 1.5) {
  // sidewalk: light concrete with expansion joints
  rc = vec3(0.30, 0.29, 0.27) * (0.86 + 0.12 * n1 + 0.08 * n2);
  float aa = max(fwidth(vRuv.y), 0.01);
  float j = fract(vRuv.y / 1.6);
  rc *= 1.0 - 0.25 * (1.0 - smoothstep(0.0, aa * 2.0, min(j, 1.0 - j) * 1.6));
} else {
  rc = vec3(0.42, 0.41, 0.39) * (0.9 + 0.1 * n2);
}
diffuseColor.rgb = rc;`)
      .replace('#include <roughnessmap_fragment>', '#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.6, markRough);\nroughnessFactor = mix(roughnessFactor, 0.3, metalMark);')
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor = mix(metalnessFactor, 0.8, metalMark);');
  };
  mat.customProgramCacheKey = () => 'sf-road-v1';
  return mat;
}

/** Junction lookup: quantised coordinate -> radius */
function junctionMap(J) {
  const m = new Map();
  for (let i = 0; i < J.r.length; i++) m.set(Math.round(J.xz[i * 2] * 4) + ',' + Math.round(J.xz[i * 2 + 1] * 4), J.r[i]);
  return m;
}

export function buildRoads(D, Q, { quality = 'high', uniforms } = {}) {
  const material = createRoadMaterial(uniforms);
  const jmap = junctionMap(D.junctions);
  const g = D.grid;
  const NCX = Math.ceil((g.nx * g.cell) / CHUNK);
  const chunkBufs = new Map();
  const lamps = [];
  const walks = quality !== 'low';
  const getBuf = (key) => {
    let b = chunkBufs.get(key);
    if (!b) chunkBufs.set(key, (b = { pos: [], nor: [], ruv: [], rinfo: [], rj: [], idx: [], n: 0 }));
    return b;
  };
  const tmpN = new THREE.Vector3();

  for (let ri = 0; ri < D.roads.length; ri++) {
    const r = D.roads[ri];
    if (quality === 'low' && r.type === 'service') continue;
    const P = r.points;
    if (P.length < 2) continue;
    const hw = r.width * 0.5;
    const isBridge = r.bridge;
    // densify to <= 4 m, record along distance and junction markers
    const xs = [], zs = [], ss = [];
    const jpos = [];  // [s, radius]
    let s = 0;
    for (let i = 0; i < P.length; i++) {
      const [x, z] = P[i];
      if (i > 0) {
        const [px, pz] = P[i - 1];
        const L = Math.hypot(x - px, z - pz);
        const k = Math.max(1, Math.ceil(L / 4));
        for (let t = 1; t < k; t++) { xs.push(px + ((x - px) * t) / k); zs.push(pz + ((z - pz) * t) / k); ss.push(s + (L * t) / k); }
        s += L;
      }
      xs.push(x); zs.push(z); ss.push(s);
      const jr = jmap.get(Math.round(x * 4) + ',' + Math.round(z * 4));
      if (jr !== undefined) jpos.push([s, jr]);
    }
    const n = xs.length;
    // per point: heights (left/right edges), lateral normal, junction distance
    const lx = new Float32Array(n), lz = new Float32Array(n), jd = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1), b = Math.min(n - 1, i + 1);
      let tx = xs[b] - xs[a], tz = zs[b] - zs[a];
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      let nx = -tz, nz = tx;
      // miter correction on bends (limited)
      if (i > 0 && i < n - 1) {
        let ux = xs[i] - xs[i - 1], uz = zs[i] - zs[i - 1];
        const ul = Math.hypot(ux, uz) || 1; ux /= ul; uz /= ul;
        const dot = -uz * nx + ux * nz;
        const m = Math.min(1.8, 1 / Math.max(0.55, dot));
        nx *= m; nz *= m;
      }
      lx[i] = nx; lz[i] = nz;
      let d = 1e9;
      for (const [js, jr] of jpos) d = Math.min(d, Math.abs(ss[i] - js) - jr);
      jd[i] = d;
    }
    // heights
    const hgt = isBridge ? (x, z) => Q.groundHeight(x, z) : (x, z) => Q.heightAt(x, z);
    const hl = new Float32Array(n), hr = new Float32Array(n), hc = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      hl[i] = hgt(xs[i] + lx[i] * hw, zs[i] + lz[i] * hw);
      hr[i] = hgt(xs[i] - lx[i] * hw, zs[i] - lz[i] * hw);
      hc[i] = hgt(xs[i], zs[i]);
      if (isBridge) { const m = Math.max(hl[i], hr[i], hc[i]); hl[i] = hr[i] = m; }
    }
    // adaptive simplification: keep a point when linear interpolation would deviate > 6 cm
    const keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    let a = 0;
    while (a < n - 1) {
      let b = a + 1;
      while (b + 1 < n && ss[b + 1] - ss[a] < 24) {
        const c = b + 1;
        let ok = true;
        for (let m = a + 1; m < c && ok; m++) {
          const t = (ss[m] - ss[a]) / (ss[c] - ss[a]);
          if (Math.abs(hl[a] + (hl[c] - hl[a]) * t - hl[m]) > 0.06 || Math.abs(hr[a] + (hr[c] - hr[a]) * t - hr[m]) > 0.06 ||
              Math.abs(hc[a] + (hc[c] - hc[a]) * t - hc[m]) > 0.06) ok = false;
          // keep geometry bends
          const ex = xs[a] + (xs[c] - xs[a]) * t, ez = zs[a] + (zs[c] - zs[a]) * t;
          if (Math.hypot(ex - xs[m], ez - zs[m]) > 0.15) ok = false;
          // keep junction-zone transitions for markings / sidewalks
          if ((jd[m] > 0) !== (jd[a] > 0) || (jd[m] > 4) !== (jd[a] > 4)) ok = false;
        }
        if (!ok) break;
        b = c;
      }
      keep[b] = 1;
      a = b;
    }
    const ids = [];
    for (let i = 0; i < n; i++) if (keep[i]) ids.push(i);
    // marking info
    const t = r.type;
    let ctype = 0;
    if (!r.oneway && (MAJOR.has(t) || r.lanes >= 2) && t !== 'service' && !t.endsWith('_link')) ctype = 1;
    if (!r.oneway && ctype === 0 && t === 'unclassified') ctype = 2;
    const lanes = r.lanes || (r.oneway ? Math.max(1, Math.round(r.width / 3.6)) : MAJOR.has(t) ? Math.max(2, Math.round(r.width / 3.5) & ~1) : 0);
    let fl = 0;
    if (t.startsWith('motorway') || t === 'trunk' || r.bridge) fl |= 1;
    if (r.cableCar) fl |= 2;
    if (MAJOR.has(t) || t === 'residential') fl |= 4;
    if (r.oneway) fl |= 8;
    const info = ctype + 4 * Math.min(lanes, 8);
    const sidewalk = walks && r.sidewalk && !r.bridge;

    // emit per chunk (split by chunk of segment midpoint)
    let cur = null, curKey = -1;
    let prevL = -1;  // vertex index of previous road pair in current buffer
    let prevW = null;
    for (let q = 0; q < ids.length; q++) {
      const i = ids[q];
      const ci = Math.floor((xs[i] - g.x0) / CHUNK), cj = Math.floor((zs[i] - g.z0) / CHUNK);
      const key = cj * NCX + ci;
      if (key !== curKey) {
        // start new strip in this chunk, but connect with previous point (duplicate it)
        const nb = getBuf(key);
        if (cur && q > 0) {
          // duplicate previous point into new buffer for continuity
          const pi = ids[q - 1];
          prevL = emitRoadPair(nb, pi);
          prevW = sidewalk ? emitWalkSet(nb, pi) : null;
        } else { prevL = -1; prevW = null; }
        cur = nb; curKey = key;
      }
      const v = emitRoadPair(cur, i);
      if (prevL >= 0) pushQuad(cur, prevL, prevL + 1, v, v + 1);
      prevL = v;
      if (sidewalk) {
        const w = emitWalkSet(cur, i);
        if (prevW && jd[i] > 0.0 && jd[ids[q - 1]] > 0.0) {
          for (const side of [0, 1]) {
            const p = prevW + side * 4, c = w + side * 4;
            // curb face (p0 bottom, p1 top), walk (p2 inner, p3 outer)
            if (side === 0) { pushQuad(cur, p, p + 1, c, c + 1); pushQuad(cur, p + 2, p + 3, c + 2, c + 3); }
            else { pushQuad(cur, p + 1, p, c + 1, c); pushQuad(cur, p + 3, p + 2, c + 3, c + 2); }
          }
        }
        prevW = w;
      }
    }
    // street lights along lit roads
    if (LIT.has(t) && !r.bridge) {
      const spacing = r.bridge ? 50 : 34;
      let next = spacing * 0.5, side = 1;
      for (let i = 0; i < n; i++) {
        if (ss[i] < next) continue;
        next += spacing;
        if (!r.bridge && jd[i] < 6) continue;
        const sd = r.bridge ? 1 : side;
        side = -side;
        const off = hw + (r.bridge ? 0.2 : sidewalk ? 1.2 : 0.8);
        for (const s2 of r.bridge ? [1, -1] : [sd]) {
          const px = xs[i] + lx[i] * off * s2, pz = zs[i] + lz[i] * off * s2;
          const base = hgt(px, pz);
          lamps.push(px, base, pz, -lx[i] * s2, -lz[i] * s2);
        }
      }
    }

    function emitRoadPair(buf, i) {
      const v = buf.n;
      Q.normalAt(xs[i], zs[i], isBridge ? 1e4 : -1e3, tmpN);
      if (!isBridge) Q.normalAt(xs[i], zs[i], hc[i] + 0.5, tmpN);
      for (const sgn of [1, -1]) {
        const x = xs[i] + lx[i] * hw * sgn, z = zs[i] + lz[i] * hw * sgn;
        buf.pos.push(x, (sgn > 0 ? hl[i] : hr[i]) + ROAD_Y, z);
        buf.nor.push(tmpN.x, tmpN.y, tmpN.z);
        buf.ruv.push(hw * sgn, ss[i]);
        buf.rinfo.push(hw, info, fl, 0);
        buf.rj.push(jd[i]);
      }
      buf.n += 2;
      return v;
    }
    function emitWalkSet(buf, i) {
      const v = buf.n;
      const ww = 3.0;
      for (const sgn of [1, -1]) {
        const ex = xs[i] + lx[i] * hw * sgn, ez = zs[i] + lz[i] * hw * sgn;
        const ox = xs[i] + lx[i] * (hw + ww) * sgn, oz = zs[i] + lz[i] * (hw + ww) * sgn;
        const he = sgn > 0 ? hl[i] : hr[i];
        const ho = Math.max(he, hgt(ox, oz));
        // curb bottom, curb top (normal facing road), walk inner, walk outer (normal up)
        const cnx = -lx[i] * sgn, cnz = -lz[i] * sgn;
        buf.pos.push(ex, he + ROAD_Y - 0.02, ez, ex, he + WALK_Y, ez, ex, he + WALK_Y, ez, ox, ho + WALK_Y, oz);
        buf.nor.push(cnx, 0, cnz, cnx, 0, cnz, 0, 1, 0, 0, 1, 0);
        buf.ruv.push(0, ss[i], 0, ss[i], hw, ss[i], hw + ww, ss[i]);
        buf.rinfo.push(hw, 0, 0, 2, hw, 0, 0, 2, hw, 0, 0, 1, hw, 0, 0, 1);
        buf.rj.push(jd[i], jd[i], jd[i], jd[i]);
      }
      buf.n += 8;
      return v;
    }
  }

  // Golden Gate deck lamps along the outer edges (every 50 m)
  if (Q.deck) {
    const P = Q.deck, lr = [0, 0];
    for (let t = P.tmin + 25; t < P.tmax - 25; t += 50) {
      P.lateralRange(t, lr);
      const h = P.heightAtT(t);
      for (const [l, dir] of [[lr[0] + 0.4, 1], [lr[1] - 0.4, -1]]) {
        const x = P.cx + P.ax * t - P.az * l, z = P.cz + P.az * t + P.ax * l;
        lamps.push(x, h, z, -P.az * dir, P.ax * dir);
      }
    }
  }
  const group = new THREE.Group();
  group.name = 'roads';
  const chunks = [];
  let tris = 0;
  for (const [key, b] of chunkBufs) {
    if (!b.idx.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
    const nor = new Int8Array(b.nor.length);
    for (let i = 0; i < nor.length; i++) nor[i] = Math.round(Math.max(-1, Math.min(1, b.nor[i])) * 127);
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
    geo.setAttribute('ruv', new THREE.Float32BufferAttribute(b.ruv, 2));
    geo.setAttribute('rinfo', new THREE.Float32BufferAttribute(b.rinfo, 4));
    geo.setAttribute('rj', new THREE.Float32BufferAttribute(b.rj, 1));
    geo.setIndex(b.n > 65535 ? new THREE.Uint32BufferAttribute(b.idx, 1) : new THREE.Uint16BufferAttribute(b.idx, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = 1;
    group.add(mesh);
    chunks.push({ mesh, cx: geo.boundingSphere.center.x, cz: geo.boundingSphere.center.z, r: geo.boundingSphere.radius });
    tris += b.idx.length / 3;
  }

  // ---- street lights: poles (merged per chunk) + glow points
  const lights = buildStreetLights(lamps, quality, uniforms);
  group.add(lights.group);

  const dist = quality === 'high' ? 2600 : quality === 'medium' ? 1700 : 1100;
  function update(camera) {
    const px = camera.position.x, pz = camera.position.z;
    for (const c of chunks) c.mesh.visible = Math.hypot(c.cx - px, c.cz - pz) - c.r < dist;
    lights.update(camera);
  }
  return { group, update, material, stats: { triangles: tris + lights.triangles, meshes: chunks.length, lamps: lamps.length / 5 } };
}

function pushQuad(b, a0, a1, b0, b1) {
  // a0,a1 = left/right at previous point; b0,b1 at current. Orientation: up-facing.
  b.idx.push(a0, b0, a1, a1, b0, b1);
}

function buildStreetLights(lamps, quality, uniforms) {
  const group = new THREE.Group();
  group.name = 'streetlights';
  const n = lamps.length / 5;
  const H = 8.5;
  // glow points
  const gpos = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const x = lamps[i * 5], y = lamps[i * 5 + 1], z = lamps[i * 5 + 2], dx = lamps[i * 5 + 3], dz = lamps[i * 5 + 4];
    const dl = Math.hypot(dx, dz) || 1;
    gpos[i * 3] = x + (dx / dl) * 1.6; gpos[i * 3 + 1] = y + H - 0.3; gpos[i * 3 + 2] = z + (dz / dl) * 1.6;
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(gpos, 3));
  const pmat = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uNight: { value: 0 }, uScale: { value: 900 } }]),
    vertexShader: `uniform float uScale; uniform float uNight;
      #include <fog_pars_vertex>
      void main(){ vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition;
        gl_PointSize = clamp(uScale * 7.0 / -mvPosition.z, 1.5, 90.0);
        #include <fog_vertex>
      }`,
    fragmentShader: `uniform float uNight;
      #include <fog_pars_fragment>
      void main(){ vec2 d = gl_PointCoord - 0.5; float r = length(d) * 2.0; float a = exp(-r * r * 5.0) * (1.0 - smoothstep(0.85, 1.0, r));
        float core = exp(-r * r * 40.0);
        gl_FragColor = vec4(vec3(1.0, 0.78, 0.48) * (a * 0.9 + core * 1.5) * uNight, 1.0);
        #include <fog_fragment>
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  });
  pmat.uniforms.uNight = uniforms.uNight;
  const points = new THREE.Points(pg, pmat);
  points.frustumCulled = false;
  points.renderOrder = 5;
  group.add(points);

  let tris = 0;
  const poleChunks = [];
  if (quality !== 'low') {
    // pole geometry: vertical box + arm + head, merged per 500 m chunk
    const buckets = new Map();
    for (let i = 0; i < n; i++) {
      const key = Math.floor(lamps[i * 5] / CHUNK) * 1000 + Math.floor(lamps[i * 5 + 2] / CHUNK);
      let b = buckets.get(key);
      if (!b) buckets.set(key, (b = []));
      b.push(i);
    }
    const pmat2 = new THREE.MeshStandardMaterial({ color: 0x55595e, roughness: 0.6, metalness: 0.6 });
    const headMat = new THREE.MeshStandardMaterial({ color: 0x777b80, roughness: 0.5, metalness: 0.4, emissive: new THREE.Color(1.0, 0.8, 0.5), emissiveIntensity: 0 });
    uniforms.lampMaterials.push(headMat);
    const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
    for (const [, list] of buckets) {
      const poleParts = [], headParts = [];
      const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), p = new THREE.Vector3();
      for (const i of list) {
        const x = lamps[i * 5], y = lamps[i * 5 + 1], z = lamps[i * 5 + 2], dx = lamps[i * 5 + 3], dz = lamps[i * 5 + 4];
        const ang = Math.atan2(dx, dz);
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), ang);
        const pole = box(0.22, H, 0.22); m4.compose(p.set(x, y + H / 2 - 0.3, z), q, sc); pole.applyMatrix4(m4); poleParts.push(pole);
        const arm = box(0.12, 0.12, 1.8); m4.compose(p.set(x + Math.sin(ang) * 0.9, y + H - 0.25, z + Math.cos(ang) * 0.9), q, sc); arm.applyMatrix4(m4); poleParts.push(arm);
        const head = box(0.45, 0.18, 0.8); m4.compose(p.set(x + Math.sin(ang) * 1.6, y + H - 0.32, z + Math.cos(ang) * 1.6), q, sc); head.applyMatrix4(m4); headParts.push(head);
      }
      const pg2 = mergeSimple(poleParts), hg = mergeSimple(headParts);
      const m1 = new THREE.Mesh(pg2, pmat2), m2 = new THREE.Mesh(hg, headMat);
      m1.castShadow = true;
      m1.matrixAutoUpdate = m2.matrixAutoUpdate = false;
      group.add(m1, m2);
      pg2.computeBoundingSphere();
      poleChunks.push({ meshes: [m1, m2], cx: pg2.boundingSphere.center.x, cz: pg2.boundingSphere.center.z, r: pg2.boundingSphere.radius });
      tris += (pg2.index.count + hg.index.count) / 3;
    }
  }
  const dist = quality === 'high' ? 900 : 600;
  function update(camera) {
    const px = camera.position.x, pz = camera.position.z;
    for (const c of poleChunks) {
      const vis = Math.hypot(c.cx - px, c.cz - pz) - c.r < dist;
      c.meshes[0].visible = c.meshes[1].visible = vis;
    }
    points.visible = uniforms.uNight.value > 0.03;
  }
  return { group, update, triangles: tris };
}

/** merge non-indexed/indexed BufferGeometries with position+normal only */
export function mergeSimple(geos) {
  let nv = 0, ni = 0;
  for (const g of geos) { nv += g.attributes.position.count; ni += g.index ? g.index.count : g.attributes.position.count; }
  const pos = new Float32Array(nv * 3), nor = new Float32Array(nv * 3), idx = new Uint32Array(ni);
  let vo = 0, io = 0;
  for (const g of geos) {
    pos.set(g.attributes.position.array, vo * 3);
    nor.set(g.attributes.normal.array, vo * 3);
    if (g.index) for (let i = 0; i < g.index.count; i++) idx[io++] = g.index.array[i] + vo;
    else for (let i = 0; i < g.attributes.position.count; i++) idx[io++] = i + vo;
    vo += g.attributes.position.count;
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setIndex(new THREE.BufferAttribute(idx, 1));
  return out;
}
