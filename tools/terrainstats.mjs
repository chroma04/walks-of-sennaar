// Height statistics of the generated terrain: how much the ground rises and
// falls within a block, across block edges and over a few blocks, and how much
// of it the traveller can walk to.   node tools/terrainstats.mjs [seed] [radius]

import { generateStructure } from '../src/world/layout.js';
import { BLOCK } from '../src/config.js';
import { plotGraph } from './plotgraph.mjs';

const seed = +(process.argv[2] ?? 8);
const R = +(process.argv[3] ?? 6);
const N = BLOCK;
const S = new Map();
for (let bz = -R; bz <= R; bz++) for (let bx = -R; bx <= R; bx++) S.set(`${bx},${bz}`, generateStructure(seed, bx, bz));

const pct = (a, q) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
};
const hist = (a) => {
  const m = new Map();
  for (const v of a) m.set(v, (m.get(v) || 0) + 1);
  return [...m].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${k}:${((100 * v) / a.length).toFixed(0)}%`).join(' ');
};

const blockRange = [];
const blockMean = new Map();
const plotSteps = [];
let walkCells = 0;
let reachCells = 0;
const levels = [];
for (const [key, T] of S) {
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  let n = 0;
  for (const p of T.plots) {
    if (p.building || p.water) continue;
    const a = p.w * p.d;
    walkCells += a;
    if (p.reachable) reachCells += a;
    lo = Math.min(lo, p.level);
    hi = Math.max(hi, p.level);
    sum += p.level * a;
    n += a;
    for (let k = 0; k < a; k += 8) levels.push(p.level);
    for (const e of p.adj) {
      const q = T.plots[e.q];
      if (q.id < p.id || q.building || q.water) continue;
      plotSteps.push(Math.abs(q.level - p.level));
    }
  }
  blockRange.push(hi - lo);
  blockMean.set(key, sum / n);
}
const edge = [];
for (let bz = -R; bz < R; bz++) for (let bx = -R; bx < R; bx++) {
  const m = blockMean.get(`${bx},${bz}`);
  edge.push(Math.abs(m - blockMean.get(`${bx + 1},${bz}`)), Math.abs(m - blockMean.get(`${bx},${bz + 1}`)));
}
// spread over 3x3 blocks
const wide = [];
for (let bz = -R + 1; bz < R; bz++) for (let bx = -R + 1; bx < R; bx++) {
  let lo = Infinity;
  let hi = -Infinity;
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
    const m = blockMean.get(`${bx + dx},${bz + dz}`);
    lo = Math.min(lo, m);
    hi = Math.max(hi, m);
  }
  wide.push(hi - lo);
}
const f = (a) => `median ${pct(a, 0.5).toFixed(1)}  p90 ${pct(a, 0.9).toFixed(1)}  max ${Math.max(...a).toFixed(1)}`;
console.log(`seed ${seed}, ${(2 * R + 1) ** 2} blocks`);
console.log('level range within a block   ', f(blockRange));
console.log('mean-level jump across edges ', f(edge));
console.log('mean-level spread over 3x3   ', f(wide));
console.log('all levels                   ', `p5 ${pct(levels, 0.05)}  p50 ${pct(levels, 0.5)}  p95 ${pct(levels, 0.95)}`);
console.log('adjacent terrace steps       ', hist(plotSteps));
console.log('walkable area, block-local  ', `${((100 * reachCells) / walkCells).toFixed(1)}% linked to a gate`);
const G = plotGraph(S, R);
console.log('walkable area, whole square  ', `${((100 * G.mainArea) / G.walkArea).toFixed(1)}% in the largest network, ${((100 * G.spawnArea) / G.walkArea).toFixed(1)}% reachable from the spawn`);
const open = [...S.values()].reduce((n, T) => n + T.gates.length, 0);
console.log('block edges open             ', `${((100 * open) / (4 * S.size)).toFixed(0)}%`);
