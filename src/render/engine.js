import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { ParticleSystem } from './particles.js';
import { createSky, createStars, createFlashUniforms, MAX_FLASHES } from './sky.js';
import { createLandscape, WATER_Y } from './landscape.js';
import { STAGE } from '../show/shells.js';

/**
 * `pixelRatio` caps the render resolution; `reflection` is the water
 * reflection's resolution relative to the screen.
 */
export const QUALITY = {
  high: { pixelRatio: 2, trails: 32768, sparks: 65536, segments: 12, reflection: 0.5, bloomScale: 0.75, density: 1 },
  medium: { pixelRatio: 1.5, trails: 20000, sparks: 40000, segments: 9, reflection: 0.4, bloomScale: 0.6, density: 0.8 },
  low: { pixelRatio: 1.25, trails: 12000, sparks: 24000, segments: 6, reflection: 0.3, bloomScale: 0.5, density: 0.6 },
};

/** Objects on this layer are seen by the main camera only (not in the water reflection). */
const LAYER_NO_REFLECT = 1;

// Bloom weighted towards its tightest levels: a crisp glow around bright
// stars, without the wide haze that would grey out the night sky.
const BLOOM = { strength: 0.62, radius: 0, threshold: 0.5, factors: [1.0, 0.72, 0.42, 0.2, 0.08] };

/**
 * Final pass: exposure, a hue-preserving highlight roll-off (Khronos PBR
 * Neutral without its toe, so the night stays exactly as dark as authored and
 * saturated stars keep their colour while the hottest cores go white),
 * a gentle vignette, sRGB encoding and ±1 LSB dither against banding.
 */
const FinishShader = {
  uniforms: { tDiffuse: { value: null }, uExposure: { value: 1 }, uVignette: { value: 0.26 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uExposure;
    uniform float uVignette;
    varying vec2 vUv;

    vec3 tonemap(vec3 c) {
      const float start = 0.76;
      const float desat = 0.15;
      float peak = max(c.r, max(c.g, c.b));
      if (peak < start) return c;
      float d = 1.0 - start;
      float newPeak = 1.0 - d * d / (peak + d - start);
      c *= newPeak / peak;
      float g = 1.0 - 1.0 / (desat * (peak - newPeak) + 1.0);
      return mix(c, vec3(newPeak), g);
    }

    vec3 toSRGB(vec3 c) {
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }

    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec3 c = max(texture2D(tDiffuse, vUv).rgb, 0.0) * uExposure;
      vec2 d = vUv - 0.5;
      c *= 1.0 - uVignette * smoothstep(0.2, 0.9, dot(d, d) * 2.0);
      c = toSRGB(clamp(tonemap(c), 0.0, 1.0));
      vec2 fc = gl_FragCoord.xy;
      c += (hash(fc) + hash(fc + 19.19) - 1.0) / 255.0;
      gl_FragColor = vec4(c, 1.0);
    }
  `,
};

/**
 * Owns the WebGL renderer, camera, scenery, particle systems and the
 * post-processing chain. Time is supplied externally (the audio clock) so
 * rendering is always in lock-step with what you hear.
 */
export class Engine {
  constructor(canvas, { quality = 'high', reducedMotion = false } = {}) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false, depth: true });
    this.renderer.setClearColor(0x000000, 1);
    // Tone mapping and sRGB encoding happen in FinishShader.
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.5, 6000);
    this.camera.layers.enable(LAYER_NO_REFLECT);
    this.camBase = new THREE.Vector3(0, 5.5, 8);
    this.lookBase = new THREE.Vector3(0, 39, -260);
    this.camera.position.copy(this.camBase);
    this.camera.lookAt(this.lookBase);
    this.motion = !reducedMotion;
    this.shakeAmp = 0;

    // Planar water reflection: the scene is rendered from a camera mirrored
    // below the water surface (with an oblique near plane on the surface)
    // into a half-resolution HDR target that the water shader samples.
    this.mirrorCam = new THREE.PerspectiveCamera();
    this.mirrorCam.layers.set(0);
    this.reflectRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, stencilBuffer: false });
    this.reflectRT.texture.generateMipmaps = false;
    this.reflectSize = new THREE.Vector2(1, 1);
    this.texMatrix = new THREE.Matrix4();
    this._m = {
      pos: new THREE.Vector3(),
      rot: new THREE.Matrix4(),
      fwd: new THREE.Vector3(),
      target: new THREE.Vector3(),
      up: new THREE.Vector3(),
      plane: new THREE.Plane(),
      clip: new THREE.Vector4(),
      q: new THREE.Vector4(),
    };

    this.flashUniforms = createFlashUniforms();
    this.sky = createSky(this.flashUniforms);
    this.stars = createStars();
    this.stars.layers.set(LAYER_NO_REFLECT);
    this.landscape = createLandscape(this.flashUniforms, { reflectMap: this.reflectRT.texture, texMatrix: this.texMatrix });
    for (const o of this.landscape.noReflect) o.layers.set(LAYER_NO_REFLECT);
    this.scene.add(this.sky, this.stars, this.landscape.group);

    this.uniforms = {
      uTime: { value: 0 },
      uBrightness: { value: 1 },
      uStrobeOn: { value: 1 },
      uSizeScale: { value: 1 },
      uViewport: { value: new THREE.Vector2(1, 1) },
    };

    this.stage = { halfWidth: STAGE.halfWidth, scale: 1, yScale: 1 };
    this.quality = null;
    this.systems = null;
    this.setQuality(quality);

    this.composer = new EffectComposer(this.renderer);
    this.renderPass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
    this.bloom.compositeMaterial.uniforms.bloomFactors.value = BLOOM.factors;
    // The bloom runs at its own (reduced) resolution, set in resize(). Stop the
    // composer resizing it to full size first, which reallocated every target twice.
    this.setBloomSize = this.bloom.setSize.bind(this.bloom);
    this.bloom.setSize = () => {};
    this.exposure = 1;
    this.finish = new ShaderPass(FinishShader);
    this.composer.addPass(this.renderPass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(this.finish);

    this._ambient = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this.contextLost = false;
    canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.contextLost = true;
      this.onContextLost?.();
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
      this.onContextRestored?.();
    });
    this.resize();
  }

  setQuality(name) {
    const q = QUALITY[name] || QUALITY.high;
    if (this.qualityName === name && this.systems) return;
    this.qualityName = name;
    this.quality = q;
    if (this.systems) {
      for (const s of this.systems) {
        for (const o of s.objects) this.scene.remove(o);
        s.dispose();
      }
    }
    this.trails = new ParticleSystem({ capacity: q.trails, segments: q.segments, uniforms: this.uniforms, renderOrder: 10 });
    this.sparks = new ParticleSystem({ capacity: q.sparks, segments: 2, uniforms: this.uniforms, renderOrder: 20 });
    this.systems = [this.trails, this.sparks];
    for (const s of this.systems) for (const o of s.objects) this.scene.add(o);
    if (this.composer) this.resize();
  }

  resize() {
    const w = Math.max(1, this.canvas.clientWidth || window.innerWidth);
    const h = Math.max(1, this.canvas.clientHeight || window.innerHeight);
    const pr = Math.min(window.devicePixelRatio || 1, this.quality.pixelRatio);
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.composer.setPixelRatio(pr);
    this.composer.setSize(w, h);
    const bs = this.quality.bloomScale;
    const bw = Math.max(2, Math.round(w * pr * bs));
    const bh = Math.max(2, Math.round(h * pr * bs));
    this.bloom.resolution.set(bw, bh);
    this.setBloomSize(bw, bh);
    const rs = this.quality.reflection;
    this.reflectSize.set(Math.max(2, Math.round(w * pr * rs)), Math.max(2, Math.round(h * pr * rs)));
    this.reflectRT.setSize(this.reflectSize.x, this.reflectSize.y);
    this.uniforms.uViewport.value.set(w * pr, h * pr);
    this.stars.material.uniforms.uPixelRatio.value = pr;

    // Fit the show to the viewport: widen the lens for tall screens, then
    // narrow the stage so every shell stays in frame.
    const aspect = w / h;
    const depth = STAGE.depth + 8;
    const wantHalfW = 190;
    const vfovNeeded = 2 * Math.atan(wantHalfW / (depth * aspect));
    const vfov = THREE.MathUtils.clamp(vfovNeeded, THREE.MathUtils.degToRad(52), THREE.MathUtils.degToRad(74));
    this.camera.fov = THREE.MathUtils.radToDeg(vfov);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    const halfVisible = depth * Math.tan(vfov / 2) * aspect;
    this.stage.halfWidth = Math.min(STAGE.halfWidth, halfVisible * 0.84);
    this.stage.scale = THREE.MathUtils.clamp(this.stage.halfWidth / STAGE.halfWidth, 0.5, 1);
    // Keep the horizon around 35–40 % up the frame.
    const pitch = Math.atan(0.24 * Math.tan(vfov / 2));
    const dist = this.camBase.z - this.lookBase.z;
    this.lookBase.y = this.camBase.y + Math.tan(pitch) * dist;
    // Tall screens have extra sky: let shells climb higher to use it.
    const yTop = this.camBase.y + dist * Math.tan(pitch + vfov / 2);
    const maxRadius = 50 * this.stage.scale;
    const usable = yTop - maxRadius * 1.05 - STAGE.yMin;
    this.stage.yScale = THREE.MathUtils.clamp(usable / (STAGE.yMax - STAGE.yMin), 1, 1.6);
    this.width = w;
    this.height = h;
  }

  /** Upload newly built particles. */
  spawn(target) {
    if (target.trails.count) this.trails.spawn(target.trails.view(), target.trails.count);
    if (target.sparks.count) this.sparks.spawn(target.sparks.view(), target.sparks.count);
  }

  clear() {
    for (const s of this.systems) s.killAll(true);
  }

  setReducedFlashing(on) {
    this.uniforms.uStrobeOn.value = on ? 0 : 1;
    this.uniforms.uBrightness.value = on ? 0.82 : 1;
    this.bloom.strength = on ? BLOOM.strength * 0.8 : BLOOM.strength;
  }

  setCrowd(on) {
    this.landscape.setCrowd(on);
  }

  shake(amount) {
    if (this.motion) this.shakeAmp = Math.min(1.2, this.shakeAmp + amount);
  }

  /**
   * Place the mirror camera below the water and give it an oblique near
   * plane lying on the surface, so nothing under the water leaks into the
   * reflection (after three.js' Reflector and Lengyel's oblique frustum).
   */
  updateMirror() {
    const cam = this.camera;
    const m = this.mirrorCam;
    const { pos, rot, fwd, target, up, plane, clip, q } = this._m;
    pos.setFromMatrixPosition(cam.matrixWorld);
    rot.extractRotation(cam.matrixWorld);
    fwd.set(0, 0, -1).applyMatrix4(rot);
    target.copy(pos).add(fwd);
    target.y = 2 * WATER_Y - target.y;
    up.set(0, 1, 0).applyMatrix4(rot);
    up.y = -up.y;
    m.position.set(pos.x, 2 * WATER_Y - pos.y, pos.z);
    m.up.copy(up);
    m.lookAt(target);
    m.near = cam.near;
    m.far = cam.far;
    m.updateMatrixWorld();
    m.projectionMatrix.copy(cam.projectionMatrix);

    this.texMatrix.set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);
    this.texMatrix.multiply(m.projectionMatrix);
    this.texMatrix.multiply(m.matrixWorldInverse);

    plane.normal.set(0, 1, 0);
    plane.constant = -WATER_Y;
    plane.applyMatrix4(m.matrixWorldInverse);
    clip.set(plane.normal.x, plane.normal.y, plane.normal.z, plane.constant);
    const e = m.projectionMatrix.elements;
    q.x = (Math.sign(clip.x) + e[8]) / e[0];
    q.y = (Math.sign(clip.y) + e[9]) / e[5];
    q.z = -1;
    q.w = (1 + e[10]) / e[14];
    clip.multiplyScalar(2 / clip.dot(q));
    e[2] = clip.x;
    e[6] = clip.y;
    e[10] = clip.z + 1;
    e[14] = clip.w;
    m.projectionMatrixInverse.copy(m.projectionMatrix).invert();
  }

  /**
   * @param showTime  seconds on the show clock (drives particles)
   * @param realTime  wall-clock seconds (ambient motion, twinkle)
   * @param flashes   [{x,y,z,r,g,b,i}] active burst lights, strongest first
   */
  render(showTime, realTime, flashes, dt = 1 / 60) {
    if (this.contextLost) return;
    this.uniforms.uTime.value = showTime;

    // Camera: a slow, breathing drift plus a little shake on big hits.
    const cam = this.camera;
    cam.position.copy(this.camBase);
    const look = this._look.copy(this.lookBase);
    if (this.motion) {
      cam.position.x += Math.sin(realTime * 0.041) * 1.1;
      cam.position.y += Math.sin(realTime * 0.057 + 1.3) * 0.35;
      look.x += Math.sin(realTime * 0.033 + 0.5) * 7;
      look.y += Math.sin(realTime * 0.047 + 2.1) * 2.5;
      if (this.shakeAmp > 0.001) {
        const a = this.shakeAmp;
        cam.position.x += (Math.sin(realTime * 61.3) + Math.sin(realTime * 37.1)) * 0.06 * a;
        cam.position.y += (Math.sin(realTime * 53.7) + Math.sin(realTime * 29.3)) * 0.06 * a;
        this.shakeAmp *= Math.exp(-dt * 7);
      }
    }
    cam.lookAt(look);
    cam.updateMatrixWorld();

    // Burst lights. Total light is soft-compressed so a busy finale reads as
    // "bright" without washing the sky out, and exposure eases down like a camera.
    const fu = this.flashUniforms;
    const n = Math.min(MAX_FLASHES, flashes.length);
    let load = 0;
    for (const f of flashes) load += f.i;
    const comp = 1 / (1 + load * 0.12);
    const amb = this._ambient.set(0, 0, 0);
    for (let i = 0; i < n; i++) {
      const f = flashes[i];
      const k = f.i * comp;
      fu.uFlashPos.value[i].set(f.x, f.y, f.z);
      fu.uFlashCol.value[i].set(f.r * k, f.g * k, f.b * k);
    }
    for (const f of flashes) {
      const k = f.i * comp;
      amb.x += f.r * k;
      amb.y += f.g * k;
      amb.z += f.b * k;
    }
    fu.uFlashCount.value = n;
    this.landscape.uniforms.ambient.value.set(Math.min(amb.x, 2.5), Math.min(amb.y, 2.5), Math.min(amb.z, 2.5));
    const targetExposure = 1 / (1 + load * 0.03);
    const rate = targetExposure < this.exposure ? 6 : 1.5;
    this.exposure += (targetExposure - this.exposure) * (1 - Math.exp(-dt * rate));
    this.finish.uniforms.uExposure.value = this.exposure;
    this.sky.material.uniforms.uTime.value = realTime;
    this.stars.material.uniforms.uTime.value = realTime;
    this.landscape.update(realTime);

    // 1. Water reflection (line widths and star sizes are in the target's pixels).
    this.updateMirror();
    const vp = this.uniforms.uViewport.value;
    const vw = vp.x;
    const vh = vp.y;
    vp.copy(this.reflectSize);
    const r = this.renderer;
    r.setRenderTarget(this.reflectRT);
    r.clear();
    r.render(this.scene, this.mirrorCam);
    r.setRenderTarget(null);
    vp.set(vw, vh);

    // 2. The view itself, bloom and the finishing pass.
    this.composer.render(dt);
  }

  dispose() {
    for (const s of this.systems) s.dispose();
    this.landscape.dispose();
    this.reflectRT.dispose();
    this.composer.dispose?.();
    this.renderer.dispose();
  }
}
