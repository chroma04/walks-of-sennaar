// The devotees: robed figures who wander the terraces, kneel before shrines and
// walk in slow processions. Blocks hand over where their devotees start; the
// crowd lives on the main thread, plans short walks with the traveller's own
// path finder and draws everyone with a few instanced meshes.

import * as THREE from 'three';
import { devotee } from '../world/templates.js';
import { findPathSteps } from '../player/pathfind.js';
import { toGeometry, buildFoot } from '../player/Player.js';
import { BLOCK_SIZE } from '../config.js';
import { makeRng } from '../world/rng.js';
import { LAYER_NPC } from '../render/Renderer.js';

export const NPC_RADIUS = 0.34;
const CAP = 384;
const SIM_RANGE = 85; // metres from the traveller within which devotees move
const TRAIL_STEP = 0.12;
const SPACING = 1.45; // between walkers in a procession
const STAND = [1, 2, 3];
const KNEEL = [4, 5];

const key = (bx, bz) => `${bx},${bz}`;
const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));

export class Crowd {
  constructor({ scene, material, world }) {
    this.world = world;
    this.agents = [];
    this.byBlock = new Map();
    this.planQueue = [];
    this.time = 0;
    this.player = null;
    const mk = (tpl) => {
      const m = new THREE.InstancedMesh(toGeometry(tpl), material, CAP);
      m.count = 0;
      m.frustumCulled = false;
      m.layers.set(LAYER_NPC);
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      scene.add(m);
      return m;
    };
    this.standMeshes = STAND.map((s) => mk(devotee(s, 'stand')));
    this.kneelMeshes = KNEEL.map((s) => mk(devotee(s, 'kneel')));
    this.feet = mk(buildFoot());
    this.m = new THREE.Matrix4();
    this.q = new THREE.Quaternion();
    this.e = new THREE.Euler(0, 0, 0, 'YXZ');
    this.v = new THREE.Vector3();
    this.s = new THREE.Vector3(1, 1, 1);
    world.listeners.add.push((b) => this.spawnBlock(b));
    world.listeners.remove.push((b) => this.dropBlock(b));
  }

  spawnBlock(b) {
    const list = [];
    const ox = b.bx * BLOCK_SIZE;
    const oz = b.bz * BLOCK_SIZE;
    let n = 0;
    for (const s of b.spawns) {
      const rng = makeRng(s.seed);
      const at = this.findStand(s.x + ox, s.z + oz, s.y);
      if (!at) continue;
      const lead = this.makeAgent(at, s.rot, s.mode, rng, `${key(b.bx, b.bz)}:${n++}`);
      list.push(lead);
      if (s.mode === 'lead') {
        lead.followers = [];
        lead.trail = [{ x: at.x, y: at.y, z: at.z }];
        lead.trailLen = 0;
        for (let k = 0; k < s.count; k++) {
          const f = this.makeAgent(at, s.rot, 'follow', rng, `${lead.id}/${k}`);
          f.leader = lead;
          f.rank = k + 1;
          lead.followers.push(f);
          list.push(f);
        }
      }
    }
    this.byBlock.set(key(b.bx, b.bz), list);
    this.agents.push(...list);
  }

  dropBlock(b) {
    const list = this.byBlock.get(key(b.bx, b.bz));
    if (!list) return;
    this.byBlock.delete(key(b.bx, b.bz));
    const gone = new Set(list);
    this.agents = this.agents.filter((a) => !gone.has(a));
    this.planQueue = this.planQueue.filter((a) => !gone.has(a));
    if (this.job && gone.has(this.job.g)) this.job = null;
  }

  findStand(x, z, y) {
    for (let r = 0; r <= 1.5; r += 0.25) {
      for (let k = 0; k < (r ? 8 : 1); k++) {
        const a = (k / 8) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        const h = this.world.standAt(px, pz, NPC_RADIUS, null, y);
        if (!Number.isNaN(h) && Math.abs(h - y) < 0.6) return { x: px, y: h, z: pz };
      }
    }
    return null;
  }

  makeAgent(at, rot, mode, rng, id) {
    return {
      id,
      mode,
      x: at.x,
      y: at.y,
      z: at.z,
      heading: rot,
      look: 0, // head-on turn towards something interesting
      variant: Math.floor(rng() * STAND.length),
      kneelVariant: Math.floor(rng() * KNEEL.length),
      pace: mode === 'lead' || mode === 'follow' ? 0.85 : 0.95 + rng() * 0.35,
      speed: 0,
      phase: rng() * 10,
      state: mode === 'pray' ? 'kneel' : 'idle',
      timer: 1 + rng() * (mode === 'pray' ? 30 : 8),
      kneel: mode === 'pray' ? 1 : 0,
      path: null,
      wait: 0,
      stuck: 0,
      rng,
      home: { x: at.x, y: at.y, z: at.z },
    };
  }

  // Player collision: would moving to (x1, z1) push into a devotee?
  blocks(x0, z0, x1, z1, y) {
    const r = NPC_RADIUS + 0.3;
    for (const a of this.agents) {
      if (Math.abs(a.y - y) > 1.5) continue;
      const d1 = Math.hypot(a.x - x1, a.z - z1);
      if (d1 >= r) continue;
      if (d1 < Math.hypot(a.x - x0, a.z - z0)) return true;
    }
    return false;
  }

  update(dt, player) {
    this.time += dt;
    this.player = player;
    const px = player.pos.x;
    const pz = player.pos.z;
    this.planSome(1.5);
    for (const g of this.agents) {
      g.near = Math.hypot(g.x - px, g.z - pz) < SIM_RANGE;
      if (!g.near || g.mode === 'follow') continue;
      this.think(g, dt);
    }
    for (const g of this.agents) if (g.mode === 'follow' && g.leader.near) this.trailFollow(g, dt);
    this.draw();
  }

  think(g, dt) {
    const p = this.player;
    const dp = Math.hypot(p.pos.x - g.x, p.pos.z - g.z);
    // idle devotees turn their heads to a traveller passing close by
    const want = dp < 5 && Math.abs(p.y - g.y) < 2 && g.state !== 'walk' ? wrap(Math.atan2(p.pos.x - g.x, p.pos.z - g.z) - g.heading) : 0;
    g.look += (Math.max(-1.1, Math.min(1.1, want)) - g.look) * (1 - Math.exp(-dt * 3));
    if (g.state === 'walk') return this.walk(g, dt);
    g.speed *= Math.exp(-dt * 8);
    g.timer -= dt;
    if (g.state === 'kneel') {
      g.kneel = Math.min(1, g.kneel + dt * 1.5);
      if (g.timer > 0) return;
      g.state = 'idle';
      g.timer = 3 + g.rng() * 6;
      return;
    }
    g.kneel = Math.max(0, g.kneel - dt * 1.5);
    if (g.timer > 0 || g.planning) return;
    const r = g.rng();
    if (g.mode === 'pray') {
      g.state = 'kneel';
      g.timer = 20 + g.rng() * 40;
    } else if (g.mode === 'still' && r < 0.6) {
      g.timer = 6 + g.rng() * 14;
      g.heading += (g.rng() - 0.5) * 1.6;
    } else if (g.mode === 'wander' && r < 0.12) {
      g.state = 'kneel';
      g.timer = 8 + g.rng() * 14;
    } else this.chooseGoal(g);
  }

  chooseGoal(g) {
    const lead = g.mode === 'lead';
    const w = this.world;
    for (let k = 0; k < 12; k++) {
      const a = g.rng() * Math.PI * 2;
      const r = lead ? 10 + g.rng() * 14 : 3 + g.rng() * (g.mode === 'still' ? 5 : 10);
      // wanderers drift back towards home rather than away for ever
      const bx = lead ? g.x : (g.x + g.home.x) / 2;
      const bz = lead ? g.z : (g.z + g.home.z) / 2;
      const x = bx + Math.sin(a) * r;
      const z = bz + Math.cos(a) * r;
      const h = w.standAt(x, z, NPC_RADIUS + 0.15, null, g.y);
      if (Number.isNaN(h) || !w.onNetwork(x, z, h)) continue;
      g.goal = { x, y: h, z };
      g.planning = true;
      this.planQueue.push(g);
      return;
    }
    g.timer = 2 + g.rng() * 3;
  }

  // Short hops across open ground need no search.
  straight(g, goal) {
    const d = Math.hypot(goal.x - g.x, goal.z - g.z);
    const n = Math.ceil(d / 0.35);
    let x = g.x;
    let z = g.z;
    let y = g.y;
    for (let k = 1; k <= n; k++) {
      const nx = g.x + ((goal.x - g.x) * k) / n;
      const nz = g.z + ((goal.z - g.z) * k) / n;
      const h = this.world.canTraverse(x, z, y, nx, nz, NPC_RADIUS + 0.1);
      if (Number.isNaN(h)) return null;
      [x, y, z] = [nx, h, nz];
    }
    return { points: [{ x, y, z }], complete: true };
  }

  // Path searches run one at a time, a little each frame.
  planSome(budgetMs) {
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      if (!this.job) {
        const g = this.planQueue.shift();
        if (!g) return;
        if (!g.goal) {
          g.planning = false;
          continue;
        }
        const quick = this.straight(g, g.goal);
        if (quick) {
          this.start(g, quick);
          continue;
        }
        this.job = { g, it: findPathSteps(this.world, { x: g.x, y: g.y, z: g.z }, g.goal, NPC_RADIUS, g.mode === 'lead' ? 2400 : 1000, 25) };
      }
      const r = this.job.it.next();
      if (r.done) {
        const { g } = this.job;
        this.job = null;
        this.start(g, r.value);
      }
    }
  }

  start(g, res) {
    g.planning = false;
    g.goal = null;
    if (!this.agents.includes(g)) return;
    if (!res || !res.points.length || (!res.complete && res.points.length < 2)) {
      g.timer = 2 + g.rng() * 4;
      return;
    }
    g.path = res.points;
    g.state = 'walk';
    g.stuck = 0;
    g.wait = 0;
  }

  // Someone standing in the way ahead (the traveller or another devotee).
  obstructed(g, dx, dz) {
    const probe = (x, z, y, r) => {
      const ox = x - g.x;
      const oz = z - g.z;
      const d = Math.hypot(ox, oz);
      return Math.abs(y - g.y) < 1.5 && d < r && (ox * dx + oz * dz) / (d || 1) > 0.35;
    };
    const p = this.player;
    if (probe(p.pos.x, p.pos.z, p.y, 1.25)) return true;
    for (const o of this.agents) {
      if (o === g || !o.near || o.leader === g || (g.leader && g.leader === o.leader) || o === g.leader) continue;
      if (probe(o.x, o.z, o.y, 1.0)) return true;
    }
    // a procession halts when the traveller steps into the line
    if (g.followers) for (const f of g.followers) if (Math.abs(p.y - f.y) < 1.5 && Math.hypot(p.pos.x - f.x, p.pos.z - f.z) < 0.9) return true;
    return false;
  }

  walk(g, dt) {
    g.kneel = Math.max(0, g.kneel - dt * 2);
    let wp = g.path[0];
    while (wp && Math.hypot(wp.x - g.x, wp.z - g.z) < (g.path.length > 1 ? 0.4 : 0.15)) {
      g.path.shift();
      wp = g.path[0];
    }
    if (!wp) return this.arrive(g);
    const dx = wp.x - g.x;
    const dz = wp.z - g.z;
    const d = Math.hypot(dx, dz);
    const ux = dx / d;
    const uz = dz / d;
    const turn = wrap(Math.atan2(ux, uz) - g.heading);
    g.heading += turn * (1 - Math.exp(-dt * 5));
    if (this.obstructed(g, ux, uz)) {
      g.speed *= Math.exp(-dt * 10);
      g.wait += dt;
      if (g.wait > 4) {
        g.path = null;
        return this.arrive(g);
      }
      return;
    }
    g.wait = Math.max(0, g.wait - dt);
    // slow down to turn and near the end
    const target = g.pace * Math.max(0.25, Math.cos(Math.min(Math.PI / 2, Math.abs(turn)))) * (g.path.length === 1 ? Math.min(1, d / 0.8 + 0.3) : 1);
    g.speed += (target - g.speed) * (1 - Math.exp(-dt * 4));
    const step = Math.min(d, g.speed * dt);
    const moved = this.move(g, ux * step, uz * step);
    if (moved < step * 0.3 && step > 1e-4) {
      g.stuck += dt;
      if (g.stuck > 1.2) {
        g.path = null;
        return this.arrive(g);
      }
    } else g.stuck = Math.max(0, g.stuck - dt);
    g.phase += (moved / 0.62) * Math.PI;
    if (g.trail) this.record(g);
  }

  move(g, dx, dz) {
    const w = this.world;
    for (const [ax, az] of [[dx, dz], [dx, 0], [0, dz]]) {
      if (Math.abs(ax) + Math.abs(az) < 1e-6) continue;
      const h = w.canTraverse(g.x, g.z, g.y, g.x + ax, g.z + az, NPC_RADIUS);
      if (Number.isNaN(h)) continue;
      g.x += ax;
      g.z += az;
      g.y += (h - g.y) * 0.5;
      g.y = Math.abs(h - g.y) < 0.02 ? h : g.y;
      return Math.hypot(ax, az);
    }
    return 0;
  }

  arrive(g) {
    g.state = 'idle';
    g.path = null;
    g.timer = g.mode === 'lead' ? 3 + g.rng() * 5 : 2 + g.rng() * 8;
  }

  record(g) {
    const t = g.trail;
    const last = t[t.length - 1];
    const d = Math.hypot(g.x - last.x, g.z - last.z);
    if (d < TRAIL_STEP) return;
    t.push({ x: g.x, y: g.y, z: g.z });
    g.trailLen += d;
    const keep = Math.ceil(((g.followers.length + 1) * SPACING) / TRAIL_STEP) + 8;
    if (t.length > keep) t.splice(0, t.length - keep);
  }

  // Followers walk exactly where their leader walked, a fixed distance behind.
  trailFollow(f, dt) {
    const L = f.leader;
    const t = L.trail;
    let want = f.rank * SPACING;
    let x = L.x;
    let y = L.y;
    let z = L.z;
    for (let k = t.length - 1; k >= 0 && want > 0; k--) {
      const d = Math.hypot(t[k].x - x, t[k].z - z);
      if (d >= want) {
        const s = want / d;
        x += (t[k].x - x) * s;
        y += (t[k].y - y) * s;
        z += (t[k].z - z) * s;
        want = 0;
        break;
      }
      want -= d;
      x = t[k].x;
      y = t[k].y;
      z = t[k].z;
    }
    const mx = x - f.x;
    const mz = z - f.z;
    const moved = Math.hypot(mx, mz);
    if (moved > 1e-4) {
      const turn = wrap(Math.atan2(mx, mz) - f.heading);
      f.heading += turn * (1 - Math.exp(-dt * 6));
    }
    f.x = x;
    f.z = z;
    f.y = y;
    f.speed += (moved / Math.max(dt, 1e-4) - f.speed) * (1 - Math.exp(-dt * 6));
    f.phase += (moved / 0.62) * Math.PI;
    f.kneel = 0;
  }

  draw() {
    const counts = new Array(this.standMeshes.length + this.kneelMeshes.length).fill(0);
    let feet = 0;
    const { m, q, e, v, s } = this;
    for (const g of this.agents) {
      const amp = Math.min(1, g.speed / 1.1);
      const sn = Math.sin(g.phase);
      const cs = Math.cos(g.phase);
      const breathe = Math.sin(this.time * 1.5 + g.phase) * 0.008 * (1 - amp);
      const kneeling = g.kneel > 0.5;
      // a slow bow every few breaths while kneeling
      const bow = kneeling ? Math.max(0, Math.sin(this.time * 0.45 + g.phase)) ** 3 * 0.45 : 0;
      e.set(0.05 * amp + bow, g.heading + g.look * 0.35, sn * 0.035 * amp);
      q.setFromEuler(e);
      v.set(g.x, g.y + Math.abs(sn) * 0.035 * amp + breathe, g.z);
      m.compose(v, q, s);
      const idx = kneeling ? this.standMeshes.length + g.kneelVariant : g.variant;
      const mesh = kneeling ? this.kneelMeshes[g.kneelVariant] : this.standMeshes[g.variant];
      if (counts[idx] < CAP) mesh.setMatrixAt(counts[idx]++, m);
      if (kneeling || amp < 0.05 || feet > CAP - 2) continue;
      // feet peep out under the hem in step
      const c = Math.cos(g.heading);
      const sh = Math.sin(g.heading);
      for (const [side, fw, lift] of [[-1, sn, Math.max(0, cs)], [1, -sn, Math.max(0, -cs)]]) {
        const lx = side * 0.12;
        const lz = 0.12 + fw * 0.26 * amp;
        v.set(g.x + c * lx + sh * lz, g.y + lift * 0.06 * amp, g.z - sh * lx + c * lz);
        e.set(0, g.heading, 0);
        q.setFromEuler(e);
        m.compose(v, q, s);
        this.feet.setMatrixAt(feet++, m);
      }
    }
    [...this.standMeshes, ...this.kneelMeshes].forEach((mesh, k) => {
      mesh.count = counts[k];
      mesh.instanceMatrix.needsUpdate = true;
    });
    this.feet.count = feet;
    this.feet.instanceMatrix.needsUpdate = true;
  }
}

