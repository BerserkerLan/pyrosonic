import * as THREE from 'three';
import { STRIDE, GRAVITY } from '../show/shells.js';

/**
 * Stateless GPU particle system.
 *
 * Every particle is a row of 24 floats in a ring buffer; the vertex shaders
 * evaluate its analytic trajectory at `uTime`, so the CPU never touches a
 * particle after spawning it. Each system draws:
 *  - ribbons: a camera-facing strip sampled back along the trajectory
 *    (curved, tapered trails — willows droop, palms arc), and
 *  - heads:   a camera-facing quad per star with a tight, hot core.
 *
 * Both are ordinary instanced triangle draws. The water reflection is a
 * separate render of the same objects from a mirrored camera (see engine.js),
 * so nothing here needs to know about it — except `uViewport`, which the
 * engine points at whichever target is being drawn so line widths stay in pixels.
 */

const COMMON = /* glsl */ `
uniform float uTime;
uniform float uBrightness;
uniform float uStrobeOn;
uniform float uSizeScale;
uniform vec2 uViewport;

attribute vec4 aOB;  // origin.xyz, birth
attribute vec4 aVL;  // velocity.xyz, life
attribute vec4 aC;   // colour.rgb, intensity
attribute vec4 aC2;  // end colour.rgb, shift (fraction of life, <0 = none)
attribute vec4 aPh;  // drag, gravity scale, size, trail seconds
attribute vec4 aFx;  // flicker, strobe Hz, seed, flags

const float GRAVITY = ${GRAVITY.toFixed(4)};

vec3 posAt(float t) {
  float k = max(aPh.x, 0.05);
  float g = -GRAVITY * aPh.y;
  float e = exp(-k * t);
  float gk = g / k;
  float f = (1.0 - e) / k;
  return vec3(aOB.x + aVL.x * f, aOB.y + gk * t + (aVL.y - gk) * f, aOB.z + aVL.z * f);
}

vec3 velAt(float t) {
  float k = max(aPh.x, 0.05);
  float g = -GRAVITY * aPh.y;
  float e = exp(-k * t);
  float gk = g / k;
  return vec3(aVL.x * e, gk + (aVL.y - gk) * e, aVL.z * e);
}

float hash11(float p) {
  p = fract(p * 0.1031);
  p *= p + 33.33;
  p *= p + p;
  return fract(p);
}

float lifeEnvelope(float age, float life, int flags) {
  float lt = clamp(age / life, 0.0, 1.0);
  if ((flags & 4) != 0) {
    float k = 1.0 - lt;
    return k * k;
  }
  float fin = smoothstep(0.0, 0.035, age);
  float fout = ((flags & 32) != 0) ? 1.0 : 1.0 - smoothstep(0.62, 1.0, lt);
  return fin * fout;
}

vec3 colourAt(float lt) {
  vec3 col = aC.rgb;
  if (aC2.w >= 0.0) col = mix(col, aC2.rgb, smoothstep(aC2.w, min(1.0, aC2.w + 0.25), lt));
  return col;
}

void cull() {
  gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
}
`;

const RIBBON_VERT = /* glsl */ `
${COMMON}
varying vec3 vColor;
varying float vSide;
varying float vAlong;
varying float vSeed;
varying float vGlitter;

void main() {
  vColor = vec3(0.0);
  vSide = 0.0;
  vAlong = 0.0;
  vSeed = 0.0;
  vGlitter = 0.0;
  float age = uTime - aOB.w;
  float life = aVL.w;
  int flags = int(aFx.w + 0.5);
  float trail = aPh.w;
  if (age < 0.0 || age > life || trail <= 0.0 || (flags & 8) != 0) {
    cull();
    return;
  }
  float seg = position.x;
  float side = position.y;
  float ta = age - seg * trail;
  float valid = step(0.0, ta);
  ta = max(ta, 0.0);
  vec3 p = posAt(ta);
  vec3 v = velAt(ta);
  vec4 c0 = projectionMatrix * viewMatrix * vec4(p, 1.0);
  vec4 c1 = projectionMatrix * viewMatrix * vec4(p - v * 0.02, 1.0);
  if (c0.w <= 0.1 || c1.w <= 0.1) {
    cull();
    return;
  }
  vec2 d = (c1.xy / c1.w - c0.xy / c0.w) * uViewport;
  float dl = length(d);
  d = dl > 1e-4 ? d / dl : vec2(0.0, 1.0);
  vec2 nrm = vec2(-d.y, d.x);
  float pxPerUnit = projectionMatrix[1][1] * 0.5 * uViewport.y / c0.w;
  // Thin, tapered streaks; never thinner than ~1.5 px so they stay anti-aliased.
  float widthPx = aPh.z * uSizeScale * mix(0.3, 0.05, seg) * pxPerUnit;
  float widthC = max(widthPx, 0.75);
  float energy = widthPx / widthC;
  gl_Position = c0;
  gl_Position.xy += nrm * side * widthC * 2.0 / uViewport * c0.w;

  float lt = ta / life;
  float b = lifeEnvelope(age, life, flags);
  float fade = pow(1.0 - seg, 1.5) * valid;
  vec3 col = colourAt(lt);
  // Older parts of a trail cool towards orange, like burning embers.
  col = mix(col, col * vec3(1.0, 0.6, 0.32), seg * 0.6);
  vColor = col * aC.w * b * fade * energy * uBrightness * 0.78;
  vSide = side;
  vAlong = seg;
  vSeed = aFx.z;
  vGlitter = float((flags & 1) != 0);
}
`;

const RIBBON_FRAG = /* glsl */ `
uniform float uTime;
varying vec3 vColor;
varying float vSide;
varying float vAlong;
varying float vSeed;
varying float vGlitter;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

void main() {
  // Crisp cross-section: a solid core with a narrow anti-aliased edge.
  float a = 1.0 - smoothstep(0.3, 1.0, abs(vSide));
  float sparkle = 1.0;
  if (vGlitter > 0.5) {
    float cell = floor(vAlong * 36.0);
    float n = hash12(vec2(cell + vSeed * 97.0, floor(uTime * 24.0)));
    sparkle = 0.25 + 1.9 * smoothstep(0.5, 0.95, n);
  }
  gl_FragColor = vec4(vColor * a * sparkle, 1.0);
}
`;

// Stars are drawn as quads, sized in pixels from their true projected size.
// A star's light sits in a tight core (σ ≈ 0.3 of its radius) with only a
// faint skirt of glow — bloom adds the rest — which keeps bursts crisp.
const STAR_REACH = 1.6; // quad half-size, in units of the star's radius
const FLASH_REACH = 1.1;

const HEAD_VERT = /* glsl */ `
${COMMON}
varying vec3 vColor;
varying vec2 vQ;
varying float vHot;
varying float vFlash;

void main() {
  vColor = vec3(0.0);
  vQ = vec2(0.0);
  vHot = 0.0;
  vFlash = 0.0;
  float age = uTime - aOB.w;
  float life = aVL.w;
  int flags = int(aFx.w + 0.5);
  if (age < 0.0 || age > life || (flags & 2) != 0) {
    cull();
    return;
  }
  vec3 p = posAt(age);
  vec4 mv = viewMatrix * vec4(p, 1.0);
  if (-mv.z < 0.5) {
    cull();
    return;
  }
  vec4 c = projectionMatrix * mv;
  float lt = age / life;
  bool flash = (flags & 4) != 0;
  float size = aPh.z * uSizeScale;
  size *= flash ? (0.55 + 0.9 * sqrt(lt)) : mix(0.9, 0.55, lt);
  float px = size * projectionMatrix[1][1] * 0.5 * uViewport.y / -mv.z;
  // Below ~1.4 px a star is drawn at 1.4 px with its energy scaled down, so
  // distant stars dim smoothly instead of shimmering.
  float pxC = max(px, flash ? 2.0 : 1.4);
  float energy = (px / pxC) * (px / pxC);
  float reach = flash ? ${FLASH_REACH.toFixed(2)} : ${STAR_REACH.toFixed(2)};
  vec2 corner = position.xy;
  gl_Position = c;
  gl_Position.xy += corner * (pxC * reach) * 2.0 / uViewport * c.w;
  vQ = corner * reach;

  float b = lifeEnvelope(age, life, flags);
  float seed = aFx.z;
  if (aFx.x > 0.0) {
    float n = hash11(floor(uTime * 27.0) + seed * 811.0);
    b *= mix(1.0, 0.25 + 1.3 * n, aFx.x);
  }
  if (aFx.y > 0.0 && uStrobeOn > 0.5) b *= step(0.45, fract(age * aFx.y + seed));
  vColor = colourAt(lt) * aC.w * b * energy * uBrightness;
  vHot = (flags & 16) != 0 ? 1.2 : (1.0 - smoothstep(0.0, 0.14, age)) * 0.9 + 0.15;
  vFlash = flash ? 1.0 : 0.0;
}
`;

const HEAD_FRAG = /* glsl */ `
varying vec3 vColor;
varying vec2 vQ;
varying float vHot;
varying float vFlash;

void main() {
  float r2 = dot(vQ, vQ);
  vec3 col;
  if (vFlash > 0.5) {
    // Burst flash: a small white-hot fireball whose glare fades smoothly
    // to nothing (no visible rim, even when it saturates).
    float n2 = r2 / ${(FLASH_REACH * FLASH_REACH).toFixed(4)};
    if (n2 > 1.0) discard;
    float core = exp(-n2 * 14.0);
    float e = 1.0 - n2;
    float glare = exp(-n2 * 4.0) * e * e * 0.38;
    col = vColor * (core * 1.6 + glare);
    col += vec3(dot(vColor, vec3(0.3333))) * core * 0.8;
  } else {
    float lim = ${(STAR_REACH * STAR_REACH).toFixed(4)};
    if (r2 > lim) discard;
    float core = exp(-r2 * 5.5);
    float skirt = exp(-r2 * 1.7) * 0.07;
    float window = 1.0 - smoothstep(lim * 0.55, lim, r2);
    col = vColor * (core * 1.35 + skirt) * window;
    // White-hot centre, strongest the moment a star ignites.
    col += vec3(dot(vColor, vec3(0.3333))) * core * core * vHot * 1.2;
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

const ATTRS = [
  ['aOB', 0],
  ['aVL', 4],
  ['aC', 8],
  ['aC2', 12],
  ['aPh', 16],
  ['aFx', 20],
];

export class ParticleSystem {
  /**
   * @param {object} o
   * @param {number} o.capacity  max live particles (ring buffer)
   * @param {number} o.segments  ribbon segments per particle trail
   * @param {object} o.uniforms  shared uniform objects
   * @param {number} o.renderOrder base render order
   */
  constructor({ capacity, segments, uniforms, renderOrder = 10 }) {
    this.capacity = capacity;
    this.segments = segments;
    this.data = new Float32Array(capacity * STRIDE);
    this.killAll(false);
    this.buffer = new THREE.InstancedInterleavedBuffer(this.data, STRIDE, 1);
    this.buffer.setUsage(THREE.DynamicDrawUsage);
    this.head = 0;
    this.used = 0;

    // Ribbon strip: (segments + 1) × 2 vertices, position = (seg, side, 0).
    const ribbon = new THREE.InstancedBufferGeometry();
    const verts = new Float32Array((segments + 1) * 2 * 3);
    const index = [];
    for (let s = 0; s <= segments; s++) {
      const u = s / segments;
      verts.set([u, -1, 0], s * 6);
      verts.set([u, 1, 0], s * 6 + 3);
      if (s < segments) {
        const a = s * 2, b = a + 1, c = a + 2, d = a + 3;
        index.push(a, c, b, b, c, d);
      }
    }
    ribbon.setAttribute('position', new THREE.BufferAttribute(verts, 3));
    ribbon.setIndex(index);

    // Star quad: corners at (±1, ±1).
    const head = new THREE.InstancedBufferGeometry();
    head.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    head.setIndex([0, 1, 2, 0, 2, 3]);

    for (const geo of [ribbon, head]) {
      for (const [name, offset] of ATTRS) geo.setAttribute(name, new THREE.InterleavedBufferAttribute(this.buffer, 4, offset));
      geo.instanceCount = 0;
      geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
      geo.boundingBox = new THREE.Box3(new THREE.Vector3(-1e6, -1e6, -1e6), new THREE.Vector3(1e6, 1e6, 1e6));
    }
    this.ribbonGeo = ribbon;
    this.headGeo = head;

    const make = (vertexShader, fragmentShader) =>
      new THREE.ShaderMaterial({
        vertexShader,
        fragmentShader,
        uniforms,
        transparent: true,
        depthWrite: false,
        depthTest: true,
        side: THREE.DoubleSide,
        blending: THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc: THREE.OneFactor,
        blendDst: THREE.OneFactor,
      });

    const rib = new THREE.Mesh(ribbon, make(RIBBON_VERT, RIBBON_FRAG));
    const stars = new THREE.Mesh(head, make(HEAD_VERT, HEAD_FRAG));
    for (const o of [rib, stars]) {
      o.frustumCulled = false;
      o.matrixAutoUpdate = false;
    }
    rib.renderOrder = renderOrder;
    stars.renderOrder = renderOrder + 1;
    this.objects = [rib, stars];
  }

  /** Append particles (Float32Array of n × STRIDE). Oldest entries are overwritten on wrap. */
  spawn(src, count) {
    if (!count) return;
    if (count > this.capacity) {
      src = src.subarray((count - this.capacity) * STRIDE, count * STRIDE);
      count = this.capacity;
    }
    const start = this.head;
    const first = Math.min(count, this.capacity - start);
    this.data.set(src.subarray(0, first * STRIDE), start * STRIDE);
    this.buffer.addUpdateRange(start * STRIDE, first * STRIDE);
    if (count > first) {
      const rest = count - first;
      this.data.set(src.subarray(first * STRIDE, count * STRIDE), 0);
      this.buffer.addUpdateRange(0, rest * STRIDE);
    }
    this.head = (start + count) % this.capacity;
    this.used = Math.min(this.capacity, Math.max(this.used, start + count));
    if (start + count > this.capacity) this.used = this.capacity;
    this.ribbonGeo.instanceCount = this.used;
    this.headGeo.instanceCount = this.used;
    this.buffer.needsUpdate = true;
  }

  killAll(upload = true) {
    const d = this.data;
    for (let i = 0; i < this.capacity; i++) {
      d[i * STRIDE + 3] = -1e6; // birth far in the past
      d[i * STRIDE + 7] = 0; // zero life
    }
    if (upload && this.buffer) {
      this.buffer.clearUpdateRanges();
      this.buffer.addUpdateRange(0, this.capacity * STRIDE);
      this.buffer.needsUpdate = true;
      this.head = 0;
      this.used = 0;
      this.ribbonGeo.instanceCount = 0;
      this.headGeo.instanceCount = 0;
    }
  }

  dispose() {
    this.ribbonGeo.dispose();
    this.headGeo.dispose();
    for (const o of this.objects) o.material.dispose();
  }
}
