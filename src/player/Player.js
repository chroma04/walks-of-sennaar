// The traveller: a hooded, red-robed figure with a pale mask, plus movement,
// collision response and a procedural walk cycle.

import * as THREE from 'three';
import { GeoBuilder, T } from '../world/geometry.js';
import { M } from '../config.js';
import { LAYER_DYNAMIC } from '../render/Renderer.js';

export const RADIUS = 0.3;

function toGeometry(tpl) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(tpl.pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(tpl.nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(tpl.uv, 2));
  g.setAttribute('aMat', new THREE.BufferAttribute(tpl.mat, 2, false));
  g.setIndex(new THREE.BufferAttribute(tpl.idx, 1));
  g.computeBoundingSphere();
  return g;
}

const ELLIPSOID = [[0.0, -1], [0.7, -0.72], [0.97, -0.25], [0.97, 0.25], [0.7, 0.72], [0, 1]];

function ellipsoid(b, x, y, z, sx, sy, sz, segs = 10) {
  b.withTransform(T.chain(T.translate(x, y, z), T.scale(sx, sy, sz)), () => b.lathe(ELLIPSOID, segs));
}

function buildBody() {
  const b = new GeoBuilder(2048);
  b.m = M.ROBE;
  b.lathe([[0.36, 0.02], [0.355, 0.07], [0.31, 0.45], [0.265, 0.85], [0.235, 1.1], [0.225, 1.26], [0.19, 1.37], [0.1, 1.43], [0.0, 1.45]], 14);
  // hood
  b.lathe([[0.16, 1.32], [0.205, 1.42], [0.205, 1.56], [0.18, 1.7], [0.13, 1.8], [0.05, 1.86], [0.0, 1.87]], 14);
  // hood tip falling back
  b.withTransform(T.chain(T.translate(0, 1.76, -0.08), T.rotX(-1.05)), () => b.lathe([[0.1, 0], [0.07, 0.12], [0.0, 0.26]], 8));
  // face opening, mask and eye slit
  b.m = M.DARK;
  ellipsoid(b, 0, 1.58, 0.13, 0.125, 0.15, 0.085);
  b.m = M.MASK;
  ellipsoid(b, 0, 1.575, 0.155, 0.1, 0.125, 0.075);
  b.m = M.DARK;
  b.box(-0.065, 1.595, 0.215, 0.065, 1.615, 0.235, 0b010111);
  // sash and satchel
  b.m = M.CREAM;
  b.lathe([[0.258, 0.9], [0.268, 0.95], [0.262, 1.0]], 14);
  b.withTransform(T.chain(T.rotY(0.6), T.rotZ(0.5)), () => {
    b.box(-0.03, 0.92, 0.2, 0.03, 1.45, 0.25, 0b010111);
  });
  b.m = M.GLYPH;
  b.box(0.22, 0.72, -0.1, 0.33, 0.95, 0.12, 0b111111);
  b.m = M.CREAM;
  b.box(0.215, 0.9, -0.105, 0.335, 0.94, 0.125, 0b010111);
  return b.freeze();
}

function buildArm() {
  const b = new GeoBuilder(512);
  b.m = M.ROBE;
  // hangs from the origin (shoulder) downwards
  b.lathe([[0.0, 0.02], [0.075, 0.0], [0.085, -0.25], [0.1, -0.52], [0.0, -0.58]], 8);
  b.m = M.MASK;
  ellipsoid(b, 0, -0.6, 0.02, 0.05, 0.06, 0.05, 8);
  return b.freeze();
}

function buildFoot() {
  const b = new GeoBuilder(256);
  b.m = M.DARK;
  ellipsoid(b, 0, 0.05, 0.05, 0.075, 0.05, 0.13, 8);
  return b.freeze();
}

export class Player {
  constructor(material) {
    this.group = new THREE.Group();
    this.body = new THREE.Group();
    this.group.add(this.body);
    const mk = (tpl) => {
      const m = new THREE.Mesh(toGeometry(tpl), material);
      m.layers.set(LAYER_DYNAMIC);
      return m;
    };
    this.robe = mk(buildBody());
    this.body.add(this.robe);
    const arm = buildArm();
    this.armL = mk(arm);
    this.armR = mk(arm);
    this.armL.position.set(-0.24, 1.33, 0);
    this.armR.position.set(0.24, 1.33, 0);
    this.armL.rotation.z = 0.12;
    this.armR.rotation.z = -0.12;
    this.body.add(this.armL, this.armR);
    const foot = buildFoot();
    this.footL = mk(foot);
    this.footR = mk(foot);
    this.group.add(this.footL, this.footR);

    this.pos = new THREE.Vector3();
    this.y = 0;
    this.vel = new THREE.Vector2();
    this.heading = 0;
    this.phase = 0;
    this.speed = 0;
    this.stepCount = 0;
    this.onStep = null;
    this.time = 0;
  }

  place(p) {
    this.pos.copy(p);
    this.y = p.y;
    this.vel.set(0, 0);
    this.sync();
  }

  // desired: THREE.Vector2 velocity in m/s (world XZ)
  update(dt, desired, world) {
    this.time += dt;
    const k = 1 - Math.exp(-dt * 14);
    this.vel.x += (desired.x - this.vel.x) * k;
    this.vel.y += (desired.y - this.vel.y) * k;
    let dx = this.vel.x * dt;
    let dz = this.vel.y * dt;
    const dist = Math.hypot(dx, dz);
    let moved = 0;
    if (dist > 1e-5) {
      const n = Math.max(1, Math.ceil(dist / 0.15));
      dx /= n;
      dz /= n;
      for (let s = 0; s < n; s++) {
        const r = this.tryMove(dx, dz, world);
        moved += r;
        if (r === 0) break;
      }
    }
    // an obstructed traveller slows down instead of pushing into walls
    if (dt > 0) {
      const actual = moved / dt;
      const want = this.vel.length();
      if (want > 0.01 && actual < want * 0.5) this.vel.multiplyScalar(0.6);
    }
    const target = world.heightAt(this.pos.x, this.pos.z);
    if (!Number.isNaN(target)) this.y += (target - this.y) * (1 - Math.exp(-dt * 16));

    const sp = Math.hypot(desired.x, desired.y) > 0.01 ? moved / Math.max(dt, 1e-4) : this.speed * Math.exp(-dt * 8);
    this.speed += (sp - this.speed) * (1 - Math.exp(-dt * 10));
    if (Math.hypot(desired.x, desired.y) > 0.05) {
      const want = Math.atan2(desired.x, desired.y);
      let d = want - this.heading;
      d = Math.atan2(Math.sin(d), Math.cos(d));
      this.heading += d * (1 - Math.exp(-dt * 11));
    }
    const prev = this.phase;
    this.phase += (moved / 0.72) * Math.PI;
    if (Math.floor(prev / Math.PI) !== Math.floor(this.phase / Math.PI)) {
      this.stepCount++;
      if (this.onStep) this.onStep(this.speed);
    }
    this.sync();
  }

  tryMove(dx, dz, world) {
    const x = this.pos.x;
    const z = this.pos.z;
    // straight ahead, then slide along walls (axis-aligned) and round
    // obstacles and corners (angled)
    const attempts = [[dx, dz], [dx, 0], [0, dz]];
    for (const a of [0.6, -0.6, 1.1, -1.1]) {
      const c = Math.cos(a);
      const s = Math.sin(a);
      attempts.push([(dx * c - dz * s) * c, (dx * s + dz * c) * c]);
    }
    for (const [ax, az] of attempts) {
      if (Math.abs(ax) < 1e-6 && Math.abs(az) < 1e-6) continue;
      const h = world.canTraverse(x, z, this.y, x + ax, z + az, RADIUS);
      if (!Number.isNaN(h)) {
        this.pos.x = x + ax;
        this.pos.z = z + az;
        return Math.hypot(ax, az);
      }
    }
    return 0;
  }

  sync() {
    const g = this.group;
    g.position.set(this.pos.x, this.y, this.pos.z);
    g.rotation.y = this.heading;
    const run = Math.min(1, Math.max(0, (this.speed - 2.4) / 2));
    const amp = Math.min(1, this.speed / 2.0);
    const s = Math.sin(this.phase);
    const c = Math.cos(this.phase);
    const breathe = Math.sin(this.time * 1.7) * 0.006 * (1 - amp);
    this.body.position.y = Math.abs(s) * 0.045 * amp + breathe;
    this.body.rotation.x = 0.06 * amp + run * 0.1;
    this.body.rotation.z = s * 0.025 * amp;
    this.armL.rotation.x = s * 0.55 * amp;
    this.armR.rotation.x = -s * 0.55 * amp;
    this.footL.position.set(-0.11, Math.max(0, c) * 0.07 * amp, s * 0.22 * amp);
    this.footR.position.set(0.11, Math.max(0, -c) * 0.07 * amp, -s * 0.22 * amp);
    this.group.updateMatrixWorld(true);
  }
}
