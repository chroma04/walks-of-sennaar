// Full block pipeline (structure -> decoration -> mesh), with a small cache of
// neighbouring structures. Runs inside a worker, or on the main thread as a
// fallback when workers are unavailable.

import { BLOCK, BLOCK_SIZE } from '../config.js';
import { generateStructure } from './layout.js';
import { decorate } from './decorate.js';
import { meshBlock } from './mesher.js';
import { buildTemplates } from './templates.js';

const N = BLOCK;

export class Generator {
  constructor(seed) {
    this.seed = seed >>> 0;
    this.cache = new Map();
    this.templates = null;
  }

  structure(bx, bz) {
    const key = `${bx},${bz}`;
    let s = this.cache.get(key);
    if (s) {
      this.cache.delete(key);
      this.cache.set(key, s);
      return s;
    }
    s = generateStructure(this.seed, bx, bz);
    this.cache.set(key, s);
    if (this.cache.size > 80) this.cache.delete(this.cache.keys().next().value);
    return s;
  }

  lookFor(bx, bz) {
    return (i, j) => {
      const ox = Math.floor(i / N);
      const oz = Math.floor(j / N);
      const S = ox === 0 && oz === 0 ? this.structure(bx, bz) : this.structure(bx + ox, bz + oz);
      const li = i - ox * N;
      const lj = j - oz * N;
      const c = lj * N + li;
      const si = S.stairOf[c];
      return {
        kind: S.kind[c],
        base: S.base[c],
        plot: S.plotId[c],
        bx: bx + ox,
        bz: bz + oz,
        stair: si >= 0 ? S.stairs[si] : null,
        deck: S.deck[c],
        ox: ox * BLOCK_SIZE,
        oz: oz * BLOCK_SIZE,
      };
    };
  }

  generate(bx, bz) {
    if (!this.templates) this.templates = buildTemplates();
    const S = this.structure(bx, bz);
    const look = this.lookFor(bx, bz);
    const D = decorate(S, look);
    const { geo: raw, eblock } = meshBlock(S, D, look, this.templates);
    const geo = pack(raw);
    const stairs = new Float32Array(S.stairs.length * 8);
    S.stairs.forEach((s, k) => stairs.set([s.i0, s.j0, s.dir, s.n, s.w, s.hB, s.hT, 0], k * 8));
    const reach = new Uint8Array(N * N);
    for (let c = 0; c < N * N; c++) reach[c] = S.plots[S.plotId[c]].reachable && !S.plots[S.plotId[c]].building ? 1 : 0;
    const walk = {
      reach,
      kind: S.kind,
      base: S.base,
      stairOf: S.stairOf,
      stairs,
      eblock,
      deck: S.deck,
      dblock: S.dblock,
      circles: new Float32Array(D.circles.flat()),
      boxes: new Float32Array(D.boxes.flat()),
      gates: S.gates.map((g) => ({ i: g.i, j: g.j, dir: g.dir, level: g.level })),
    };
    let fountains = [];
    const splashing = new Set(['fountain', 'pool', 'spout', 'basin', 'rill', 'wallfountain', 'weir', 'sluice']);
  for (const f of D.feats) if (splashing.has(f.t) || (f.t === 'culvert' && f.pour)) fountains.push(f.x, f.y, f.z);
    fountains = new Float32Array(fountains);
    return { bx, bz, geo, walk, fountains, spawns: D.spawns, program: S.program, failed: S.failedLinks };
  }
}

// Compact vertex format: float positions, byte normals, 16-bit uvs.
function pack(g) {
  const nor = new Int8Array(g.nor.length);
  for (let i = 0; i < nor.length; i++) nor[i] = Math.max(-127, Math.min(127, Math.round(g.nor[i] * 127)));
  const uv = new Uint16Array(g.uv.length);
  for (let i = 0; i < uv.length; i++) uv[i] = Math.max(0, Math.min(65535, Math.round(g.uv[i] * 65535)));
  return { pos: g.pos, nor, uv, mat: g.mat, idx: g.idx, count: g.count };
}

export function transferables(res) {
  const g = res.geo;
  const w = res.walk;
  return [g.pos.buffer, g.nor.buffer, g.uv.buffer, g.mat.buffer, g.idx.buffer, w.reach.buffer, w.kind.buffer, w.base.buffer, w.stairOf.buffer, w.stairs.buffer, w.eblock.buffer, w.deck.buffer, w.dblock.buffer, w.circles.buffer, w.boxes.buffer, res.fountains.buffer];
}
