// Flood-fills the traveller's collision model over a square of blocks and
// reports terrace cells that should be reachable but are not.
//   node tools/connectivity.mjs [seed] [radiusInBlocks] [cx] [cz]

import { Generator } from '../src/world/generator.js';
import { World } from '../src/world/World.js';
import { BLOCK, BLOCK_SIZE, CELL, K_BUILDING } from '../src/config.js';
import { RADIUS } from '../src/player/Player.js';

globalThis.navigator ??= { hardwareConcurrency: 1 };
const seed = +(process.argv[2] ?? 0x5e22a4);
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
const heights = new Float32Array(n * n).fill(NaN);
const seen = new Uint8Array(n * n);

// start next to the centre block's north gate
const S = gen.structure(cx, cz);
const g = S.gates.find((q) => q.dir === 3);
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
const q = [start];
const idx = (i, j) => j * n + i;
heights[idx(...start)] = world.standAt(x0 + start[0] * STEP, z0 + start[1] * STEP, RADIUS);
seen[idx(...start)] = 1;
let reached = 0;
const t1 = performance.now();
while (q.length) {
  const [i, j] = q.pop();
  reached++;
  const x = x0 + i * STEP;
  const z = z0 + j * STEP;
  const y = heights[idx(i, j)];
  for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const a = i + di;
    const b = j + dj;
    if (a < 0 || b < 0 || a >= n || b >= n || seen[idx(a, b)]) continue;
    const h = world.canTraverse(x, z, y, x0 + a * STEP, z0 + b * STEP, RADIUS);
    if (Number.isNaN(h)) continue;
    seen[idx(a, b)] = 1;
    heights[idx(a, b)] = h;
    q.push([a, b]);
  }
}
console.log('flood', reached, 'nodes in', ((performance.now() - t1) / 1000).toFixed(1), 's');

// every gate of every block must be reached; report reachable-plot cells that were not
let bad = 0;
let missingCells = 0;
let pockets = 0;
let totalCells = 0;
for (let bz = cz - R; bz <= cz + R; bz++) {
  for (let bx = cx - R; bx <= cx + R; bx++) {
    const T = gen.structure(bx, bz);
    for (const gt of T.gates) {
      const gx = bx * BLOCK_SIZE + (gt.i + 0.5) * CELL;
      const gz = bz * BLOCK_SIZE + (gt.j + 0.5) * CELL;
      let ok = false;
      for (let oz = -2; oz <= 2 && !ok; oz++) {
        for (let ox = -2; ox <= 2 && !ok; ox++) {
          const i = Math.round((gx - x0) / STEP) + ox;
          const j = Math.round((gz - z0) / STEP) + oz;
          if (i >= 0 && j >= 0 && i < n && j < n && seen[idx(i, j)]) ok = true;
        }
      }
      if (!ok) {
        bad++;
        console.log('gate not reached', bx, bz, 'dir', gt.dir);
      }
    }
    const inner = Math.abs(bx - cx) < R && Math.abs(bz - cz) < R;
    for (let c = 0; c < BLOCK * BLOCK && inner; c++) {
      const P = T.plots[T.plotId[c]];
      if (P.building || !P.reachable || T.kind[c] === K_BUILDING) continue;
      totalCells++;
      const ci = c % BLOCK;
      const cj = Math.floor(c / BLOCK);
      let any = false;
      for (let oz = 0; oz < 4 && !any; oz++) {
        for (let ox = 0; ox < 4 && !any; ox++) {
          const i = Math.round((bx * BLOCK_SIZE + ci * CELL + 0.25 + ox * STEP - x0) / STEP);
          const j = Math.round((bz * BLOCK_SIZE + cj * CELL + 0.25 + oz * STEP - z0) / STEP);
          if (i >= 0 && j >= 0 && i < n && j < n && seen[idx(i, j)]) any = true;
        }
      }
      if (!any) {
        missingCells++;
        // a pocket is a cell with standable ground that the flood never entered
        let standable = false;
        for (let oz = 0; oz < 4 && !standable; oz++) {
          for (let ox = 0; ox < 4 && !standable; ox++) {
            const x = bx * BLOCK_SIZE + ci * CELL + 0.25 + ox * STEP;
            const z = bz * BLOCK_SIZE + cj * CELL + 0.25 + oz * STEP;
            if (!Number.isNaN(world.standAt(x, z, RADIUS))) standable = true;
          }
        }
        if (standable) {
          pockets++;
          if (process.env.DEBUG && pockets <= 12) console.log('pocket', bx, bz, 'cell', ci, cj, 'kind', T.kind[c], 'used', T.used[c]);
        }
      }
    }
  }
}
console.log(`gates missed: ${bad}; reachable-plot cells never visited: ${missingCells}/${totalCells}; standable pockets: ${pockets}`);
process.exit(bad ? 1 : 0);
