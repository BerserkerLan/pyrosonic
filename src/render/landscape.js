import * as THREE from 'three';
import { FLASH_GLSL, MAX_FLASHES } from './sky.js';

/**
 * Riverside scenery, drawn procedurally into canvas textures:
 * distant hills, a town on the far bank (trees, rooftops, a church spire,
 * an arched bridge, lit windows), the river, and silhouettes of the crowd.
 * Everything picks up colour from the bursts via the shared flash uniforms.
 */

function rngFrom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function drawHills(w, h, seed) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const r = rngFrom(seed);
  const layers = [
    { base: h * 0.62, amp: h * 0.28, col: '#010205' },
    { base: h * 0.78, amp: h * 0.16, col: '#010103' },
  ];
  const ph = [r() * 10, r() * 10, r() * 10];
  for (const L of layers) {
    g.fillStyle = L.col;
    g.beginPath();
    g.moveTo(0, h);
    for (let x = 0; x <= w; x += 4) {
      const u = (x / w) * Math.PI * 2;
      const y = L.base - L.amp * (0.5 + 0.28 * Math.sin(u * 2 + ph[0]) + 0.16 * Math.sin(u * 5 + ph[1]) + 0.06 * Math.sin(u * 13 + ph[2]));
      g.lineTo(x, y);
    }
    g.lineTo(w, h);
    g.closePath();
    g.fill();
  }
  return c;
}

function drawTown(w, h, seed) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const r = rngFrom(seed);
  const ground = h - 46;
  const sil = '#010103';
  const lights = [];

  // Treeline across the whole width.
  g.fillStyle = sil;
  for (let x = -40; x < w + 40; ) {
    const conifer = r() < 0.22;
    const s = 14 + r() * 26;
    if (conifer) {
      g.beginPath();
      g.moveTo(x - s * 0.55, ground);
      g.lineTo(x, ground - s * 2.6);
      g.lineTo(x + s * 0.55, ground);
      g.fill();
    } else {
      for (let k = 0; k < 4; k++) {
        g.beginPath();
        g.arc(x + (r() - 0.5) * s, ground - s * (0.7 + r() * 0.9), s * (0.55 + r() * 0.5), 0, Math.PI * 2);
        g.fill();
      }
    }
    x += s * (0.7 + r() * 0.6);
  }

  // Town centre: rooftops with lit windows.
  const townA = w * 0.36;
  const townB = w * 0.7;
  let x = townA;
  while (x < townB) {
    const bw = 34 + r() * 70;
    const bh = 50 + r() * 95;
    const top = ground - bh;
    g.fillStyle = sil;
    g.fillRect(x, top, bw, bh + 2);
    if (r() < 0.6) {
      g.beginPath();
      g.moveTo(x - 4, top);
      g.lineTo(x + bw / 2, top - bw * (0.25 + r() * 0.3));
      g.lineTo(x + bw + 4, top);
      g.fill();
    }
    if (r() < 0.4) g.fillRect(x + bw * (0.2 + r() * 0.6), top - 22, 7, 24);
    // Windows
    for (let wy = top + 10; wy < ground - 14; wy += 17) {
      for (let wx = x + 7; wx < x + bw - 10; wx += 14) {
        if (r() < 0.22) lights.push({ x: wx, y: wy, w: 6, h: 9, warm: r() < 0.85 });
      }
    }
    x += bw + (r() < 0.25 ? 6 + r() * 20 : 0);
  }

  // Church with tower and spire.
  {
    const cx = w * 0.555;
    const tw = 54;
    const th = 150;
    g.fillStyle = sil;
    g.fillRect(cx - tw / 2, ground - th, tw, th);
    g.beginPath();
    g.moveTo(cx - tw / 2 - 3, ground - th);
    g.lineTo(cx, ground - th - 170);
    g.lineTo(cx + tw / 2 + 3, ground - th);
    g.fill();
    // Pinnacles
    for (const px of [cx - tw / 2, cx + tw / 2 - 6]) g.fillRect(px, ground - th - 18, 6, 18);
    // Nave
    g.fillRect(cx + tw / 2, ground - 80, 130, 80);
    g.beginPath();
    g.moveTo(cx + tw / 2, ground - 80);
    g.lineTo(cx + tw / 2 + 65, ground - 112);
    g.lineTo(cx + tw / 2 + 130, ground - 80);
    g.fill();
    lights.push({ x: cx - 5, y: ground - th + 30, w: 10, h: 22, warm: true, dim: true });
  }

  // Many-arched stone bridge on the left.
  {
    const bx0 = w * 0.08;
    const bx1 = w * 0.3;
    const deck = ground - 34;
    g.fillStyle = sil;
    g.fillRect(bx0, deck - 10, bx1 - bx0, 12);
    const arches = 8;
    const span = (bx1 - bx0) / arches;
    g.beginPath();
    g.moveTo(bx0, deck);
    for (let i = 0; i < arches; i++) {
      const a0 = bx0 + i * span;
      g.lineTo(a0 + span * 0.12, deck);
      g.lineTo(a0 + span * 0.12, ground - 8);
      g.arc(a0 + span / 2, ground - 8, span * 0.38, Math.PI, 0, false);
      g.lineTo(a0 + span * 0.88, deck);
    }
    g.lineTo(bx1, deck);
    g.lineTo(bx1, ground + 10);
    g.lineTo(bx0, ground + 10);
    g.closePath();
    // Fill everything except the arch openings: draw piers and spandrels.
    g.fillStyle = sil;
    for (let i = 0; i <= arches; i++) {
      const px = bx0 + i * span - span * 0.12;
      g.fillRect(px, deck, span * 0.24, ground - deck + 10);
    }
    for (let i = 0; i < arches; i++) {
      const a0 = bx0 + i * span;
      g.beginPath();
      g.moveTo(a0 + span * 0.1, deck);
      g.lineTo(a0 + span * 0.9, deck);
      g.lineTo(a0 + span * 0.9, ground - 8);
      g.arc(a0 + span / 2, ground - 8, span * 0.4, 0, Math.PI, true);
      g.closePath();
      g.fill();
    }
    for (let i = 0; i <= 6; i++) {
      const lx = bx0 + ((bx1 - bx0) * i) / 6;
      g.fillRect(lx - 1.5, deck - 30, 3, 22);
      lights.push({ x: lx, y: deck - 31, lamp: true });
    }
  }

  // Riverside lamps through the town.
  for (let lx = w * 0.33; lx < w * 0.74; lx += 70 + r() * 50) {
    g.fillStyle = sil;
    g.fillRect(lx - 1.5, ground - 26, 3, 26);
    lights.push({ x: lx, y: ground - 27, lamp: true });
  }

  // Far bank / ground strip.
  g.fillStyle = sil;
  g.fillRect(0, ground - 2, w, h - ground + 2);

  // Emissive lights.
  for (const L of lights) {
    if (L.lamp) {
      const grd = g.createRadialGradient(L.x, L.y, 0, L.x, L.y, 8);
      grd.addColorStop(0, 'rgba(255,200,140,0.55)');
      grd.addColorStop(0.35, 'rgba(255,180,110,0.16)');
      grd.addColorStop(1, 'rgba(255,170,90,0)');
      g.fillStyle = grd;
      g.fillRect(L.x - 8, L.y - 8, 16, 16);
      g.fillStyle = '#f2c98e';
      g.fillRect(L.x - 1, L.y - 1, 2.5, 2.5);
    } else {
      g.fillStyle = L.warm ? (L.dim ? '#a8763c' : ['#f3b765', '#ffd28a', '#e9a453'][Math.floor(r() * 3)]) : '#b9d2ff';
      g.globalAlpha = L.dim ? 0.8 : 0.55 + r() * 0.45;
      g.fillRect(L.x, L.y, L.w, L.h);
      g.globalAlpha = 1;
    }
  }
  return c;
}

function drawCrowd(w, h, seed) {
  const c = makeCanvas(w, h);
  const g = c.getContext('2d');
  const r = rngFrom(seed);
  const sil = '#010103';
  const screens = [];
  g.fillStyle = sil;
  // Two rows: back row smaller.
  for (const row of [{ y: h * 0.62, s: 0.72 }, { y: h * 0.8, s: 1 }]) {
    for (let x = -60; x < w + 60; ) {
      const s = row.s * (0.85 + r() * 0.35);
      const headR = 40 * s;
      const shoulderW = 150 * s;
      const top = row.y - headR * 2.1 + r() * 30 * s;
      const kid = r() < 0.06;
      // Shoulders / body
      g.beginPath();
      const sy = top + headR * 2.0;
      g.moveTo(x - shoulderW / 2, h);
      g.lineTo(x - shoulderW / 2, sy + 40 * s);
      g.quadraticCurveTo(x - shoulderW / 2, sy, x - shoulderW * 0.22, sy - 4 * s);
      g.lineTo(x + shoulderW * 0.22, sy - 4 * s);
      g.quadraticCurveTo(x + shoulderW / 2, sy, x + shoulderW / 2, sy + 40 * s);
      g.lineTo(x + shoulderW / 2, h);
      g.fill();
      // Neck + head
      g.fillRect(x - headR * 0.4, top + headR * 1.4, headR * 0.8, headR);
      g.beginPath();
      g.ellipse(x, top + headR, headR * 0.82, headR, 0, 0, Math.PI * 2);
      g.fill();
      if (kid) {
        // A child on shoulders
        g.beginPath();
        g.ellipse(x, top - headR * 1.35, headR * 0.62, headR * 0.72, 0, 0, Math.PI * 2);
        g.fill();
        g.fillRect(x - headR * 0.9, top - headR * 0.7, headR * 1.8, headR * 0.9);
      }
      if (r() < 0.1) {
        // Raised phone
        const side = r() < 0.5 ? -1 : 1;
        const ax = x + side * shoulderW * 0.35;
        const ay = sy;
        const px = ax + side * 10 * s;
        const py = top - headR * (1.3 + r() * 0.8);
        g.lineWidth = 18 * s;
        g.lineCap = 'round';
        g.strokeStyle = sil;
        g.beginPath();
        g.moveTo(ax, ay);
        g.lineTo(px, py + 30 * s);
        g.stroke();
        g.fillRect(px - 16 * s, py - 4 * s, 32 * s, 52 * s);
        screens.push({ x: px - 13 * s, y: py, w: 26 * s, h: 44 * s });
      }
      x += shoulderW * (0.62 + r() * 0.35);
    }
  }
  // Solid ground along the bottom edge: the crowd plane repeats this row
  // downwards to fill the foreground, so it must have no gaps.
  g.fillRect(0, h * 0.94, w, h * 0.06 + 1);
  for (const sc of screens) {
    // Phone screens: dim, slightly blue — they read as screens, not lamps.
    const grd = g.createLinearGradient(sc.x, sc.y, sc.x, sc.y + sc.h);
    grd.addColorStop(0, '#3a4766');
    grd.addColorStop(1, '#262f48');
    g.fillStyle = grd;
    g.fillRect(sc.x + sc.w * 0.12, sc.y + sc.h * 0.1, sc.w * 0.76, sc.h * 0.8);
  }
  return c;
}

function makeTexture(canvas) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** Billboard material: texture colour + a tint from nearby bursts. */
function silhouetteMaterial(tex, flashUniforms, { emissiveGain = 1, litGain = 0.05, ambient, depthTest = true }) {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: true,
    depthTest,
    uniforms: { ...flashUniforms, uMap: { value: tex }, uAmbient: ambient, uEmissive: { value: emissiveGain }, uLit: { value: litGain } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uMap;
      uniform vec3 uAmbient;
      uniform float uEmissive;
      uniform float uLit;
      varying vec2 vUv;
      void main() {
        vec4 t = texture2D(uMap, vUv);
        if (t.a < 0.02) discard;
        float lum = dot(t.rgb, vec3(0.299, 0.587, 0.114));
        float emissive = smoothstep(0.03, 0.2, lum);
        vec3 col = t.rgb * mix(1.0, uEmissive, emissive) + uAmbient * uLit * (0.4 + 0.6 * clamp(vUv.y, 0.0, 1.0)) * (1.0 - emissive);
        gl_FragColor = vec4(col, t.a);
      }
    `,
  });
}

/** Height of the river surface (world units). */
export const WATER_Y = 0;

/**
 * Twelve travelling waves, log-spaced from 10 m down to 25 cm, mostly running
 * towards or away from the viewer (±60°) so ripple crests read as the
 * horizontal bands you see on a real river. Short waves are less steep.
 */
const WAVE_CALLS = (() => {
  const r = rngFrom(4242);
  const n = 12;
  const lines = [];
  for (let i = 0; i < n; i++) {
    const L = 10 * Math.pow(0.25 / 10, i / (n - 1));
    const ang = (r() - 0.5) * 2.1 + (r() < 0.5 ? 0 : Math.PI);
    const s = 0.029 - 0.013 * (i / (n - 1));
    const f = (v) => v.toFixed(4);
    lines.push(`        wave(p, vec2(${f(Math.sin(ang))}, ${f(Math.cos(ang))}), ${f(L)}, ${f(s)}, ${f(r() * 6.2832)}, fw, slope, lost);`);
  }
  return lines.join('\n');
})();

/**
 * River surface. It reflects a mirror-camera render of the scene (see
 * Engine.updateMirror) through an animated field of small waves:
 *  - twelve travelling waves (WAVE_CALLS) with deep-water dispersion distort
 *    the image;
 *  - waves smaller than a pixel are filtered out and their slope energy
 *    becomes roughness, which stretches each light into the vertical,
 *    shimmering streak you see on real water at night;
 *  - Schlick Fresnel makes the far water a near-mirror and the water at your
 *    feet dark and transparent-looking;
 *  - burst light glints off individual wave facets.
 */
function waterMaterial(flashUniforms, reflectMap, texMatrix) {
  return new THREE.ShaderMaterial({
    depthWrite: true,
    uniforms: {
      ...flashUniforms,
      uTime: { value: 0 },
      uReflectMap: { value: reflectMap },
      uTexMatrix: { value: texMatrix },
    },
    vertexShader: /* glsl */ `
      varying vec3 vWorld;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vWorld = w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      ${FLASH_GLSL}
      uniform float uTime;
      uniform sampler2D uReflectMap;
      uniform mat4 uTexMatrix;
      varying vec3 vWorld;

      const float TAU = 6.2831853;

      void wave(vec2 p, vec2 d, float L, float s, float ph, vec2 fw, inout vec2 slope, inout vec2 lost) {
        float k = TAU / L;
        float w = sqrt(9.8 * k) * 0.7;
        float fp = abs(d.x) * fw.x + abs(d.y) * fw.y;
        float keep = 1.0 - smoothstep(0.2 * L, 0.55 * L, fp);
        slope += d * (s * keep * cos(k * dot(d, p) - w * uTime + ph));
        lost += d * d * (s * s * 0.5 * (1.0 - keep * keep));
      }

      void main() {
        vec3 toP = vWorld - cameraPosition;
        vec3 V = normalize(toP);
        vec2 fw = fwidth(vWorld.xz);
        vec2 p = vWorld.xz;
        vec2 slope = vec2(0.0);
        vec2 lost = vec2(0.0);
${WAVE_CALLS}
        float roughZ = sqrt(lost.y + 0.00002);

        vec3 N = normalize(vec3(-slope.x, 1.0, -slope.y));
        float cosI = clamp(dot(-V, N), 0.0, 1.0);
        float F = 0.02 + 0.98 * pow(1.0 - cosI, 5.0);

        // Reflected scene, integrated over the unresolved facet slopes along
        // the view direction: lights smear into vertical streaks.
        vec3 refl = vec3(0.0);
        float wsum = 0.0;
        for (int i = 0; i < 7; i++) {
          float o = float(i - 3) * 0.8;
          float w = exp(-0.5 * o * o);
          vec2 sl = slope + vec2(0.0, roughZ * o);
          vec3 R = reflect(V, normalize(vec3(-sl.x, 1.0, -sl.y)));
          R.y = max(R.y, 0.0005);
          vec4 c = uTexMatrix * vec4(vWorld + R * 260.0, 1.0);
          refl += texture2D(uReflectMap, c.xy / c.w).rgb * w;
          wsum += w;
        }
        refl /= wsum;

        vec3 body = vec3(0.00022, 0.00038, 0.00052);
        vec3 col = body * (1.0 - F) + refl * F;

        // Burst light glinting off wave facets.
        float shin = clamp(2.0 / (roughZ * roughZ + 0.0004), 120.0, 2400.0);
        for (int i = 0; i < ${MAX_FLASHES}; i++) {
          if (i >= uFlashCount) break;
          vec3 L = normalize(uFlashPos[i] - vWorld);
          vec3 H = normalize(L - V);
          float nh = max(dot(N, H), 0.0);
          col += uFlashCol[i] * F * (pow(nh, shin) * (0.02 + shin * 0.00012) + pow(nh, 40.0) * 0.0015);
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });
}

export function createLandscape(flashUniforms, { reflectMap, texMatrix }) {
  const group = new THREE.Group();
  const ambient = { value: new THREE.Vector3() };
  const uniforms = { ambient };

  // Distant hills
  const hillsTex = makeTexture(drawHills(2048, 256, 11));
  const hills = new THREE.Mesh(new THREE.PlaneGeometry(3600, 450), silhouetteMaterial(hillsTex, flashUniforms, { litGain: 0.0011, ambient }));
  hills.position.set(0, 225 - 150, -1100);
  hills.renderOrder = -50;
  group.add(hills);

  // Town on the far bank
  const townTex = makeTexture(drawTown(4096, 512, 2026));
  const townW = 1000;
  const townH = townW * (512 / 4096);
  const town = new THREE.Mesh(new THREE.PlaneGeometry(townW, townH), silhouetteMaterial(townTex, flashUniforms, { emissiveGain: 1.05, litGain: 0.0026, ambient }));
  town.position.set(40, -12 + townH / 2, -345);
  town.renderOrder = -40;
  group.add(town);

  // Far-bank ground between the shore and the town (double-sided: the
  // mirror camera sees it from below).
  const bank = new THREE.Mesh(
    new THREE.PlaneGeometry(2400, 120),
    new THREE.MeshBasicMaterial({ color: new THREE.Color(0.0003, 0.00035, 0.0007), side: THREE.DoubleSide }),
  );
  bank.rotation.x = -Math.PI / 2;
  bank.position.set(0, WATER_Y + 0.35, -296);
  bank.renderOrder = -39;
  group.add(bank);

  // River
  // From the far bank to just under the camera, so even a tall screen's
  // steepest view down still lands on water.
  const water = new THREE.Mesh(new THREE.PlaneGeometry(2400, 252, 1, 1), waterMaterial(flashUniforms, reflectMap, texMatrix));
  water.rotation.x = -Math.PI / 2;
  water.position.set(0, WATER_Y, 6 - 126);
  water.renderOrder = -30;
  group.add(water);

  // Crowd silhouettes close to the camera
  const crowdTex = makeTexture(drawCrowd(4096, 512, 77));
  const crowdW = 64;
  const crowdH = crowdW * (512 / 4096);
  // The plane runs on below the texture (V is clamped, so its solid bottom
  // row repeats) so the near bank fills the bottom of the frame — even at the
  // widest lens on a tall screen, with drift and shake — instead of leaving a
  // strip of open water under the crowd.
  const crowdExt = 10;
  const crowdGeo = new THREE.PlaneGeometry(crowdW, crowdH + crowdExt);
  const crowdUv = crowdGeo.attributes.uv;
  for (let i = 0; i < crowdUv.count; i++) crowdUv.setY(i, crowdUv.getY(i) * (1 + crowdExt / crowdH) - crowdExt / crowdH);
  const crowd = new THREE.Mesh(crowdGeo, silhouetteMaterial(crowdTex, flashUniforms, { emissiveGain: 0.7, litGain: 0.0014, ambient, depthTest: false }));
  crowd.position.set(0, -3.2 + crowdH - (crowdH + crowdExt) / 2, -18);
  // The crowd stands on the near bank, in front of everything: drawn last, without depth test
  // (otherwise the river surface, which writes depth, would cut it off at the waterline).
  crowd.renderOrder = 50;
  group.add(crowd);

  return {
    group,
    uniforms,
    water,
    crowd,
    town,
    /** Seen by the main camera only — never in the reflection. */
    noReflect: [water, crowd],
    update(time) {
      water.material.uniforms.uTime.value = time;
    },
    setCrowd(on) {
      crowd.visible = on;
    },
    dispose() {
      for (const m of [hills, town, bank, water, crowd]) {
        m.geometry.dispose();
        m.material.uniforms?.uMap?.value?.dispose();
        m.material.dispose();
      }
    },
  };
}
