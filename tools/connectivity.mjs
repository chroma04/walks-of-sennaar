// Flood-fills the traveller's collision model over a square of blocks (both
// layers: the ground and bridge decks) from the centre block's spawn, and
// checks it against the layout's own plot graph (tools/plotgraph.mjs): every
// gate and bridge the plot graph reaches from the spawn must be walked to, and
// terrace cells that should be reachable but are not, or that the flood gets
// into although nothing leads there, are reported.
//   node tools/connectivity.mjs [seed] [radiusInBlocks] [cx] [cz]

import { Generator } from '../src/world/generator.js';
import { World } from '../src/world/World.js';
import { BLOCK, BLOCK_SIZE, CELL, K_BUILDING } from '../src/config.js';

const N = BLOCK;
import { RADIUS } from '../src/player/Player.js';
import { plotGraph } from './plotgraph.mjs';

globalThis.navigator ??= { hardwareConcurrency: 1 };
const seed = +(process.argv[2] ?? 8);
const R = +(process.argv[3] ?? 1);
const cx = +(process.argv[4] ?? 0);
const cz = +(process.argv[5] ?? 0);

const gen = new Generator(seed);
const warn = console.warn;
console.warn = () => {}; // no Worker in Node: the world falls back quietly
const world = new World({ scene: { add() {}, remove() {} }, material: null, seed });
console.warn = warn;
world.workers = [];
const t0 = performance.now();
for (let bz = cz - R; bz <= cz + R; bz++) for (let bx = cx - R; bx <= cx + R; bx++) world.addBlock(gen.generate(bx, bz));
console.log('generated', ((performance.now() - t0) / 1000).toFixed(1), 's');

const STEP = 0.5;
const x0 = (cx - R) * BLOCK_SIZE;
const z0 = (cz - R) * BLOCK_SIZE;
const n = ((2 * R + 1) * BLOCK_SIZE) / STEP;
const heights = new Float32Array(n * n * 2).fill(NaN);
const seen = new Uint8Array(n * n * 2);
const GROUND = -1e9; // a height hint that always picks the ground layer

const structures = new Map();
for (let bz = cz - R; bz <= cz + R; bz++) for (let bx = cx - R; bx <= cx + R; bx++) structures.set(`${bx},${bz}`, gen.structure(bx, bz));
const graph = plotGraph(structures, R, cx, cz);
const expected = (bx, bz, plot) => {
  const k = graph.id(bx, bz, plot);
  return k !== undefined && graph.find(k) === graph.spawn;
};

// start next to the centre block's north gate (or whichever it has)
const S = gen.structure(cx, cz);
const g = S.gates.find((q) => q.dir === 3) || S.gates[0];
let start = null;
for (let r = 0; r < 12 && !start; r += 0.5) {
  for (let k = 0; k < 16 && !start; k++) {
    const a = (k / 16) * Math.PI * 2;
    const x = cx * BLOCK_SIZE + (g.i + 0.5) * CELL + Math.cos(a) * r;
    const z = cz * BLOCK_SIZE + (g.j + 2.5) * CELL + Math.sin(a) * r;
    const h = world.standAt(x, z, RADIUS);
    if (!Number.isNaN(h)) start = [Math.round((x - x0) / STEP), Math.round((z - z0) / STEP)];
  }
}
const idx = (i, j, l = 0) => (j * n + i) * 2 + l;
{
  const x = x0 + start[0] * STEP;
  const z = z0 + start[1] * STEP;
  const h = world.standAt(x, z, RADIUS);
  const k = idx(start[0], start[1], world.layerAt(x, z, h));
  heights[k] = h;
  seen[k] = 1;
  start = k;
}
const q = [start];
let reached = 0;
const t1 = performance.now();
while (q.length) {
  const k = q.pop();
  const cell = k >> 1;
  const i = cell % n;
  const j = (cell - i) / n;
  reached++;
  const x = x0 + i * STEP;
  const z = z0 + j * STEP;
  const y = heights[k];
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const a = i + di;
    const b = j + dj;
    if (a < 0 || b < 0 || a >= n || b >= n) continue;
    const nx = x0 + a * STEP;
    const nz = z0 + b * STEP;
    const h = world.canTraverse(x, z, y, nx, nz, RADIUS);
    if (Number.isNaN(h)) continue;
    const m = idx(a, b, world.layerAt(nx, nz, h));
    if (seen[m]) continue;
    seen[m] = 1;
    heights[m] = h;
    q.push(m);
  }
}
console.log('flood', reached, 'nodes in', ((performance.now() - t1) / 1000).toFixed(1), 's');

// every gate the plot graph reaches must be reached; report reachable-plot
// cells that were not, and cells reached that nothing should lead to
let bad = 0;
let gatesExpected = 0;
let missingCells = 0;
let pockets = 0;
let leaks = 0;
let totalCells = 0;
let totalBridges = 0;
let crossed = 0;
for (let bz = cz - R; bz <= cz + R; bz++) {
  for (let bx = cx - R; bx <= cx + R; bx++) {
    const T = gen.structure(bx, bz);
    for (const gt of T.gates) {
      if (!expected(bx, bz, T.plotId[gt.j * N + gt.i])) continue;
      gatesExpected++;
      const gx = bx * BLOCK_SIZE + (gt.i + 0.5) * CELL;
      const gz = bz * BLOCK_SIZE + (gt.j + 0.5) * CELL;
      let ok = false;
      for (let oz = -2; oz <= 2 && !ok; oz++) {
        for (let ox = -2; ox <= 2 && !ok; ox++) {
          const i = Math.round((gx - x0) / STEP) + ox;
          const j = Math.round((gz - z0) / STEP) + oz;
          if (i >= 0 && j >= 0 && i < n && j < n && (seen[idx(i, j, 0)] || seen[idx(i, j, 1)])) ok = true;
        }
      }
      if (!ok) {
        bad++;
        console.log('gate not reached', bx, bz, 'dir', gt.dir);
      }
    }
    const inner = Math.abs(bx - cx) < R && Math.abs(bz - cz) < R;
    for (const br of inner ? T.bridges : []) {
      if (!expected(bx, bz, br.pa)) continue;
      totalBridges++;
      const c = br.cells[Math.floor(br.cells.length / 2)];
      const i = Math.round((bx * BLOCK_SIZE + ((c % BLOCK) + 0.5) * CELL - x0) / STEP);
      const j = Math.round((bz * BLOCK_SIZE + (Math.floor(c / BLOCK) + 0.5) * CELL - z0) / STEP);
      if (seen[idx(i, j, 1)]) crossed++;
      else if (process.env.DEBUG) console.log('bridge not reached', bx, bz, br.i0, br.j0, br.d);
    }
    for (let c = 0; c < BLOCK * BLOCK && inner; c++) {
      const P = T.plots[T.plotId[c]];
      if (P.building || P.water || T.kind[c] === K_BUILDING) continue;
      const want = expected(bx, bz, P.id);
      const ci = c % BLOCK;
      const cj = Math.floor(c / BLOCK);
      // lattice nodes strictly inside this cell
      const nodes = [];
      for (let oz = 1; oz < 4; oz++) {
        for (let ox = 1; ox < 4; ox++) {
          const i = Math.round((bx * BLOCK_SIZE + ci * CELL + ox * STEP - x0) / STEP);
          const j = Math.round((bz * BLOCK_SIZE + cj * CELL + oz * STEP - z0) / STEP);
          nodes.push([i, j]);
        }
      }
      const got = nodes.some(([i, j]) => seen[idx(i, j, 0)]);
      if (!want) {
        if (got) {
          leaks++;
          if (process.env.DEBUG && leaks <= 12) console.log('leak', bx, bz, 'cell', ci, cj, 'plot', P.id, 'level', P.level);
        }
        continue;
      }
      totalCells++;
      if (got) continue;
      missingCells++;
      // a pocket: ground the traveller could stand on that the flood never entered
      const standable = nodes.some(([i, j]) => !Number.isNaN(world.standAt(x0 + i * STEP, z0 + j * STEP, RADIUS, null, GROUND)));
      if (standable) {
        pockets++;
        if (process.env.DEBUG && pockets <= 12) console.log('pocket', bx, bz, 'cell', ci, cj, 'kind', T.kind[c], 'used', T.used[c]);
      }
    }
  }
}
console.log(`walkable area reachable from the spawn: ${((100 * graph.spawnArea) / graph.walkArea).toFixed(1)}%`);
console.log(`gates missed: ${bad}/${gatesExpected}; reachable-plot cells never visited: ${missingCells}/${totalCells}; standable pockets: ${pockets}; cells reached that nothing leads to: ${leaks}; bridges walked: ${crossed}/${totalBridges}`);
process.exit(bad || crossed < totalBridges ? 1 : 0);
