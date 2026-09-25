// Cell-level helpers shared by the furnishing passes: what lies across a plot's
// sides, which cells are taken, whether props still leave the floor in one
// piece, and a few frames and boxes.

import { BLOCK, CELL, LEVEL_H, K_FLOOR, K_STAIR, K_BUILDING, K_LANDING, K_WATER, DX, DZ } from '../config.js';

const N = BLOCK;

export const hasDeck = (ctx, i, j) => {
  const v = ctx.S.deck[j * N + i];
  return v === v;
};

export function sideCells(P, d) {
  const cells = [];
  if (d === 0) for (let j = P.z0; j < P.z1; j++) cells.push([P.x1 - 1, j]);
  else if (d === 2) for (let j = P.z0; j < P.z1; j++) cells.push([P.x0, j]);
  else if (d === 1) for (let i = P.x0; i < P.x1; i++) cells.push([i, P.z1 - 1]);
  else for (let i = P.x0; i < P.x1; i++) cells.push([i, P.z0]);
  return cells;
}

export function sideInfo(ctx, P, d) {
  const y = P.level * LEVEL_H;
  return sideCells(P, d).map(([i, j], t) => {
    const ni = i + DX[d];
    const nj = j + DZ[d];
    const n = ctx.look(ni, nj);
    let rel;
    if (n.deck === n.deck && Math.abs(n.deck - y) < 0.01) rel = 'stair';
    else if (n.kind === K_WATER) rel = 'water';
    else if (n.kind === K_STAIR || n.kind === K_LANDING) rel = 'stair';
    else if (n.kind === K_BUILDING || n.base > y + 1.5) rel = 'up';
    else if (n.base < y - 1.5) rel = 'down';
    else rel = 'same';
    const u = ctx.used[j * N + i];
    return { i, j, t, rel, u, wall: n.base - y, owner: n };
  });
}

export function runs(arr, pred) {
  const res = [];
  let cur = null;
  for (const e of arr) {
    if (pred(e)) {
      if (!cur) res.push((cur = []));
      cur.push(e);
    } else cur = null;
  }
  return res;
}

export function regionUsed(ctx, x0, z0, x1, z1, allow2 = false) {
  for (let j = z0; j < z1; j++) {
    for (let i = x0; i < x1; i++) {
      if (i < 0 || j < 0 || i >= N || j >= N) return true;
      const u = ctx.used[j * N + i];
      if (u === 1 || u === 3 || (!allow2 && u === 2)) return true;
    }
  }
  return false;
}

// Whether props may take these cells of plot P: the rest of its open floor must
// stay in one piece, and every cell a prop stands in must still touch it (a
// prop fills only part of its cell, and the rest has to stay reachable).
export function roomFor(ctx, P, cells) {
  const { S } = ctx;
  const take = new Set(cells.map(([i, j]) => j * N + i));
  // (a stair's landing counts only at the plot's own level: one up at the top
  // of a flight is no way round)
  const y = P.level * LEVEL_H;
  const floor = (c) => (S.kind[c] === K_FLOOR || S.kind[c] === K_LANDING) && Math.abs(S.base[c] - y) < 0.01;
  const free = (i, j) => {
    if (!inside(P, i, j)) return false;
    const c = j * N + i;
    return floor(c) && ctx.used[c] !== 3 && !take.has(c);
  };
  let total = 0;
  let start = -1;
  const props = [];
  for (let j = P.z0; j < P.z1; j++) {
    for (let i = P.x0; i < P.x1; i++) {
      const c = j * N + i;
      if (free(i, j)) {
        total++;
        if (start < 0) start = c;
      } else if (floor(c) && (ctx.used[c] === 3 || take.has(c))) props.push([i, j]);
    }
  }
  if (!total) return false;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const c = stack.pop();
    const i = c % N;
    const j = (c - i) / N;
    for (let d = 0; d < 4; d++) {
      const a = i + DX[d];
      const b = j + DZ[d];
      if (!free(a, b) || seen.has(b * N + a)) continue;
      seen.add(b * N + a);
      stack.push(b * N + a);
    }
  }
  if (seen.size !== total) return false;
  return props.every(([i, j]) => [0, 1, 2, 3].some((d) => free(i + DX[d], j + DZ[d])));
}

export function mark(ctx, x0, z0, x1, z1, v = 3) {
  for (let j = z0; j < z1; j++) for (let i = x0; i < x1; i++) ctx.used[j * N + i] = v;
}

export function inside(P, i, j) {
  return i >= P.x0 && i < P.x1 && j >= P.z0 && j < P.z1;
}

export function blockEdge(ctx, i, j, d) {
  if (i >= 0 && j >= 0 && i < N && j < N) ctx.out.eblock[j * N + i] |= 1 << d;
  const ni = i + DX[d];
  const nj = j + DZ[d];
  if (ni >= 0 && nj >= 0 && ni < N && nj < N) ctx.out.eblock[nj * N + ni] |= 1 << ((d + 2) % 4);
}

export function edgeCentre(i, j, d) {
  return [(i + 0.5 + DX[d] * 0.5) * CELL, (j + 0.5 + DZ[d] * 0.5) * CELL];
}

export function dirAngle(d) {
  return Math.atan2(DX[d], DZ[d]);
}

// Box of length `len` along the wall and depth `dep` out from it, centred at (x,z).
export function orientedBox(x, z, d, len, dep, y) {
  const alongX = DZ[d] !== 0;
  const hx = alongX ? len / 2 : dep / 2;
  const hz = alongX ? dep / 2 : len / 2;
  return [x - hx, z - hz, x + hx, z + hz, y];
}

// Axis-aligned box of a rectangle given in a frame at (ox, oz) whose +z runs
// along direction r and +x across it.
export function localBox(ox, oz, r, x0, z0, x1, z1, y) {
  const fx = DX[r];
  const fz = DZ[r];
  const sx = DZ[r];
  const sz = -DX[r];
  const xs = [];
  const zs = [];
  for (const [a, b] of [[x0, z0], [x1, z0], [x1, z1], [x0, z1]]) {
    xs.push(ox + sx * a + fx * b);
    zs.push(oz + sz * a + fz * b);
  }
  return [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs), y];
}
