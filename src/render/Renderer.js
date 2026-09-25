import * as THREE from 'three';
import { PALETTE, WALL_LIT, WALL_SHADE, SUN_DIR, DEPTH_ORANGE, DEPTH_MAGENTA, INK, SKY_TOP, SKY_BOTTOM } from '../config.js';
import { worldVertex, worldFragment, depthVertex, depthFragment, fullscreenVertex, compositeFragment } from './shaders.js';

export const LAYER_WORLD = 1;
export const LAYER_DYNAMIC = 2;
export const LAYER_OVERLAY = 3;
export const LAYER_NPC = 4;

const BIAS = new THREE.Matrix4().set(0.5, 0, 0, 0.5, 0, 0.5, 0, 0.5, 0, 0, 0.5, 0.5, 0, 0, 0, 1);

function depthTarget(size) {
  const depthTexture = new THREE.DepthTexture(size, size);
  depthTexture.type = THREE.UnsignedIntType;
  return new THREE.WebGLRenderTarget(size, size, { depthBuffer: true, depthTexture, generateMipmaps: false });
}

export class Renderer {
  constructor(canvas) {
    THREE.ColorManagement.enabled = false;
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, stencil: false, powerPreference: 'high-performance' });
    r.outputColorSpace = THREE.LinearSRGBColorSpace;
    r.setClearColor(0x000000, 1);
    this.r = r;
    this.sun = new THREE.Vector3(...SUN_DIR).normalize();

    this.staticSize = 2048;
    this.staticRT = depthTarget(this.staticSize);
    this.dynSize = 512;
    this.dynRT = depthTarget(this.dynSize);
    // devotees move, so they get their own map in the static light frame
    this.npcRT = depthTarget(this.staticSize);
    this.staticCam = new THREE.OrthographicCamera(-50, 50, 50, -50, 1, 400);
    this.staticCam.layers.set(LAYER_WORLD);
    this.dynCam = new THREE.OrthographicCamera(-3.5, 3.5, 3.5, -3.5, 1, 400);
    this.dynCam.layers.set(LAYER_DYNAMIC);
    this.depthMaterial = new THREE.ShaderMaterial({ vertexShader: depthVertex, fragmentShader: depthFragment });
    this.staticKey = '';
    this.staticDirty = true;
    this.staticMatrix = new THREE.Matrix4();
    this.dynMatrix = new THREE.Matrix4();

    this.samples = 0;
    this.mainRT = this.makeMain(1, 1);

    const pal = [];
    for (const [lit, shade] of PALETTE) pal.push(new THREE.Vector3(...lit), new THREE.Vector3(...shade));
    this.uniforms = {
      uPalette: { value: pal },
      uWallLit: { value: new THREE.Vector3(...WALL_LIT) },
      uWallShade: { value: new THREE.Vector3(...WALL_SHADE) },
      uSunDir: { value: this.sun },
      uShadowMap: { value: this.staticRT.depthTexture },
      uShadowMatrix: { value: this.staticMatrix },
      uShadowTexel: { value: new THREE.Vector2(1 / this.staticSize, 1 / this.staticSize) },
      uDynShadowMap: { value: this.dynRT.depthTexture },
      uDynShadowMatrix: { value: this.dynMatrix },
      uDynShadowTexel: { value: new THREE.Vector2(1 / this.dynSize, 1 / this.dynSize) },
      uNpcShadowMap: { value: this.npcRT.depthTexture },
      uFocusY: { value: 0 },
      uTime: { value: 0 },
      uCut: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCutY: { value: 0 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uDepthA: { value: new THREE.Vector3(...DEPTH_ORANGE) },
      uDepthB: { value: new THREE.Vector3(...DEPTH_MAGENTA) },
      uFog: { value: new THREE.Vector3(0.93, 0.55, 0.42) },
      uFogRange: { value: new THREE.Vector2(110, 190) },
    };
    this.worldMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      vertexShader: worldVertex,
      fragmentShader: worldFragment,
      side: THREE.FrontSide,
    });
    // same shader and uniforms for the traveller, minus the occlusion cut
    this.playerMaterial = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: this.uniforms,
      defines: { NO_CUT: '' },
      vertexShader: worldVertex,
      fragmentShader: worldFragment,
      side: THREE.FrontSide,
    });

    this.post = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3,
      uniforms: {
        tColor: { value: this.mainRT.textures[0] },
        tNormal: { value: this.mainRT.textures[1] },
        tDepth: { value: this.mainRT.depthTexture },
        uTexel: { value: new THREE.Vector2(1, 1) },
        uNear: { value: 0.5 },
        uFar: { value: 400 },
        uLine: { value: 1 },
        uInk: { value: new THREE.Vector3(...INK) },
        uSkyTop: { value: new THREE.Vector3(...SKY_TOP) },
        uSkyBottom: { value: new THREE.Vector3(...SKY_BOTTOM) },
        uTime: { value: 0 },
        uCut: this.uniforms.uCut,
        uResolution: this.uniforms.uResolution,
      },
      vertexShader: fullscreenVertex,
      fragmentShader: compositeFragment,
      depthTest: false,
      depthWrite: false,
    });
    const tri = new THREE.BufferGeometry();
    tri.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.postMesh = new THREE.Mesh(tri, this.post);
    this.postMesh.frustumCulled = false;
    this.postScene = new THREE.Scene();
    this.postScene.add(this.postMesh);
    this.postCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this.tmp = new THREE.Vector3();
    this.setQuality(1);
  }

  makeMain(w, h) {
    const depthTexture = new THREE.DepthTexture(w, h);
    depthTexture.type = THREE.UnsignedIntType;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      count: 2,
      depthBuffer: true,
      depthTexture,
      samples: this.samples,
      generateMipmaps: false,
      minFilter: THREE.NearestFilter,
      magFilter: THREE.NearestFilter,
    });
    return rt;
  }

  setQuality(scale) {
    this.quality = scale;
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2) * this.quality;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.r.setPixelRatio(dpr);
    this.r.setSize(w, h, true);
    const bw = Math.max(1, Math.floor(w * dpr));
    const bh = Math.max(1, Math.floor(h * dpr));
    // multisampling only where pixels are big; dense displays don't need it
    const samples = dpr >= 1.75 ? 0 : 4;
    if (samples !== this.samples) {
      this.samples = samples;
      this.mainRT.depthTexture?.dispose();
      this.mainRT.dispose();
      this.mainRT = this.makeMain(bw, bh);
      this.post.uniforms.tColor.value = this.mainRT.textures[0];
      this.post.uniforms.tNormal.value = this.mainRT.textures[1];
      this.post.uniforms.tDepth.value = this.mainRT.depthTexture;
    }
    this.mainRT.setSize(bw, bh);
    this.uniforms.uResolution.value.set(bw, bh);
    this.post.uniforms.uTexel.value.set(1 / bw, 1 / bh);
    this.post.uniforms.uLine.value = dpr >= 1.75 ? 1.5 : 1.0;
  }

  markStaticDirty() {
    this.staticDirty = true;
  }

  placeLightCam(cam, center, half, size, snap) {
    const z = this.sun;
    const x = this.tmp.set(0, 1, 0).cross(z).normalize().clone();
    const y = new THREE.Vector3().crossVectors(z, x);
    const texel0 = (2 * half) / size;
    const texel = snap ? Math.max(1, Math.round(snap / texel0)) * texel0 : texel0;
    const cx = Math.round(center.dot(x) / texel) * texel;
    const cy = Math.round(center.dot(y) / texel) * texel;
    // snapped too, so a frame that keeps the key keeps the whole light frame:
    // the devotees' map is drawn every frame against the cached matrix
    const cz = snap ? Math.round(center.dot(z) / 8) * 8 : center.dot(z);
    const c = new THREE.Vector3().addScaledVector(x, cx).addScaledVector(y, cy).addScaledVector(z, cz);
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = 400;
    cam.updateProjectionMatrix();
    cam.position.copy(c).addScaledVector(z, 200);
    cam.up.copy(y);
    cam.lookAt(c);
    cam.updateMatrixWorld(true);
    return `${cx.toFixed(2)},${cy.toFixed(2)},${cz.toFixed(2)},${half}`;
  }

  render(scene, camera, info) {
    const r = this.r;
    const u = this.uniforms;
    u.uTime.value = info.time;
    u.uFocusY.value = info.focusY;
    this.post.uniforms.uTime.value = info.time;
    this.post.uniforms.uNear.value = camera.near;
    this.post.uniforms.uFar.value = camera.far;

    // occlusion cut-out around the traveller
    const p = this.tmp.copy(info.player).setY(info.player.y + 1.0).project(camera);
    const vz = info.player.clone().applyMatrix4(camera.matrixWorldInverse).z;
    const tanH = Math.tan((camera.fov * Math.PI) / 360);
    u.uCut.value.set(p.x, p.y, -vz, info.cut ? 1.55 / (-vz * tanH) : 0);
    u.uCutY.value = info.player.y;

    // static shadow map: re-rendered when the light frame moves a coarse step
    const half = info.shadowHalf;
    const key = this.placeLightCam(this.staticCam, info.focus, half, this.staticSize, 6);
    if (key !== this.staticKey || this.staticDirty) {
      this.staticKey = key;
      this.staticDirty = false;
      this.staticMatrix.multiplyMatrices(BIAS, this.staticCam.projectionMatrix).multiply(this.staticCam.matrixWorldInverse);
      scene.overrideMaterial = this.depthMaterial;
      r.setRenderTarget(this.staticRT);
      r.clear();
      r.render(scene, this.staticCam);
    }
    // devotees' shadows, in the same frame as the static map
    this.staticCam.layers.set(LAYER_NPC);
    scene.overrideMaterial = this.depthMaterial;
    r.setRenderTarget(this.npcRT);
    r.clear();
    r.render(scene, this.staticCam);
    this.staticCam.layers.set(LAYER_WORLD);
    // dynamic (traveller) shadow
    this.placeLightCam(this.dynCam, info.player, 3.5, this.dynSize);
    this.dynMatrix.multiplyMatrices(BIAS, this.dynCam.projectionMatrix).multiply(this.dynCam.matrixWorldInverse);
    scene.overrideMaterial = this.depthMaterial;
    r.setRenderTarget(this.dynRT);
    r.clear();
    r.render(scene, this.dynCam);
    scene.overrideMaterial = null;

    r.setRenderTarget(this.mainRT);
    r.clear();
    r.render(scene, camera);

    r.setRenderTarget(null);
    r.render(this.postScene, this.postCam);
  }
}
