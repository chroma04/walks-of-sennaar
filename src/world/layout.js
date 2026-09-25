// Block layout generation.
//
// The world is an infinite grid of 64 m blocks, each 32x32 cells of 2 m. A block
// is partitioned (BSP) into rectangular plots. Every plot is a solid mass: its top
// is either a walkable terrace, a building roof or canal water. Adjacent terraces
// at different heights are joined by stairs, and a few terraces at the same
// height are joined by bridges that span lower ground (a second walkable layer,
// the "deck", so one can walk both over and under them).
//
// Blocks belong to districts: slow noise fields set how broad the plots are and
// how steep the ground is. Some blocks are built around a set piece (a stepped
// ziggurat, a sunken court, a canal with quays, a cascade of reaches and weirs)
// that is carved out first; the rest of the block is cut by BSP around it.
//
// Connectivity guarantee: every block edge carries a "gate" cell whose level is a
// pure function of that edge, so both blocks agree on it. Within a block, the
// plots holding the four gates are joined by a spine whose levels stay inside
// a two-level band holding every gate (gates span at most two levels, see
// anchor()), so every spine step is climbable. The spine never runs through a set piece, which only
// hangs off the ring of plots around it. All other terraces hang off the spine
// as a tree. Hence the walkable world is one infinite connected component.

import { BLOCK, CELL, LEVEL_H, STAIR_CELLS_PER_LEVEL, STEPS_PER_CELL, K_FLOOR, K_STAIR, K_BUILDING, K_LANDING, K_WATER, DX, DZ } from '../config.js';
import { hash2, hash3, hashFloat, makeRng, valueNoise } from './rng.js';

const N = BLOCK;
export const MAX_RISE = 3; // levels a single flight may climb
export const WATER_DROP = 0.8; // canal water surface below its quays
export const DECK_T = 0.55; // bridge deck thickness under the walking surface
const BRIDGE_CLEAR = 2 * LEVEL_H; // ground under a bridge lies at least this far down

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

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

// ---------------------------------------------------------------------------
// Districts

function rawProgram(seed, bx, bz) {
  const civic = valueNoise(seed ^ 0xc1c1, bx / 2.6, bz / 2.6);
  if (hashFloat(seed ^ 0x9e01, bx, bz) > 0.3 + 0.3 * civic) return 'terraces';
  const flavour = valueNoise(seed ^ 0xf1a7, bx / 5.5, bz / 5.5) + (hashFloat(seed ^ 0x9e02, bx, bz) - 0.5) * 0.9;
  if (flavour < -0.18) return hashFloat(seed ^ 0x9e03, bx, bz) < 0.5 ? 'cascade' : 'canal';
  if (flavour > 0.18) return 'ziggurat';
  return 'court';
}

// relief: 0 = broad level plateaus, 1 = steep cascades and cliffs.
// grain: 0 = dense small plots, 1 = wide open plazas.
export function district(seed, bx, bz) {
  let program = rawProgram(seed, bx, bz);
  // the same set piece never sits right next to itself
  if (program !== 'terraces' && (rawProgram(seed, bx - 1, bz) === program || rawProgram(seed, bx, bz - 1) === program)) program = 'terraces';
  return {
    program,
    relief: clamp(0.5 + 0.85 * valueNoise(seed ^ 0x4e11, bx / 3.1, bz / 3.1), 0, 1),
    grain: clamp(0.5 + 0.85 * valueNoise(seed ^ 0x9a17, bx / 3.7, bz / 3.7), 0, 1),
  };
}

function targetLevel(seed, gx, gz, rng, relief) {
  const amp = 1.6 + 2.6 * relief;
  const t = anchorField(seed, gx / N, gz / N) + amp * valueNoise(seed ^ 0x5eed, gx / 12, gz / 12) + (rng() - 0.5) * (1.2 + 1.8 * relief);
  return Math.round(t);
}

function bsp(rng, x0, z0, x1, z1, out, G) {
  const w = x1 - x0;
  const d = z1 - z0;
  if (w <= 0 || d <= 0) return;
  const MIN = 4;
  const canX = w >= 2 * MIN;
  const canZ = d >= 2 * MIN;
  if (!canX && !canZ) return void leaf(rng, x0, z0, x1, z1, out, G);
  const area = w * d;
  if (w >= 10 && d >= 10 && w <= 16 && d <= 16 && rng() < G.nest * 0.6) return void leaf(rng, x0, z0, x1, z1, out, G, true);
  if (!(w > G.max || d > G.max)) {
    const stop = area < 48 ? 0.75 : area < 100 ? G.stopMid : G.stopBig;
    if (rng() < stop) return void leaf(rng, x0, z0, x1, z1, out, G);
  }
  let splitX;
  if (canX && canZ) splitX = w > d ? rng() < 0.85 : w < d ? rng() < 0.15 : rng() < 0.5;
  else splitX = canX;
  if (splitX) {
    const s = x0 + MIN + Math.floor(rng() * (w - 2 * MIN + 1));
    bsp(rng, x0, z0, s, z1, out, G);
    bsp(rng, s, z0, x1, z1, out, G);
  } else {
    const s = z0 + MIN + Math.floor(rng() * (d - 2 * MIN + 1));
    bsp(rng, x0, z0, x1, s, out, G);
    bsp(rng, x0, s, x1, z1, out, G);
  }
}

// A broad plot may nest a raised dais or a sunken parterre inside a ring of
// terraces that share one level.
function leaf(rng, x0, z0, x1, z1, out, G, force = false) {
  const w = x1 - x0;
  const d = z1 - z0;
  if (G.nest && w >= 10 && d >= 10 && (force || rng() < G.nest)) {
    const rw = w >= 13 && d >= 13 && rng() < 0.5 ? 4 : 3;
    const r = rng();
    const nest = r < 0.4 ? 1 : r < 0.75 ? -2 : -1;
    const ring = G.rings++;
    out.push(
      { x0, z0, x1, z1: z0 + rw, ring },
      { x0, z0: z1 - rw, x1, z1, ring },
      { x0, z0: z0 + rw, x1: x0 + rw, z1: z1 - rw, ring },
      { x0: x1 - rw, z0: z0 + rw, x1, z1: z1 - rw, ring },
      { x0: x0 + rw, z0: z0 + rw, x1: x1 - rw, z1: z1 - rw, ring, nest },
    );
    return;
  }
  out.push({ x0, z0, x1, z1 });
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
        plots.splice(k, 1, { ...p, x0: p.x0, z0: p.z0, x1: s, z1: p.z1 }, { ...p, x0: s, z0: p.z0, x1: p.x1, z1: p.z1 });
        changed = true;
        break;
      }
      s = pick(p.z0, p.z1, g1.j, g2.j);
      if (s > 0 && g1.j !== g2.j) {
        plots.splice(k, 1, { ...p, x0: p.x0, z0: p.z0, x1: p.x1, z1: s }, { ...p, x0: p.x0, z0: s, x1: p.x1, z1: p.z1 });
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
// Set pieces. Each returns the rectangle it claims (F, kept at least 4 cells
// from the block edge so the ring of plots around it can carry the spine) and
// its own plots.

function centreStart(len, rng) {
  const slack = Math.max(0, N - len - 8);
  const jit = Math.min(Math.floor(slack / 2), 2);
  return 4 + Math.floor(slack / 2) + Math.floor(rng() * (2 * jit + 1)) - jit;
}

function carveZiggurat(rng) {
  const rw = 3; // tier depth: a 2-cell flight plus a 1-cell landing
  const T = rng() < 0.45 ? 3 : 2;
  const sw = T === 3 ? 4 + 2 * Math.floor(rng() * 2) : 4 + Math.floor(rng() * 5);
  const sd = T === 3 ? 4 + 2 * Math.floor(rng() * 2) : 4 + Math.floor(rng() * 5);
  const Fw = 2 * T * rw + sw;
  const Fd = 2 * T * rw + sd;
  const x0 = centreStart(Fw, rng);
  const z0 = centreStart(Fd, rng);
  const rects = [];
  for (let k = 0; k < T; k++) {
    const X0 = x0 + k * rw;
    const Z0 = z0 + k * rw;
    const X1 = x0 + Fw - k * rw;
    const Z1 = z0 + Fd - k * rw;
    rects.push({ x0: X0, z0: Z0, x1: X1, z1: Z0 + rw, role: 'tier', tier: k, face: 3 });
    rects.push({ x0: X0, z0: Z1 - rw, x1: X1, z1: Z1, role: 'tier', tier: k, face: 1 });
    rects.push({ x0: X0, z0: Z0 + rw, x1: X0 + rw, z1: Z1 - rw, role: 'tier', tier: k, face: 2 });
    rects.push({ x0: X1 - rw, z0: Z0 + rw, x1: X1, z1: Z1 - rw, role: 'tier', tier: k, face: 0 });
  }
  rects.push({ x0: x0 + T * rw, z0: z0 + T * rw, x1: x0 + Fw - T * rw, z1: z0 + Fd - T * rw, role: 'summit', tier: T });
  const main = Math.floor(rng() * 4);
  const axes = [main];
  const r = rng();
  if (r < 0.35) axes.push((main + 2) % 4);
  else if (r < 0.6) axes.push((main + 1) % 4, (main + 2) % 4, (main + 3) % 4);
  return {
    kind: 'ziggurat',
    F: { x0, z0, x1: x0 + Fw, z1: z0 + Fd },
    rects,
    T,
    axes,
    plinth: rng() < 0.4 ? 1 : 0,
    colonnade: rng() < 0.4 ? 1 + Math.floor(rng() * T) : -1, // tier that gets an arcade
    shrine: rng() < 0.45 ? 'pavilion' : rng() < 0.6 ? 'statue' : 'obelisk',
  };
}

function carveCourt(rng, relief) {
  const w = 10 + Math.floor(rng() * 7);
  const d = 10 + Math.floor(rng() * 7);
  const x0 = centreStart(w, rng);
  const z0 = centreStart(d, rng);
  return {
    kind: 'court',
    F: { x0, z0, x1: x0 + w, z1: z0 + d },
    rects: [{ x0, z0, x1: x0 + w, z1: z0 + d, role: 'court' }],
    depth: rng() < 0.2 + 0.4 * relief ? 3 : 2,
    garden: rng() < 0.45,
  };
}

function carveCanal(rng) {
  const alongX = rng() < 0.5;
  const L = 16 + Math.floor(rng() * 9);
  const water = 2 + (rng() < 0.4 ? 1 : 0);
  const W = water + 4; // a 2-cell quay on each side
  const a0 = centreStart(L, rng);
  const c0 = centreStart(W, rng);
  const R = (a, c, a1, c1, extra) => (alongX ? { x0: a, z0: c, x1: a1, z1: c1, ...extra } : { x0: c, z0: a, x1: c1, z1: a1, ...extra });
  const rects = [
    R(a0, c0, a0 + L, c0 + 2, { role: 'quay', side: 0 }),
    R(a0, c0 + 2, a0 + L, c0 + 2 + water, { role: 'water' }),
    R(a0, c0 + 2 + water, a0 + L, c0 + W, { role: 'quay', side: 1 }),
  ];
  return { kind: 'canal', F: R(a0, c0, a0 + L, c0 + W, {}), rects, alongX, depth: 2 };
}

// A stepped water channel: two or three reaches, each a level below the last,
// with a weir between them and banks that step down beside the water.
function carveCascade(rng) {
  const alongX = rng() < 0.5;
  const K = rng() < 0.7 ? 3 : 2;
  const Ls = K === 3 ? 6 + Math.floor(rng() * 3) : 8 + Math.floor(rng() * 3);
  const L = K * Ls;
  const water = 2 + (rng() < 0.3 ? 1 : 0);
  const W = water + 4;
  const a0 = centreStart(L, rng);
  const c0 = centreStart(W, rng);
  const flip = rng() < 0.5; // the water runs towards -axis
  const down = alongX ? (flip ? 2 : 0) : flip ? 3 : 1;
  const R = (a, c, a1, c1, extra) => (alongX ? { x0: a, z0: c, x1: a1, z1: c1, ...extra } : { x0: c, z0: a, x1: c1, z1: a1, ...extra });
  const rects = [];
  for (let s = 0; s < K; s++) {
    const step = flip ? K - 1 - s : s;
    const s0 = a0 + s * Ls;
    const s1 = s0 + Ls;
    const common = { step, steps: K, down };
    rects.push(R(s0, c0, s1, c0 + 2, { role: 'bank', side: 0, outer: c0, ...common }));
    rects.push(R(s0, c0 + 2, s1, c0 + 2 + water, { role: 'water', ...common }));
    rects.push(R(s0, c0 + 2 + water, s1, c0 + W, { role: 'bank', side: 1, outer: c0 + W - 1, ...common }));
  }
  return { kind: 'cascade', F: R(a0, c0, a0 + L, c0 + W, {}), rects, alongX, steps: K, down, sluice: rng() < 0.65 };
}

// ---------------------------------------------------------------------------

export function generateStructure(seed, bx, bz) {
  const D = district(seed, bx, bz);
  const A = anchor(seed, bx, bz);
  const gates = blockGates(seed, bx, bz);
  let S = null;
  if (D.program !== 'terraces') S = build(seed, bx, bz, A, gates, D, D.program);
  if (!S) S = build(seed, bx, bz, A, gates, D, 'terraces');
  return S;
}

function build(seed, bx, bz, A, gates, D, program) {
  const rng = makeRng(hash2(seed ^ 0x51ab, bx, bz) ^ (program === 'terraces' ? 0 : 0x3c3c));
  const G = { max: 8 + Math.round(D.grain * 8), stopMid: 0.25 + 0.3 * D.grain, stopBig: 0.05 + 0.25 * D.grain, nest: 0.45 + 0.3 * D.relief, rings: 0 };

  // 1. plots: the set piece first, BSP for everything else
  const rects = [];
  let feat = null;
  if (program === 'ziggurat') feat = carveZiggurat(rng);
  else if (program === 'court') feat = carveCourt(rng, D.relief);
  else if (program === 'canal') feat = carveCanal(rng);
  else if (program === 'cascade') feat = carveCascade(rng);
  if (feat) {
    const F = feat.F;
    bsp(rng, 0, 0, N, F.z0, rects, G);
    bsp(rng, 0, F.z1, N, N, rects, G);
    bsp(rng, 0, F.z0, F.x0, F.z1, rects, G);
    bsp(rng, F.x1, F.z0, N, F.z1, rects, G);
  } else bsp(rng, 0, 0, N, N, rects, G);
  splitForGates(rects, gates);
  const plots = [...rects, ...(feat ? feat.rects : [])].map((r, id) => ({
    ...r,
    id,
    w: r.x1 - r.x0,
    d: r.z1 - r.z0,
    gate: -1,
    spine: false,
    building: false,
    well: false,
    water: r.role === 'water',
    feature: !!r.role,
    nearF: false,
    reachable: r.role !== 'water',
    level: 0,
    target: 0,
  }));
  const plotId = new Int16Array(N * N);
  for (const p of plots) {
    for (let j = p.z0; j < p.z1; j++) for (let i = p.x0; i < p.x1; i++) plotId[j * N + i] = p.id;
    p.target = targetLevel(seed, bx * N + (p.x0 + p.x1) / 2, bz * N + (p.z0 + p.z1) / 2, rng, D.relief);
  }
  for (const g of gates) plots[plotId[g.j * N + g.i]].gate = g.dir;
  buildAdjacency(plots);

  const minG = Math.min(...gates.map((g) => g.level));
  const maxG = Math.max(...gates.map((g) => g.level));
  // the level a set piece is built around
  const R = clamp(A, minG, maxG);
  if (feat) {
    for (const p of plots) {
      if (p.feature) continue;
      p.nearF = p.adj.some((e) => e.q.feature);
      if (p.nearF) p.target = R;
    }
  }

  // 2. spine through the gate plots (around the set piece, never through it)
  const gatePlots = gates.map((g) => plots[plotId[g.j * N + g.i]]);
  const allow = (q) => !q.feature && !q.nest;
  let tree = bfsTree(gatePlots[0], 2, allow);
  if (!gatePlots.every((p) => tree.has(p))) tree = bfsTree(gatePlots[0], 1, allow);
  if (feat && !gatePlots.every((p) => tree.has(p))) return null;
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
  // Spine levels stay within a two-level band that holds every gate, so each
  // step along it is at most two levels. Where the gates agree the band still
  // leaves room to rise or sink.
  let spineSum = 0;
  let spineN = 0;
  for (const p of plots) if (p.spine && p.gate < 0) [spineSum, spineN] = [spineSum + p.target, spineN + 1];
  const lo = clamp(Math.round(spineN ? spineSum / spineN : A) - 1, maxG - 2, minG);
  for (const p of plots) {
    if (!p.spine) continue;
    if (p.gate >= 0) p.level = gates[p.gate].level;
    else if (p.nearF) p.level = R;
    else p.level = clamp(p.target, lo, lo + 2);
  }

  // 3. buildings (and a few sunken wells) among the rest
  const dense = 1 - D.grain;
  for (const p of plots) {
    if (p.spine || p.feature || p.ring !== undefined) continue;
    const area = p.w * p.d;
    if (area > 72) continue;
    let pb = (area <= 24 ? 0.46 : area <= 48 ? 0.32 : 0.2) * (0.7 + 0.6 * dense);
    if (p.nearF) pb *= 0.45;
    const r = rng();
    if (r < pb) p.building = true;
    else if (r < pb + 0.1 && area >= 20 && !p.nearF) p.well = true;
  }

  // 4. grow terraces off the spine; steep districts take bigger steps
  const queue = plots.filter((p) => p.spine);
  const seen = new Set(queue);
  const ringLevel = new Map();
  for (const p of queue) if (p.ring !== undefined && !p.nest && !ringLevel.has(p.ring)) ringLevel.set(p.ring, p.level);
  while (queue.length) {
    const p = queue.shift();
    for (const e of p.adj) {
      const q = e.q;
      if (seen.has(q) || q.building || q.well || q.feature || e.hi - e.lo < 2) continue;
      // a ring keeps one level; its nested plot sits a step or two off it
      if (q.nest) {
        if (p.ring !== q.ring) continue;
        seen.add(q);
        q.level = p.level + q.nest;
        link(p, q, true);
        queue.push(q);
        continue;
      }
      if (q.ring !== undefined && ringLevel.has(q.ring)) {
        const lv = ringLevel.get(q.ring);
        if (Math.abs(lv - p.level) > MAX_RISE) continue;
        seen.add(q);
        q.level = lv;
        link(p, q, true);
        queue.push(q);
        continue;
      }
      seen.add(q);
      const diff = q.target - p.level;
      let delta = clamp(diff, -1, 1);
      if (q.nearF && rng() < 0.7) delta = clamp(diff, -2, 2);
      else if (Math.abs(diff) >= 2 && rng() < 0.3 + 0.45 * D.relief) delta = Math.sign(diff) * (Math.abs(diff) >= 3 && rng() < 0.2 + 0.6 * D.relief ? 3 : 2);
      else if (delta === 0 && rng() < 0.45 + 0.4 * D.relief) delta = rng() < 0.5 ? -1 : 1;
      else if (rng() < 0.03 + 0.15 * (1 - D.relief)) delta = 0;
      q.level = p.level + delta;
      if (q.ring !== undefined) ringLevel.set(q.ring, q.level);
      link(p, q, true);
      queue.push(q);
    }
  }
  // Terraces off the network sink below their surroundings: wells of shade.
  for (const p of plots) {
    if (p.building || p.feature || seen.has(p)) continue;
    p.reachable = false;
    let low = Infinity;
    for (const e of p.adj) if (!e.q.building && seen.has(e.q)) low = Math.min(low, e.q.level);
    if (low === Infinity) low = p.target;
    p.level = low - 1 - Math.floor(rng() * (p.well ? 3 : 2));
  }

  // 5. the set piece takes its levels from the ring around it
  const axial = [];
  if (feat) programLevels(feat, plots, plotId, link, axial, rng);

  // 6. buildings take their height from their surroundings
  for (const p of plots) {
    if (!p.building) continue;
    let top = A;
    for (const e of p.adj) if (!e.q.building && !e.q.water) top = Math.max(top, e.q.level);
    const area = p.w * p.d;
    p.tower = area <= 20 && rng() < 0.6;
    p.level = top + 1 + (p.tower ? 1 + Math.floor(rng() * (2 + D.relief * 1.5)) : rng() < 0.3 + 0.3 * D.relief ? 1 : 0);
    const r = rng();
    if (p.tower) p.roof = r < 0.4 ? 'minaret' : 'pyramid';
    else p.roof = r < 0.4 ? 'hip' : r < 0.58 && Math.abs(p.w - p.d) <= 2 ? 'dome' : 'flat';
  }

  // 7. extra loops between terraces
  for (const p of plots) {
    if (p.building || p.feature || !p.reachable) continue;
    for (const e of p.adj) {
      const q = e.q;
      if (q.id < p.id || q.building || q.feature || !q.reachable) continue;
      const d = Math.abs(q.level - p.level);
      if (d >= 1 && d <= 2 && e.hi - e.lo >= 2 && rng() < 0.35) link(p, q, false);
    }
  }

  // 8. cells
  const kind = new Uint8Array(N * N);
  const base = new Float32Array(N * N);
  const stairOf = new Int16Array(N * N).fill(-1);
  const used = new Uint8Array(N * N); // 1 stair/landing, 2 reserved, 3 feature
  const deck = new Float32Array(N * N).fill(NaN);
  const dblock = new Uint8Array(N * N);
  for (const p of plots) {
    for (let j = p.z0; j < p.z1; j++) {
      for (let i = p.x0; i < p.x1; i++) {
        const c = j * N + i;
        kind[c] = p.building ? K_BUILDING : p.water ? K_WATER : K_FLOOR;
        base[c] = p.level * LEVEL_H - (p.water ? WATER_DROP : 0);
      }
    }
  }
  for (const g of gates) {
    used[g.j * N + g.i] = 2;
    const ii = g.i - DX[g.dir];
    const jj = g.j - DZ[g.dir];
    if (plotId[jj * N + ii] === plotId[g.j * N + g.i]) used[jj * N + ii] = 2;
  }

  // 9. stairs: the set piece's axial flights first, then everything else
  const stairs = [];
  const bridges = [];
  const ctx = { rng, plots, plotId, kind, base, stairOf, used, stairs, deck, dblock, bridges };
  for (const a of axial) if (!placeAxial(ctx, a.low, a.high, a.b0, a.w)) link(a.low, a.high, true);
  let failed = 0;
  for (const l of links) {
    const { a, b } = l;
    if (a.level === b.level) continue;
    const low = a.level < b.level ? a : b;
    const high = low === a ? b : a;
    if (stairs.some((s) => (s.low === low.id && s.high === high.id))) continue;
    const ok = placeStair(ctx, low, high);
    if (!ok && l.required) failed++;
  }

  // 10. what can actually be walked to; retry stairs for anything cut off
  repairReach(ctx);

  // 11. bridges over whatever lies deep enough below
  let want = 0;
  if (feat && feat.kind === 'canal') want = 2 + (rng() < 0.45 ? 1 : 0);
  else if (feat && feat.kind === 'cascade') want = 1 + (rng() < 0.45 ? 1 : 0);
  else if (feat && feat.kind === 'court') want = 1 + (rng() < 0.3 ? 1 : 0);
  else if (rng() < 0.3 + 0.5 * D.relief) want = 1 + (rng() < 0.35 ? 1 : 0);
  if (want) placeBridges(ctx, want, feat);

  return {
    bx,
    bz,
    seed,
    anchor: A,
    program: feat ? feat.kind : 'terraces',
    district: D,
    feature: feat ? { kind: feat.kind, F: feat.F, shrine: feat.shrine, colonnade: feat.colonnade, garden: feat.garden, alongX: feat.alongX, axes: feat.axes, steps: feat.steps, down: feat.down, sluice: feat.sluice } : null,
    gates,
    plots: plots.map(({ adj, ...p }) => ({ ...p, adj: adj.map((e) => ({ q: e.q.id, dir: e.dir, lo: e.lo, hi: e.hi, line: e.line })) })),
    plotId,
    kind,
    base,
    stairOf,
    used,
    stairs,
    deck,
    dblock,
    bridges,
    failedLinks: failed,
  };
}

// Levels and links of a set piece, once the ring of plots around it is settled.
function programLevels(feat, plots, plotId, link, axial, rng) {
  const F = feat.F;
  const fp = plots.filter((p) => p.feature);
  const outside = (p) => !p.feature && !p.building && p.reachable;
  // the level most of the ring around the set piece sits at, weighted by frontage
  const votes = new Map();
  for (const p of fp) {
    for (const e of p.adj) {
      if (!outside(e.q)) continue;
      votes.set(e.q.level, (votes.get(e.q.level) || 0) + (e.hi - e.lo));
    }
  }
  let ring = null;
  let best = -1;
  for (const [lv, v] of votes) if (v > best) [best, ring] = [v, lv];
  if (ring === null) ring = fp[0].target;

  const joinRing = (p, max) => {
    // stairs from the ring of plots around, longest frontage first
    const cand = p.adj.filter((e) => outside(e.q) && Math.abs(e.q.level - p.level) <= MAX_RISE && e.hi - e.lo >= 2);
    cand.sort((a, b) => b.hi - b.lo - (a.hi - a.lo) || a.q.id - b.q.id);
    let n = 0;
    for (const e of cand) {
      if (n >= max) break;
      if (e.q.level !== p.level) link(e.q, p, n === 0);
      n++;
    }
    return n;
  };

  if (feat.kind === 'ziggurat') {
    const cx = (F.x0 + F.x1) / 2;
    const cz = (F.z0 + F.z1) / 2;
    // the ground at the foot of the main stair sets the base
    const m = feat.axes[0];
    const foot = axisFoot(F, m);
    const fplot = plots[plotId[foot[1] * N + foot[0]]];
    const B = outside(fplot) ? fplot.level : ring;
    for (const p of fp) p.level = B + feat.plinth + p.tier;
    const tierPlot = (t, face) => fp.find((p) => p.role === 'tier' && p.tier === t && p.face === face);
    const summit = fp.find((p) => p.role === 'summit');
    for (const face of feat.axes) {
      const along = face % 2 === 1 ? cx : cz;
      const W = (face % 2 === 1 ? summit.w : summit.d) % 2 === 0 ? 2 : 3;
      const b0 = Math.round(along - W / 2);
      for (let t = 0; t < feat.T; t++) axial.push({ low: tierPlot(t, face), high: t + 1 < feat.T ? tierPlot(t + 1, face) : summit, b0, w: W });
      // from the ground up onto the lowest tier
      const [fi, fj] = axisFoot(F, face);
      const g = plots[plotId[fj * N + fi]];
      const t0 = tierPlot(0, face);
      if (outside(g) && g.level < t0.level && t0.level - g.level <= MAX_RISE) axial.push({ low: g, high: t0, b0, w: W });
      else if (outside(g) && g.level !== t0.level && Math.abs(g.level - t0.level) <= MAX_RISE) link(g, t0, false);
    }
  } else if (feat.kind === 'court') {
    const p = fp[0];
    p.level = ring - feat.depth;
    joinRing(p, 2 + (rng() < 0.4 ? 1 : 0));
  } else if (feat.kind === 'canal') {
    for (const p of fp) p.level = ring - feat.depth;
    for (const p of fp) if (p.role === 'quay') joinRing(p, 1 + (rng() < 0.5 ? 1 : 0));
  } else if (feat.kind === 'cascade') {
    for (const p of fp) p.level = ring - 1 - p.step;
    const banks = fp.filter((p) => p.role === 'bank');
    for (const p of banks) {
      // a narrow flight down to the next reach, against the outer wall
      const next = banks.find((q) => q.side === p.side && q.step === p.step + 1);
      if (next) axial.push({ low: next, high: p, b0: p.outer, w: 1 });
    }
    for (const p of banks) if (p.step === 0 || p.step === feat.steps - 1 || rng() < 0.5) joinRing(p, 1);
  }
}

// The ground cell in front of the middle of face d of rectangle F.
function axisFoot(F, d) {
  const cx = Math.floor((F.x0 + F.x1) / 2);
  const cz = Math.floor((F.z0 + F.z1) / 2);
  if (d === 0) return [F.x1, cz];
  if (d === 2) return [F.x0 - 1, cz];
  if (d === 1) return [cx, F.z1];
  return [cx, F.z0 - 1];
}

// Flood the plots over same-level frontage, stairs and bridges from the spine.
function reachedPlots(ctx) {
  const { plots, stairs, bridges } = ctx;
  const walk = (p) => !p.building && !p.water;
  const nb = plots.map(() => []);
  for (const p of plots) {
    if (!walk(p)) continue;
    for (const e of p.adj) if (walk(e.q) && e.q.level === p.level) nb[p.id].push(e.q.id);
  }
  for (const s of stairs) {
    nb[s.low].push(s.high);
    nb[s.high].push(s.low);
  }
  for (const b of bridges) {
    nb[b.pa].push(b.pb);
    nb[b.pb].push(b.pa);
  }
  const seen = new Uint8Array(plots.length);
  const stack = plots.filter((p) => p.spine).map((p) => p.id);
  for (const id of stack) seen[id] = 1;
  while (stack.length) {
    const id = stack.pop();
    for (const q of nb[id]) {
      if (seen[q]) continue;
      seen[q] = 1;
      stack.push(q);
    }
  }
  return seen;
}

function repairReach(ctx) {
  const { plots } = ctx;
  for (let round = 0; round < 6; round++) {
    const seen = reachedPlots(ctx);
    let fixed = false;
    for (const p of plots) {
      if (seen[p.id] || !p.reachable || p.building || p.water) continue;
      const cand = p.adj.filter((e) => seen[e.q.id] && !e.q.building && !e.q.water && e.q.level !== p.level && Math.abs(e.q.level - p.level) <= MAX_RISE);
      cand.sort((a, b) => b.hi - b.lo - (a.hi - a.lo));
      for (const e of cand) {
        const low = e.q.level < p.level ? e.q : p;
        const high = low === p ? e.q : p;
        if (placeStair(ctx, low, high)) {
          fixed = true;
          break;
        }
      }
    }
    if (!fixed) break;
  }
  const seen = reachedPlots(ctx);
  for (const p of plots) if (!seen[p.id]) p.reachable = false;
}

// ---------------------------------------------------------------------------
// Bridges: straight decks, one cell wide, between two terraces at the same
// level across ground that lies at least two levels lower (or water).

function placeBridges(ctx, want, feat) {
  const { rng, plots, plotId, kind, base, used, deck } = ctx;
  const cands = [];
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const a = j * N + i;
      if (kind[a] !== K_FLOOR || used[a] !== 0) continue;
      const P = plots[plotId[a]];
      if (!P.reachable) continue;
      const y = base[a];
      for (const d of [0, 1]) {
        const cells = [];
        let b = -1;
        for (let k = 1; k <= 17; k++) {
          const ii = i + DX[d] * k;
          const jj = j + DZ[d] * k;
          if (ii >= N || jj >= N) break;
          const c = jj * N + ii;
          if (kind[c] === K_FLOOR && Math.abs(base[c] - y) < 0.01) {
            b = c;
            break;
          }
          const low = kind[c] === K_WATER || (kind[c] === K_FLOOR && base[c] <= y - BRIDGE_CLEAR + 0.01);
          if (!low || used[c] !== 0 || deck[c] === deck[c]) break;
          // open air on both sides: nothing alongside reaches up to the deck
          const side = [1, -1].every((sg) => {
            const si = ii + DZ[d] * sg;
            const sj = jj + DX[d] * sg;
            if (si < 0 || sj < 0 || si >= N || sj >= N) return false;
            const sc = sj * N + si;
            return kind[sc] === K_WATER || ((kind[sc] === K_FLOOR || kind[sc] === K_STAIR || kind[sc] === K_LANDING) && base[sc] <= y - LEVEL_H + 0.01 && (kind[sc] === K_FLOOR || stairTop(ctx, sc) <= y - 2.4));
          });
          if (!side) break;
          cells.push(c);
        }
        if (b < 0 || cells.length < 2 || used[b] !== 0) continue;
        // long spans only over a set piece
        if (cells.length > 8 && !cells.every((c) => plots[plotId[c]].feature)) continue;
        const Q = plots[plotId[b]];
        if (!Q.reachable || Q === P) continue;
        let score = rng() + (cells.length >= 3 && cells.length <= 7 ? 0.6 : 0);
        if (feat && cells.some((c) => plots[plotId[c]].feature)) score += 3;
        // bridges over a set piece keep clear of its ends and sit on its rhythm
        if (feat) {
          const F = feat.F;
          const pos = d === 0 ? j : i;
          const lo = d === 0 ? F.z0 : F.x0;
          const hi = d === 0 ? F.z1 : F.x1;
          if (pos >= lo && pos < hi) {
            const u = (pos + 0.5 - lo) / (hi - lo);
            if (pos - lo < 3 || hi - 1 - pos < 3) score -= 2.5;
            if (feat.kind === 'canal') score -= Math.min(Math.abs(u - 0.5), Math.abs(u - 0.2), Math.abs(u - 0.8)) * 4;
            else if (feat.kind === 'cascade') {
              // over the middle of a reach, never over a weir
              const r = u * feat.steps;
              score -= Math.abs((r % 1) - 0.5) * 4;
            }
            else score -= Math.abs(u - 0.5) * 3;
          }
        }
        cands.push({ a, b, d, cells, y, score, pa: P.id, pb: Q.id });
      }
    }
  }
  cands.sort((p, q) => q.score - p.score);
  const taken = [];
  const gap = feat && feat.kind === 'canal' ? 5 : 3;
  for (const c of cands) {
    if (taken.length >= want) break;
    const ci = c.a % N;
    const cj = Math.floor(c.a / N);
    let clash = false;
    for (const t of taken) {
      if (t.d !== c.d) {
        // crossing spans would share a cell
        const cellsT = new Set([t.a, t.b, ...t.cells]);
        if ([c.a, c.b, ...c.cells].some((x) => cellsT.has(x))) clash = true;
        continue;
      }
      const ti = t.a % N;
      const tj = Math.floor(t.a / N);
      const lateral = c.d === 0 ? Math.abs(cj - tj) : Math.abs(ci - ti);
      const along0 = c.d === 0 ? ci : cj;
      const along1 = along0 + c.cells.length + 1;
      const tAlong0 = t.d === 0 ? ti : tj;
      const tAlong1 = tAlong0 + t.cells.length + 1;
      if (lateral < gap && along0 <= tAlong1 && tAlong0 <= along1) clash = true;
    }
    if (clash || [c.a, c.b, ...c.cells].some((x) => used[x] !== 0)) continue;
    taken.push(c);
    commitBridge(ctx, c);
  }
}

function stairTop(ctx, c) {
  const s = ctx.stairs[ctx.stairOf[c]];
  return s ? s.hT : ctx.base[c];
}

function commitBridge(ctx, c) {
  const { kind, base, used, deck, dblock, bridges, plots, plotId } = ctx;
  const n = c.cells.length;
  const side = [(c.d + 1) % 4, (c.d + 3) % 4];
  for (const x of c.cells) {
    deck[x] = c.y;
    used[x] = 2;
    for (const s of side) dblock[x] |= 1 << s;
  }
  used[c.a] = 2;
  used[c.b] = 2;
  // Piers stand on the cell boundaries under the deck. Try every set of them and
  // keep the most regular arcade that never leaves a gap wider than 4 cells.
  const ground = c.cells.map((x) => (kind[x] === K_WATER ? base[x] : base[x]));
  const allowed = [];
  const preferred = [];
  for (let t = 1; t < n; t++) {
    const p = c.cells[t - 1];
    const q = c.cells[t];
    const step = Math.abs(base[p] - base[q]) > 0.01;
    const wet = kind[p] === K_WATER || kind[q] === K_WATER;
    const P = plots[plotId[p]];
    const roomy = P === plots[plotId[q]] && (c.d === 0 ? P.d : P.w) >= 3;
    if (step || wet || roomy) allowed.push(t);
    if (step || (wet && kind[p] !== kind[q])) preferred.push(t);
  }
  let bestSet = [];
  let bestCost = Infinity;
  for (let m = 0; m < 1 << allowed.length; m++) {
    const piers = allowed.filter((_, k) => m & (1 << k));
    const cuts = [0, ...piers, n];
    const spans = [];
    for (let k = 1; k < cuts.length; k++) spans.push(cuts[k] - cuts[k - 1]);
    if (spans.some((s) => s > 4)) continue;
    let cost = 0;
    for (const s of spans) cost += (s - 3) * (s - 3);
    for (const p of piers) cost += preferred.includes(p) ? 0.1 : 0.6;
    cost += piers.length * 0.5;
    for (let k = 0; k < spans.length; k++) if (spans[k] !== spans[spans.length - 1 - k]) cost += 1.5;
    if (cost < bestCost) [bestCost, bestSet] = [cost, piers];
  }
  bridges.push({
    id: bridges.length,
    a: c.a,
    b: c.b,
    i0: c.cells[0] % N,
    j0: Math.floor(c.cells[0] / N),
    d: c.d,
    n,
    y: c.y,
    cells: c.cells,
    ground,
    piers: bestSet,
    pa: c.pa,
    pb: c.pb,
    striped: ctx.rng() < 0.45,
    gate: ctx.rng() < 0.35,
  });
}

// ---------------------------------------------------------------------------
// Straight flight up the axis of a set piece, cut into the upper plot.
function placeAxial(ctx, low, high, b0, w) {
  const e = adjRecord(low, high);
  if (!e) return false;
  const d = high.level - low.level;
  if (d < 1 || d > MAX_RISE) return false;
  const n = d * STAIR_CELLS_PER_LEVEL;
  const lowDepth = e.dir % 2 === 0 ? low.w : low.d;
  const highDepth = e.dir % 2 === 0 ? high.w : high.d;
  for (let k = 0; k <= n; k++) {
    if (k + 1 > lowDepth || n - k + 1 > highDepth) continue;
    if (placePerp(ctx, e, low, high, b0, w, k, n)) return true;
  }
  return false;
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
  if (d < 1 || d > MAX_RISE) return false;
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
