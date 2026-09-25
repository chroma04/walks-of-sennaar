import * as THREE from 'three';
import { LAYER_WORLD, LAYER_DYNAMIC, LAYER_OVERLAY, LAYER_NPC } from '../render/Renderer.js';

// High, fixed-pitch third-person camera that trails the traveller like the
// game's composed shots; yaw turns in 45 degree steps or freely by dragging.
export class CameraRig {
  constructor() {
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.5, 400);
    this.camera.layers.enable(LAYER_WORLD);
    this.camera.layers.enable(LAYER_DYNAMIC);
    this.camera.layers.enable(LAYER_OVERLAY);
    this.camera.layers.enable(LAYER_NPC);
    this.yaw = Math.PI * 0.2;
    this.targetYaw = this.yaw;
    this.pitch = 0.95;
    this.targetPitch = this.pitch;
    this.dist = 36;
    this.targetDist = 36;
    this.focus = new THREE.Vector3();
    this.focusY = 0;
    this.orbit = 0;
  }

  resize(w, h) {
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  snapTo(p) {
    this.focus.set(p.x, p.y, p.z);
    this.focusY = p.y;
  }

  rotateStep(dir) {
    const step = Math.PI / 4;
    this.targetYaw = Math.round(this.targetYaw / step) * step + dir * step;
  }

  zoom(f) {
    this.targetDist = Math.max(14, Math.min(64, this.targetDist * f));
  }

  update(dt, target, idle = false) {
    const k = (r) => 1 - Math.exp(-dt * r);
    if (idle) this.targetYaw += dt * 0.05;
    this.focus.x += (target.x - this.focus.x) * k(5);
    this.focus.z += (target.z - this.focus.z) * k(5);
    this.focus.y += (target.y - this.focus.y) * k(3.5);
    this.focusY += (target.y - this.focusY) * k(1.6);
    this.yaw += (this.targetYaw - this.yaw) * k(6);
    this.pitch += (this.targetPitch - this.pitch) * k(6);
    this.dist += (this.targetDist - this.dist) * k(5);
    const cp = Math.cos(this.pitch);
    const c = this.camera;
    c.position.set(
      this.focus.x + Math.sin(this.yaw) * cp * this.dist,
      this.focus.y + 0.9 + Math.sin(this.pitch) * this.dist,
      this.focus.z + Math.cos(this.yaw) * cp * this.dist,
    );
    c.lookAt(this.focus.x, this.focus.y + 0.9, this.focus.z);
    c.updateMatrixWorld(true);
  }

  // camera-relative movement basis on the ground plane
  basis() {
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    return { fx, fz, rx: -fz, rz: fx };
  }
}
