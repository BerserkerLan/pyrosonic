import * as THREE from 'three';

export const MAX_FLASHES = 8;

/** Shared GLSL for reading the burst-light uniforms. */
export const FLASH_GLSL = /* glsl */ `
uniform vec3 uFlashPos[${MAX_FLASHES}];
uniform vec3 uFlashCol[${MAX_FLASHES}];
uniform int uFlashCount;
`;

export function createFlashUniforms() {
  return {
    uFlashPos: { value: Array.from({ length: MAX_FLASHES }, () => new THREE.Vector3()) },
    uFlashCol: { value: Array.from({ length: MAX_FLASHES }, () => new THREE.Vector3()) },
    uFlashCount: { value: 0 },
  };
}

/**
 * Night-sky dome. Colours are display-linear (the final pass does not lift
 * shadows), tuned to read as a deep, clear night: near-black overhead, a
 * faint navy band at the horizon and a trace of warm town glow above the
 * rooftops. Bursts light the smoke around them, briefly.
 * Uses `cameraPosition`, so it renders correctly from the mirror camera too.
 */
export function createSky(flashUniforms) {
  const geo = new THREE.SphereGeometry(4000, 48, 24);
  const mat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    uniforms: {
      ...flashUniforms,
      uTime: { value: 0 },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDir;
      void main() {
        vec3 w = (modelMatrix * vec4(position, 1.0)).xyz;
        vDir = w - cameraPosition;
        vec4 p = projectionMatrix * viewMatrix * vec4(w, 1.0);
        gl_Position = p.xyww;
      }
    `,
    fragmentShader: /* glsl */ `
      ${FLASH_GLSL}
      uniform float uTime;
      varying vec3 vDir;
      void main() {
        vec3 d = normalize(vDir);
        float h = d.y;
        vec3 zenith = vec3(0.00022, 0.00036, 0.0012);
        vec3 mid = vec3(0.0006, 0.0009, 0.0026);
        vec3 horizon = vec3(0.0014, 0.0017, 0.0036);
        vec3 col = mix(horizon, mid, smoothstep(0.0, 0.2, h));
        col = mix(col, zenith, smoothstep(0.15, 0.7, h));
        // The town's faint light dome: sodium-warm, low, centred ahead. Just
        // enough for hills and rooftops to read as silhouettes.
        float ahead = smoothstep(0.55, 1.0, -d.z / max(length(d.xz), 1e-4));
        col += vec3(0.0028, 0.0018, 0.0011) * exp(-max(h, 0.0) * 16.0) * (0.4 + 0.6 * ahead);
        for (int i = 0; i < ${MAX_FLASHES}; i++) {
          if (i >= uFlashCount) break;
          vec3 fd = normalize(uFlashPos[i] - cameraPosition);
          float c = clamp(dot(d, fd), -1.0, 1.0);
          float a2 = 2.0 * (1.0 - c); // ≈ angle², cheaper than acos
          col += uFlashCol[i] * (exp(-a2 * 90.0) * 0.026 + exp(-a2 * 14.0) * 0.0025);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = -100;
  mesh.frustumCulled = false;
  return mesh;
}

/** A field of crisp, softly twinkling stars on the upper hemisphere. */
export function createStars(count = 2400, seed = 7) {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const pos = new Float32Array(count * 3);
  const data = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    // Bias toward higher elevations a little; avoid the horizon haze.
    const y = 0.05 + Math.pow(rand(), 0.8) * 0.95;
    const r = Math.sqrt(1 - y * y);
    const a = rand() * Math.PI * 2;
    pos.set([Math.cos(a) * r * 3500, y * 3500, Math.sin(a) * r * 3500], i * 3);
    const mag = Math.pow(rand(), 4.0);
    data.set([mag, rand() * 100], i * 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('aData', new THREE.BufferAttribute(data, 2));
  const mat = new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uPixelRatio: { value: 1 }, uDim: { value: 1 } },
    vertexShader: /* glsl */ `
      attribute vec2 aData;
      uniform float uTime;
      uniform float uPixelRatio;
      uniform float uDim;
      varying float vB;
      void main() {
        vec4 p = projectionMatrix * viewMatrix * vec4(position + cameraPosition, 1.0);
        gl_Position = p.xyww;
        float tw = 0.75 + 0.25 * sin(uTime * (0.6 + fract(aData.y) * 2.2) + aData.y);
        float elev = normalize(position).y;
        vB = (0.016 + aData.x * 0.3) * tw * smoothstep(0.04, 0.22, elev) * uDim;
        gl_PointSize = (1.6 + aData.x * 1.6) * uPixelRatio;
      }
    `,
    fragmentShader: /* glsl */ `
      varying float vB;
      void main() {
        vec2 c = gl_PointCoord * 2.0 - 1.0;
        float r2 = dot(c, c);
        if (r2 > 1.0) discard;
        float a = exp(-r2 * 5.0) * vB;
        gl_FragColor = vec4(vec3(0.82, 0.88, 1.0) * a, 1.0);
      }
    `,
  });
  const pts = new THREE.Points(geo, mat);
  pts.renderOrder = -90;
  pts.frustumCulled = false;
  return pts;
}
