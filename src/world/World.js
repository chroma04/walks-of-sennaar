// Main-thread side of the world: streams blocks from workers, owns their meshes,
// and answers walkability / collision queries for the traveller.

import * as THREE from 'three';
import { BLOCK, BLOCK_SIZE, CELL, STEPS_PER_CELL, K_STAIR, K_BUILDING, K_WATER, DX, DZ } from '../config.js';
import { LAYER_WORLD } from '../render/Renderer.js';

const N = BLOCK;
const STEP_TOL = 0.55;
const DECK_T = 0.55;
const key = (bx, bz) => `${bx},${bz}`;

function ramp(st, k, lx, lz) {
  const o = k * 8;
  const i0 = st[o];
  const j0 = st[o + 1];
  const dir = st[o + 2];
  const n = st[o + 3];
  const hB = st[o + 5];
  const hT = st[o + 6];
  let t;
  if (dir === 0) t = lx - i0 * CELL;
  else if (dir === 2) t = (i0 + 1) * CELL - lx;
  else if (dir === 1) t = lz - j0 * CELL;
  else t = (j0 + 1) * CELL - lz;
  const L = n * CELL;
  const rise = (hT - hB) / (n * STEPS_PER_CELL);
  const h = hB + ((hT - hB) * t) / L + rise * 0.5;
  return Math.max(hB, Math.min(hT, h));
}

function segDist(px, pz, ax, az, bx, bz) {
  const vx = bx - ax;
  const vz = bz - az;
  const l2 = vx * vx + vz * vz;
  let t = l2 > 0 ? ((px - ax) * vx + (pz - az) * vz) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  const dx = px - (ax + vx * t);
  const dz = pz - (az + vz * t);
  return Math.hypot(dx, dz);
}

function segsCross(ax, az, bx, bz, cx, cz, dx, dz) {
  const d1 = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
  const d2 = (bx - ax) * (dz - az) - (bz - az) * (dx - ax);
  const d3 = (dx - cx) * (az - cz) - (dz - cz) * (ax - cx);
  const d4 = (dx - cx) * (bz - cz) - (dz - cz) * (bx - cx);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

// Ground height of a cell (NaN where one cannot stand: buildings, water).
function groundOf(w, c, lx, lz) {
  const k = w.kind[c];
  if (k === K_BUILDING || k === K_WATER) return NaN;
  if (k === K_STAIR) return ramp(w.stairs, w.stairOf[c], lx, lz);
  return w.base[c];
}

// Whether someone at height y in cell c is on the bridge deck rather than the
// ground below it. Without a height, the upper layer wins.
function onDeck(w, c, lx, lz, y) {
  const d = w.deck[c];
  if (d !== d) return false;
  if (y === null || y === undefined) return true;
  const g = groundOf(w, c, lx, lz);
  return g !== g || Math.abs(y - d) <= Math.abs(y - g);
}

// segment of edge d of cell (i, j), in block-local metres
function edgeSeg(i, j, d) {
  const x0 = i * CELL;
  const z0 = j * CELL;
  switch (d) {
    case 0:
      return [x0 + CELL, z0, x0 + CELL, z0 + CELL];
    case 2:
      return [x0, z0, x0, z0 + CELL];
    case 1:
      return [x0, z0 + CELL, x0 + CELL, z0 + CELL];
    default:
      return [x0, z0, x0 + CELL, z0];
  }
}

export class World {
  constructor({ scene, material, seed, onChange }) {
    this.scene = scene;
    this.material = material;
    this.seed = seed >>> 0;
    this.onChange = onChange || (() => {});
    this.blocks = new Map();
    this.pending = new Set();
    this.workers = [];
    this.fallback = null;
    this.nextId = 1;
    this.radius = 90;
    this.fountains = [];
    this.listeners = { add: [], remove: [] };
    const count = Math.max(1, Math.min(3, (navigator.hardwareConcurrency || 4) - 1));
    try {
      for (let k = 0; k < count; k++) {
        const w = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
        w.busy = 0;
        w.onmessage = (e) => this.onWorkerMessage(w, e.data);
        w.onerror = (err) => {
          console.warn('world worker failed, generating on the main thread', err);
          this.useFallback();
        };
        w.postMessage({ type: 'init', seed: this.seed });
        this.workers.push(w);
      }
    } catch (err) {
      console.warn('workers unavailable', err);
      this.useFallback();
    }
  }

  async useFallback() {
    if (this.fallback) return;
    this.fallback = 'loading';
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.pending.clear();
    const { Generator } = await import('./generator.js');
    this.fallback = new Generator(this.seed);
  }

  onWorkerMessage(w, msg) {
    if (msg.type !== 'block') return;
    w.busy--;
    this.addBlock(msg.res);
  }

  isReady(bx, bz) {
    return this.blocks.has(key(bx, bz));
  }

  addBlock(res) {
    const k = key(res.bx, res.bz);
    this.pending.delete(k);
    if (this.blocks.has(k)) return;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(res.geo.pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(res.geo.nor, 3, true));
    g.setAttribute('uv', new THREE.BufferAttribute(res.geo.uv, 2, true));
    g.setAttribute('aMat', new THREE.BufferAttribute(res.geo.mat, 2, false));
    g.setIndex(new THREE.BufferAttribute(res.geo.idx, 1));
    g.boundingBox = computeBox(res.geo.pos);
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const mesh = new THREE.Mesh(g, this.material);
    mesh.position.set(res.bx * BLOCK_SIZE, 0, res.bz * BLOCK_SIZE);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.layers.set(LAYER_WORLD);
    this.scene.add(mesh);
    const walk = res.walk;
    walk.obsGrid = buildObstacleGrid(walk);
    const f = [];
    for (let i = 0; i < res.fountains.length; i += 3) f.push([res.fountains[i] + res.bx * BLOCK_SIZE, res.fountains[i + 1], res.fountains[i + 2] + res.bz * BLOCK_SIZE]);
    const block = { bx: res.bx, bz: res.bz, mesh, walk, fountains: f, spawns: res.spawns || [], program: res.program };
    this.blocks.set(k, block);
    this.refreshFountains();
    this.onChange();
    for (const fn of this.listeners.add) fn(block);
  }

  refreshFountains() {
    this.fountains = [];
    for (const b of this.blocks.values()) this.fountains.push(...b.fountains);
  }

  // Load what is near (x, z); drop what is far.
  update(x, z) {
    const bx0 = Math.floor(x / BLOCK_SIZE);
    const bz0 = Math.floor(z / BLOCK_SIZE);
    const want = [];
    const R = this.radius;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        const bx = bx0 + dx;
        const bz = bz0 + dz;
        const d = rectDist(x, z, bx * BLOCK_SIZE, bz * BLOCK_SIZE);
        if (d <= R) want.push([d, bx, bz]);
      }
    }
    want.sort((a, b) => a[0] - b[0]);
    for (const [, bx, bz] of want) {
      const k = key(bx, bz);
      if (this.blocks.has(k) || this.pending.has(k)) continue;
      if (!this.dispatch(bx, bz)) break;
    }
    let removed = false;
    for (const [k, b] of this.blocks) {
      if (rectDist(x, z, b.bx * BLOCK_SIZE, b.bz * BLOCK_SIZE) > R + 60) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        this.blocks.delete(k);
        removed = true;
        for (const fn of this.listeners.remove) fn(b);
      }
    }
    if (removed) {
      this.refreshFountains();
      this.onChange();
    }
  }

  dispatch(bx, bz) {
    if (this.fallback) {
      if (this.fallback === 'loading' || this.fallbackBusy) return false;
      // one block per frame on the main thread
      this.fallbackBusy = true;
      const k = key(bx, bz);
      this.pending.add(k);
      setTimeout(() => {
        this.fallbackBusy = false;
        this.addBlock(this.fallback.generate(bx, bz));
      }, 0);
      return true;
    }
    const w = this.workers.reduce((a, b) => (a.busy <= b.busy ? a : b), this.workers[0]);
    if (!w || w.busy >= 2) return false;
    w.busy++;
    this.pending.add(key(bx, bz));
    w.postMessage({ type: 'gen', bx, bz, id: this.nextId++ });
    return true;
  }

  // ---------------------------------------------------------------------
  // Queries (world metres)

  locate(x, z) {
    const bx = Math.floor(x / BLOCK_SIZE);
    const bz = Math.floor(z / BLOCK_SIZE);
    const b = this.blocks.get(key(bx, bz));
    if (!b) return null;
    const lx = x - bx * BLOCK_SIZE;
    const lz = z - bz * BLOCK_SIZE;
    const i = Math.min(N - 1, Math.floor(lx / CELL));
    const j = Math.min(N - 1, Math.floor(lz / CELL));
    return { b, lx, lz, i, j, c: j * N + i };
  }

  // Walkable floor height, or NaN. Under a bridge there are two floors; hint
  // (usually the current height) picks the nearer one, and no hint the upper.
  heightAt(x, z, hint = null) {
    const L = this.locate(x, z);
    if (!L) return NaN;
    const w = L.b.walk;
    if (onDeck(w, L.c, L.lx, L.lz, hint)) return w.deck[L.c];
    return groundOf(w, L.c, L.lx, L.lz);
  }

  // 1 on a bridge deck, 0 on the ground (for keeping the two apart in searches).
  layerAt(x, z, y) {
    const L = this.locate(x, z);
    return L && onDeck(L.b.walk, L.c, L.lx, L.lz, y) ? 1 : 0;
  }

  // Whether (x, z) (at height y) lies on the connected network of terraces.
  onNetwork(x, z, y = null) {
    const L = this.locate(x, z);
    if (!L) return false;
    if (onDeck(L.b.walk, L.c, L.lx, L.lz, y)) return true;
    return L.b.walk.reach[L.c] === 1;
  }

  // Whether the point is inside solid masonry (roofs and bridge decks included).
  solidAt(x, y, z) {
    const L = this.locate(x, z);
    if (!L) return false;
    const w = L.b.walk;
    const d = w.deck[L.c];
    if (d === d && y <= d && y >= d - DECK_T) return true;
    const top = w.kind[L.c] === K_STAIR ? ramp(w.stairs, w.stairOf[L.c], L.lx, L.lz) : w.base[L.c];
    return y <= top;
  }

  // Edge flags of the layer someone at height y is on.
  edgeMask(L, y) {
    const w = L.b.walk;
    return onDeck(w, L.c, L.lx, L.lz, y) ? w.dblock[L.c] : w.eblock[L.c];
  }

  nearBarrier(x, z, r, y = null) {
    for (let oz = -1; oz <= 1; oz++) {
      for (let ox = -1; ox <= 1; ox++) {
        const px = x + ox * r;
        const pz = z + oz * r;
        const L = this.locate(px, pz);
        if (!L) continue;
        const m = this.edgeMask(L, y);
        if (!m) continue;
        const bxw = L.b.bx * BLOCK_SIZE;
        const bzw = L.b.bz * BLOCK_SIZE;
        for (let d = 0; d < 4; d++) {
          if (!(m & (1 << d))) continue;
          const s = edgeSeg(L.i, L.j, d);
          if (segDist(x - bxw, z - bzw, s[0], s[1], s[2], s[3]) < r) return true;
        }
      }
    }
    return false;
  }

  crossesBarrier(x0, z0, x1, z1, y = null) {
    const seen = new Set();
    for (const [px, pz] of [[x0, z0], [x1, z1], [x0, z1], [x1, z0]]) {
      const L = this.locate(px, pz);
      if (!L) continue;
      const id = `${L.b.bx},${L.b.bz},${L.c}`;
      if (seen.has(id)) continue;
      seen.add(id);
      const m = this.edgeMask(L, y);
      if (!m) continue;
      const bxw = L.b.bx * BLOCK_SIZE;
      const bzw = L.b.bz * BLOCK_SIZE;
      for (let d = 0; d < 4; d++) {
        if (!(m & (1 << d))) continue;
        const s = edgeSeg(L.i, L.j, d);
        if (segsCross(x0 - bxw, z0 - bzw, x1 - bxw, z1 - bzw, s[0], s[1], s[2], s[3])) return true;
      }
    }
    return false;
  }

  hitsObstacle(x, z, r, y) {
    for (const [px, pz] of [[x, z], [x - r, z - r], [x + r, z + r], [x - r, z + r], [x + r, z - r]]) {
      const L = this.locate(px, pz);
      if (!L) continue;
      const w = L.b.walk;
      const list = w.obsGrid[L.c];
      if (!list) continue;
      const lx = x - L.b.bx * BLOCK_SIZE;
      const lz = z - L.b.bz * BLOCK_SIZE;
      for (const o of list) {
        if (o >= 0) {
          const k = o * 4;
          const c = w.circles;
          if (Math.abs(c[k + 3] - y) > 1.2) continue;
          if (Math.hypot(lx - c[k], lz - c[k + 1]) < c[k + 2] + r) return true;
        } else {
          const k = (-o - 1) * 5;
          const bb = w.boxes;
          if (Math.abs(bb[k + 4] - y) > 1.2) continue;
          const cx = Math.max(bb[k], Math.min(bb[k + 2], lx));
          const cz = Math.max(bb[k + 1], Math.min(bb[k + 3], lz));
          if (Math.hypot(lx - cx, lz - cz) < r) return true;
        }
      }
    }
    return false;
  }

  // Height the traveller would stand at in (x, z), or NaN if they can't.
  // fromY limits the step from where they are; hint picks the layer.
  standAt(x, z, r, fromY = null, hint = fromY) {
    const h = this.heightAt(x, z, hint);
    if (Number.isNaN(h)) return NaN;
    if (fromY !== null && Math.abs(h - fromY) > STEP_TOL) return NaN;
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const hs = this.heightAt(x + Math.cos(a) * r, z + Math.sin(a) * r, h);
      if (Number.isNaN(hs) || Math.abs(hs - h) > STEP_TOL) return NaN;
    }
    if (this.nearBarrier(x, z, r, h)) return NaN;
    if (this.hitsObstacle(x, z, r, h)) return NaN;
    return h;
  }

  canTraverse(x0, z0, y0, x1, z1, r) {
    const h = this.standAt(x1, z1, r, y0);
    if (Number.isNaN(h)) return NaN;
    if (this.crossesBarrier(x0, z0, x1, z1, y0)) return NaN;
    return h;
  }

  // March a ray against the solid heightfield. Returns a point or null.
  raycast(origin, dir, maxT = 400) {
    let prevT = 0;
    let t = 0.5;
    const step = 0.25;
    while (t < maxT) {
      const x = origin.x + dir.x * t;
      const y = origin.y + dir.y * t;
      const z = origin.z + dir.z * t;
      if (this.solidAt(x, y, z)) {
        let a = prevT;
        let b = t;
        for (let k = 0; k < 10; k++) {
          const m = (a + b) / 2;
          const mx = origin.x + dir.x * m;
          const my = origin.y + dir.y * m;
          const mz = origin.z + dir.z * m;
          if (this.solidAt(mx, my, mz)) b = m;
          else a = m;
        }
        return new THREE.Vector3(origin.x + dir.x * b, origin.y + dir.y * b, origin.z + dir.z * b);
      }
      prevT = t;
      t += step * (1 + t * 0.01);
    }
    return null;
  }

  // Spawn near block (0, 0)'s north gate (or another, where that edge is walled
  // off), which leads onto the network.
  spawnPoint(radius) {
    const b = this.blocks.get(key(0, 0));
    if (!b) return null;
    const g = b.walk.gates.find((q) => q.dir === 3) || b.walk.gates[0];
    const x0 = (g.i - DX[g.dir] * 2 + 0.5) * CELL;
    const z0 = (g.j - DZ[g.dir] * 2 + 0.5) * CELL;
    for (let r = 0; r < 16; r += 0.5) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const x = x0 + Math.cos(a) * r;
        const z = z0 + Math.sin(a) * r;
        const h = this.standAt(x, z, radius);
        if (!Number.isNaN(h) && this.onNetwork(x, z, h)) return new THREE.Vector3(x, h, z);
      }
    }
    return null;
  }
}

function rectDist(x, z, rx, rz) {
  const dx = Math.max(rx - x, 0, x - (rx + BLOCK_SIZE));
  const dz = Math.max(rz - z, 0, z - (rz + BLOCK_SIZE));
  return Math.hypot(dx, dz);
}

function computeBox(pos) {
  const min = new THREE.Vector3(Infinity, Infinity, Infinity);
  const max = new THREE.Vector3(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i];
    const y = pos[i + 1];
    const z = pos[i + 2];
    if (x < min.x) min.x = x;
    if (y < min.y) min.y = y;
    if (z < min.z) min.z = z;
    if (x > max.x) max.x = x;
    if (y > max.y) max.y = y;
    if (z > max.z) max.z = z;
  }
  return new THREE.Box3(min, max);
}

// Per-cell lists of obstacle indices (circles >= 0, boxes as -(k+1)).
function buildObstacleGrid(w) {
  const grid = new Array(N * N);
  const add = (x0, z0, x1, z1, id) => {
    const i0 = Math.max(0, Math.floor((x0 - 0.6) / CELL));
    const i1 = Math.min(N - 1, Math.floor((x1 + 0.6) / CELL));
    const j0 = Math.max(0, Math.floor((z0 - 0.6) / CELL));
    const j1 = Math.min(N - 1, Math.floor((z1 + 0.6) / CELL));
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const c = j * N + i;
        (grid[c] || (grid[c] = [])).push(id);
      }
    }
  };
  const c = w.circles;
  for (let k = 0; k < c.length / 4; k++) add(c[k * 4] - c[k * 4 + 2], c[k * 4 + 1] - c[k * 4 + 2], c[k * 4] + c[k * 4 + 2], c[k * 4 + 1] + c[k * 4 + 2], k);
  const b = w.boxes;
  for (let k = 0; k < b.length / 5; k++) add(b[k * 5], b[k * 5 + 1], b[k * 5 + 2], b[k * 5 + 3], -(k + 1));
  return grid;
}
