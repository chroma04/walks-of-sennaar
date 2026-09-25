// Block layout generation.
//
// The world is an infinite grid of 64 m blocks, each 32x32 cells of 2 m. A block
// is partitioned (BSP) into rectangular plots. Every plot is a solid mass: its top
// is either a walkable terrace or a building roof. Adjacent terraces at different
// heights are joined by stairs.
//
// Connectivity guarantee: every block edge carries a "gate" cell whose level is a
// pure function of that edge, so both blocks agree on it. Within a block, the
// plots holding the four gates are joined by a spine whose levels stay inside
// [min gate, max gate] (a span of at most two levels, see anchor()), so every
// spine step is climbable. All other terraces hang off the spine as a tree.
// Hence the walkable world is one infinite connected component.

import { BLOCK, CELL, LEVEL_H, STAIR_CELLS_PER_LEVEL, STEPS_PER_CELL, K_FLOOR, K_STAIR, K_BUILDING, K_LANDING, DX, DZ } from '../config.js';
import { hash2, hash3, makeRng, valueNoise } from './rng.js';

const N = BLOCK;

// Continuous anchor height (in levels) over block coordinates. Lipschitz < 1 per
// block (0.6 + 0.3, see valueNoise), so rounded anchors of neighbouring blocks
// differ by at most one level.
export function anchorField(seed, x, z) {
  return 4.0 * valueNoise(seed ^ 0xa11ce, x / 20, z / 20) + 0.8 * valueNoise(seed ^ 0xbead, x / 8, z / 8);
}

export function anchor(seed, bx, bz) {
  return Math.round(anchorField(seed, bx, bz));
}

function edgeGate(seed, ex, ez, axis) {
  const h = hash3(seed ^ 0x6a7e, ex, ez, axis);
  const pos = 8 + (h % 16);
  const a = anchor(seed, ex, ez);
  const b = axis === 0 ? anchor(seed, ex + 1, ez) : anchor(seed, ex, ez + 1);
  return { pos, level: (h >>> 8) & 1 ? a : b };
}

export function blockGates(seed, bx, bz) {
  const e = edgeGate(seed, bx, bz, 0);
  const w = edgeGate(seed, bx - 1, bz, 0);
  const s = edgeGate(seed, bx, bz, 1);
  const n = edgeGate(seed, bx, bz - 1, 1);
  return [
    { dir: 0, i: N - 1, j: e.pos, level: e.level },
    { dir: 1, i: s.pos, j: N - 1, level: s.level },
    { dir: 2, i: 0, j: w.pos, level: w.level },
    { dir: 3, i: n.pos, j: 0, level: n.level },
  ];
}

function targetLevel(seed, gx, gz, rng) {
  const t = anchorField(seed, gx / N, gz / N) + 2.8 * valueNoise(seed ^ 0x5eed, gx / 12, gz / 12) + (rng() - 0.5) * 2.2;
  return Math.round(t);
}

function bsp(rng, x0, z0, x1, z1, out) {
  const w = x1 - x0;
  const d = z1 - z0;
  const MIN = 4;
  const MAX = 12;
  const canX = w >= 2 * MIN;
  const canZ = d >= 2 * MIN;
  if (!canX && !canZ) return void out.push({ x0, z0, x1, z1 });
  const area = w * d;
  if (!(w > MAX || d > MAX)) {
    const stop = area < 48 ? 0.75 : area < 100 ? 0.4 : 0.15;
    if (rng() < stop) return void out.push({ x0, z0, x1, z1 });
  }
  let splitX;
  if (canX && canZ) splitX = w > d ? rng() < 0.85 : w < d ? rng() < 0.15 : rng() < 0.5;
  else splitX = canX;
  if (splitX) {
    const s = x0 + MIN + Math.floor(rng() * (w - 2 * MIN + 1));
    bsp(rng, x0, z0, s, z1, out);
    bsp(rng, s, z0, x1, z1, out);
  } else {
    const s = z0 + MIN + Math.floor(rng() * (d - 2 * MIN + 1));
    bsp(rng, x0, z0, x1, s, out);
    bsp(rng, x0, s, x1, z1, out);
  }
}

function splitForGates(plots, gates) {
  const pick = (lo, hi, a, b) => {
    const s0 = Math.max(Math.min(a, b) + 1, lo + 3);
    const s1 = Math.min(Math.max(a, b), hi - 3);
    return s0 <= s1 ? Math.floor((s0 + s1) / 2) : -1;
  };
  for (let guard = 0; guard < 16; guard++) {
    let changed = false;
    for (let k = 0; k < plots.length && !changed; k++) {
      const p = plots[k];
      const inside = gates.filter((g) => g.i >= p.x0 && g.i < p.x1 && g.j >= p.z0 && g.j < p.z1);
      if (inside.length < 2) continue;
      const [g1, g2] = inside;
      let s = pick(p.x0, p.x1, g1.i, g2.i);
      if (s > 0 && g1.i !== g2.i) {
        plots.splice(k, 1, { x0: p.x0, z0: p.z0, x1: s, z1: p.z1 }, { x0: s, z0: p.z0, x1: p.x1, z1: p.z1 });
        changed = true;
        break;
      }
      s = pick(p.z0, p.z1, g1.j, g2.j);
      if (s > 0 && g1.j !== g2.j) {
        plots.splice(k, 1, { x0: p.x0, z0: p.z0, x1: p.x1, z1: s }, { x0: p.x0, z0: s, x1: p.x1, z1: p.z1 });
        changed = true;
        break;
      }
    }
    if (!changed) return;
  }
}

function buildAdjacency(plots) {
  for (const p of plots) p.adj = [];
  for (let a = 0; a < plots.length; a++) {
    for (let b = a + 1; b < plots.length; b++) {
      const P = plots[a];
      const Q = plots[b];
      let rec = null;
      if (P.x1 === Q.x0 || Q.x1 === P.x0) {
        const lo = Math.max(P.z0, Q.z0);
        const hi = Math.min(P.z1, Q.z1);
        if (hi > lo) rec = { dir: P.x1 === Q.x0 ? 0 : 2, lo, hi, line: P.x1 === Q.x0 ? P.x1 : P.x0 };
      } else if (P.z1 === Q.z0 || Q.z1 === P.z0) {
        const lo = Math.max(P.x0, Q.x0);
        const hi = Math.min(P.x1, Q.x1);
        if (hi > lo) rec = { dir: P.z1 === Q.z0 ? 1 : 3, lo, hi, line: P.z1 === Q.z0 ? P.z1 : P.z0 };
      }
      if (!rec) continue;
      P.adj.push({ q: Q, ...rec });
      Q.adj.push({ q: P, ...rec, dir: (rec.dir + 2) % 4 });
    }
  }
}

function bfsTree(root, minOverlap, allow) {
  const parent = new Map([[root, null]]);
  const queue = [root];
  while (queue.length) {
    const p = queue.shift();
    for (const e of p.adj) {
      if (e.hi - e.lo < minOverlap || parent.has(e.q) || !allow(e.q)) continue;
      parent.set(e.q, p);
      queue.push(e.q);
    }
  }
  return parent;
}

// ---------------------------------------------------------------------------

export function generateStructure(seed, bx, bz) {
  const rng = makeRng(hash2(seed ^ 0x51ab, bx, bz));
  const A = anchor(seed, bx, bz);
  const gates = blockGates(seed, bx, bz);

  // 1. plots
  const rects = [];
  bsp(rng, 0, 0, N, N, rects);
  splitForGates(rects, gates);
  const plots = rects.map((r, id) => ({
    id,
    ...r,
    w: r.x1 - r.x0,
    d: r.z1 - r.z0,
    gate: -1,
    spine: false,
    building: false,
    well: false,
    reachable: true,
    level: 0,
    target: 0,
  }));
  const plotId = new Int16Array(N * N);
  for (const p of plots) {
    for (let j = p.z0; j < p.z1; j++) for (let i = p.x0; i < p.x1; i++) plotId[j * N + i] = p.id;
    p.target = targetLevel(seed, bx * N + (p.x0 + p.x1) / 2, bz * N + (p.z0 + p.z1) / 2, rng);
  }
  for (const g of gates) plots[plotId[g.j * N + g.i]].gate = g.dir;
  buildAdjacency(plots);

  // 2. spine through the gate plots
  const gatePlots = gates.map((g) => plots[plotId[g.j * N + g.i]]);
  let tree = bfsTree(gatePlots[0], 2, () => true);
  if (!gatePlots.every((p) => tree.has(p))) tree = bfsTree(gatePlots[0], 1, () => true);
  const minG = Math.min(...gates.map((g) => g.level));
  const maxG = Math.max(...gates.map((g) => g.level));
  const links = []; // plot pairs that must be joined
  const linked = new Set();
  const link = (a, b, required) => {
    const key = a.id < b.id ? a.id * 1000 + b.id : b.id * 1000 + a.id;
    if (linked.has(key)) return;
    linked.add(key);
    links.push({ a, b, required });
  };
  for (const gp of gatePlots) {
    let p = gp;
    while (p) {
      p.spine = true;
      const par = tree.get(p);
      if (par) link(par, p, true);
      p = par;
    }
  }
  for (const p of plots) {
    if (!p.spine) continue;
    if (p.gate >= 0) p.level = gates[p.gate].level;
    else p.level = Math.max(minG, Math.min(maxG, p.target));
  }

  // 3. buildings (and a few sunken wells) among the rest
  for (const p of plots) {
    if (p.spine) continue;
    const area = p.w * p.d;
    if (area > 72) continue;
    const pb = area <= 24 ? 0.5 : area <= 48 ? 0.36 : 0.22;
    const r = rng();
    if (r < pb) p.building = true;
    else if (r < pb + 0.1 && area >= 20) p.well = true;
  }

  // 4. grow terraces off the spine
  const queue = plots.filter((p) => p.spine);
  const seen = new Set(queue);
  while (queue.length) {
    const p = queue.shift();
    for (const e of p.adj) {
      const q = e.q;
      if (seen.has(q) || q.building || q.well || e.hi - e.lo < 2) continue;
      seen.add(q);
      let delta = Math.max(-1, Math.min(1, q.target - p.level));
      if (Math.abs(q.target - p.level) >= 2 && rng() < 0.45) delta *= 2;
      else if (delta === 0 && rng() < 0.5) delta = rng() < 0.5 ? -1 : 1;
      else if (rng() < 0.12) delta = 0;
      q.level = p.level + delta;
      link(p, q, true);
      queue.push(q);
    }
  }
  // Terraces off the network sink below their surroundings: wells of shade.
  for (const p of plots) {
    if (p.building || seen.has(p)) continue;
    p.reachable = false;
    let low = Infinity;
    for (const e of p.adj) if (!e.q.building && seen.has(e.q)) low = Math.min(low, e.q.level);
    if (low === Infinity) low = p.target;
    p.level = low - 1 - Math.floor(rng() * (p.well ? 3 : 2));
  }

  // 5. buildings take their height from their surroundings
  for (const p of plots) {
    if (!p.building) continue;
    let top = A;
    for (const e of p.adj) if (!e.q.building) top = Math.max(top, e.q.level);
    const area = p.w * p.d;
    p.tower = area <= 20 && rng() < 0.6;
    p.level = top + 1 + (p.tower ? 1 + Math.floor(rng() * 2) : rng() < 0.3 ? 1 : 0);
    p.roof = p.tower ? 'pyramid' : rng() < 0.45 ? 'hip' : 'flat';
  }

  // 6. extra loops between terraces
  for (const p of plots) {
    if (p.building || !p.reachable) continue;
    for (const e of p.adj) {
      const q = e.q;
      if (q.id < p.id || q.building || !q.reachable) continue;
      const d = Math.abs(q.level - p.level);
      if (d >= 1 && d <= 2 && e.hi - e.lo >= 2 && rng() < 0.35) link(p, q, false);
    }
  }

  // 7. cells
  const kind = new Uint8Array(N * N);
  const base = new Float32Array(N * N);
  const stairOf = new Int16Array(N * N).fill(-1);
  const used = new Uint8Array(N * N); // 1 stair/landing, 2 reserved, 3 feature
  for (const p of plots) {
    for (let j = p.z0; j < p.z1; j++) {
      for (let i = p.x0; i < p.x1; i++) {
        const c = j * N + i;
        kind[c] = p.building ? K_BUILDING : K_FLOOR;
        base[c] = p.level * LEVEL_H;
      }
    }
  }
  for (const g of gates) {
    used[g.j * N + g.i] = 2;
    const ii = g.i - DX[g.dir];
    const jj = g.j - DZ[g.dir];
    if (plotId[jj * N + ii] === plotId[g.j * N + g.i]) used[jj * N + ii] = 2;
  }

  // 8. stairs
  const stairs = [];
  const ctx = { rng, plots, plotId, kind, base, stairOf, used, stairs };
  let failed = 0;
  for (const l of links) {
    const { a, b } = l;
    if (a.level === b.level) continue;
    const low = a.level < b.level ? a : b;
    const high = low === a ? b : a;
    const ok = placeStair(ctx, low, high);
    if (!ok && l.required) failed++;
  }

  return {
    bx,
    bz,
    seed,
    anchor: A,
    gates,
    plots: plots.map(({ adj, ...p }) => ({ ...p, adj: adj.map((e) => ({ q: e.q.id, dir: e.dir, lo: e.lo, hi: e.hi, line: e.line })) })),
    plotId,
    kind,
    base,
    stairOf,
    used,
    stairs,
    failedLinks: failed,
  };
}

// ---------------------------------------------------------------------------
// Stairs

function adjRecord(low, high) {
  return low.adj.find((e) => e.q === high);
}

// Map (a, b) boundary coordinates to a cell. a >= 0 is on the high side.
function boundaryCell(e, a, b) {
  switch (e.dir) {
    case 0:
      return [e.line + a, b];
    case 2:
      return [e.line - 1 - a, b];
    case 1:
      return [b, e.line + a];
    default:
      return [b, e.line - 1 - a];
  }
}

function placeStair(ctx, low, high) {
  const { rng } = ctx;
  const e = adjRecord(low, high);
  if (!e) return false;
  const d = high.level - low.level;
  if (d < 1 || d > 2) return false;
  const n = d * STAIR_CELLS_PER_LEVEL;
  const len = e.hi - e.lo;
  const lowDepth = e.dir % 2 === 0 ? low.w : low.d;
  const highDepth = e.dir % 2 === 0 ? high.w : high.d;

  const widths = [];
  if (len >= 7 && rng() < 0.3) widths.push(3);
  if (len >= 3) widths.push(2);
  widths.push(1);

  const tryParallel = () => {
    if (len < n + 1 || lowDepth < 3) return false;
    const starts = [];
    for (let b0 = e.lo; b0 < e.hi; b0++) starts.push(b0);
    shuffle(starts, rng);
    for (const b0 of starts) {
      for (const sg of rng() < 0.5 ? [1, -1] : [-1, 1]) {
        if (placeParallel(ctx, e, low, high, b0, sg, n)) return true;
      }
    }
    return false;
  };

  const tryPerp = (w, k) => {
    if (len < w) return false;
    if (k + 1 > lowDepth || n - k + 1 > highDepth) return false;
    const margin = len >= w + 2 ? 1 : 0;
    const lo = e.lo + margin;
    const hi = e.hi - w - margin;
    if (hi < lo) return false;
    const cand = [];
    for (let b0 = lo; b0 <= hi; b0++) cand.push(b0);
    shuffle(cand, rng);
    const mid = Math.round((lo + hi) / 2);
    cand.sort((x, y) => (x === mid ? -1 : y === mid ? 1 : 0));
    for (const b0 of cand) if (placePerp(ctx, e, low, high, b0, w, k, n)) return true;
    return false;
  };

  const parallelFirst = rng() < 0.3;
  if (parallelFirst && tryParallel()) return true;
  for (const w of widths) {
    for (let k = n; k >= 0; k--) if (tryPerp(w, k)) return true;
  }
  if (!parallelFirst && tryParallel()) return true;
  return false;
}

function cellFree(ctx, i, j) {
  if (i < 0 || j < 0 || i >= N || j >= N) return false;
  return ctx.used[j * N + i] === 0;
}

function inPlot(ctx, i, j, p) {
  return i >= p.x0 && i < p.x1 && j >= p.z0 && j < p.z1;
}

function placePerp(ctx, e, low, high, b0, w, k, n) {
  const cells = [];
  for (let t = 0; t < n; t++) {
    for (let u = 0; u < w; u++) {
      const [i, j] = boundaryCell(e, -k + t, b0 + u);
      if (!cellFree(ctx, i, j)) return false;
      if (!inPlot(ctx, i, j, -k + t < 0 ? low : high)) return false;
      cells.push([i, j]);
    }
  }
  const landing = [];
  const exit = [];
  for (let u = 0; u < w; u++) {
    const [li, lj] = boundaryCell(e, -k - 1, b0 + u);
    const [xi, xj] = boundaryCell(e, n - k, b0 + u);
    if (!inPlot(ctx, li, lj, low) || !inPlot(ctx, xi, xj, high)) return false;
    if (ctx.used[lj * N + li] === 1 || ctx.used[xj * N + xi] === 1) return false;
    landing.push([li, lj]);
    exit.push([xi, xj]);
  }
  if (!keepsPlotsWhole(ctx, cells, [low, high])) return false;
  const [i0, j0] = boundaryCell(e, -k, b0);
  commitStair(ctx, {
    i0,
    j0,
    dir: e.dir,
    n,
    w,
    hB: low.level * LEVEL_H,
    hT: high.level * LEVEL_H,
    type: 'perp',
    sunk: n - Math.min(n, k),
    low: low.id,
    high: high.id,
    cells,
    landing: null,
    exit,
    foot: landing,
  });
  return true;
}

function placeParallel(ctx, e, low, high, b0, sg, n) {
  // stair cells along the low side of the boundary (a = -1)
  const cells = [];
  for (let t = 0; t < n; t++) {
    const b = b0 + sg * t;
    if (b < e.lo || b >= e.hi) return false;
    const [i, j] = boundaryCell(e, -1, b);
    if (!cellFree(ctx, i, j) || !inPlot(ctx, i, j, low)) return false;
    cells.push([i, j]);
  }
  const bl = b0 + sg * n;
  if (bl < e.lo || bl >= e.hi) return false;
  const [li, lj] = boundaryCell(e, -1, bl);
  if (!cellFree(ctx, li, lj) || !inPlot(ctx, li, lj, low)) return false;
  const [fi, fj] = boundaryCell(e, -1, b0 - sg);
  if (!inPlot(ctx, fi, fj, low) || ctx.used[fj * N + fi] === 1) return false;
  const [xi, xj] = boundaryCell(e, 0, bl);
  if (ctx.used[xj * N + xi] === 1) return false;
  // the row beside the stair must stay open
  const [si, sj] = boundaryCell(e, -2, b0);
  if (ctx.used[sj * N + si] === 1) return false;
  let dir;
  if (e.dir % 2 === 0) dir = sg > 0 ? 1 : 3;
  else dir = sg > 0 ? 0 : 2;
  if (!keepsPlotsWhole(ctx, [...cells, [li, lj]], [low])) return false;
  const [i0, j0] = boundaryCell(e, -1, b0);
  commitStair(ctx, {
    i0,
    j0,
    dir,
    n,
    w: 1,
    hB: low.level * LEVEL_H,
    hT: high.level * LEVEL_H,
    type: 'parallel',
    sunk: 0,
    low: low.id,
    high: high.id,
    cells,
    landing: [li, lj],
    exit: [[xi, xj]],
    foot: [[fi, fj]],
    wallDir: e.dir,
  });
  return true;
}

// A stair must never cut its plots in two: the free cells of each plot have to
// stay 4-connected once the candidate cells are taken.
function plotConnected(ctx, P, blocked) {
  const free = (i, j) => {
    if (i < P.x0 || i >= P.x1 || j < P.z0 || j >= P.z1) return false;
    const c = j * N + i;
    return ctx.kind[c] !== K_STAIR && ctx.kind[c] !== K_LANDING && !blocked.has(c);
  };
  let total = 0;
  let start = -1;
  for (let j = P.z0; j < P.z1; j++) {
    for (let i = P.x0; i < P.x1; i++) {
      if (!free(i, j)) continue;
      total++;
      if (start < 0) start = j * N + i;
    }
  }
  if (total === 0) return false;
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const c = stack.pop();
    const i = c % N;
    const j = (c - i) / N;
    for (let d = 0; d < 4; d++) {
      const a = i + DX[d];
      const b = j + DZ[d];
      const k = b * N + a;
      if (!free(a, b) || seen.has(k)) continue;
      seen.add(k);
      stack.push(k);
    }
  }
  return seen.size === total;
}

function keepsPlotsWhole(ctx, cells, plots) {
  const blocked = new Set(cells.map(([i, j]) => j * N + i));
  return plots.every((P) => plotConnected(ctx, P, blocked));
}

function commitStair(ctx, s) {
  const id = ctx.stairs.length;
  s.id = id;
  ctx.stairs.push(s);
  for (const [i, j] of s.cells) {
    const c = j * N + i;
    ctx.kind[c] = K_STAIR;
    ctx.base[c] = s.hB;
    ctx.stairOf[c] = id;
    ctx.used[c] = 1;
  }
  if (s.landing) {
    const c = s.landing[1] * N + s.landing[0];
    ctx.kind[c] = K_LANDING;
    ctx.base[c] = s.hT;
    ctx.stairOf[c] = id;
    ctx.used[c] = 1;
  }
  for (const [i, j] of [...s.exit, ...s.foot]) {
    const c = j * N + i;
    if (ctx.used[c] === 0) ctx.used[c] = 2;
  }
}

function shuffle(a, rng) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// Height of a stair's ramp at block-local metres (x, z).
export function stairRamp(s, x, z) {
  let t;
  switch (s.dir) {
    case 0:
      t = x - s.i0 * CELL;
      break;
    case 2:
      t = (s.i0 + 1) * CELL - x;
      break;
    case 1:
      t = z - s.j0 * CELL;
      break;
    default:
      t = (s.j0 + 1) * CELL - z;
  }
  // follows the middle of each tread
  const L = s.n * CELL;
  const rise = (s.hT - s.hB) / (s.n * STEPS_PER_CELL);
  const h = s.hB + ((s.hT - s.hB) * t) / L + rise * 0.5;
  return Math.max(s.hB, Math.min(s.hT, h));
}
