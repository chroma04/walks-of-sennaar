// Second generation phase: furnish terraces (cloisters, fountains, planters,
// arcades, statues, shrines...), place where the devotees start out, and record
// collision shapes. Needs read access to neighbouring blocks' structure through
// look(i, j) for block-local cells that may lie outside the block.

import { BLOCK, CELL, LEVEL_H, K_FLOOR, K_STAIR, K_BUILDING, K_LANDING, K_WATER, DX, DZ, M } from '../config.js';
import { hash2, makeRng } from './rng.js';
import { WATER_DROP } from './layout.js';

const N = BLOCK;

export function decorate(S, look) {
  const rng = makeRng(hash2(S.seed ^ 0xdec0, S.bx, S.bz));
  const out = {
    feats: [],
    circles: [], // [x, z, r, floorY]
    boxes: [], // [x0, z0, x1, z1, floorY]
    floorMat: new Uint8Array(N * N),
    eblock: new Uint8Array(N * N),
    band0: [],
    spawns: [], // devotees: [{ x, y, z, rot, mode, seed, count }]
  };
  const used = S.used.slice();
  // quiet: cells whose ground-floor wall stays plain (a relief, a fountain or a
  // rill's spout stands there instead of a window)
  const ctx = { S, look, rng, out, used, abut: new Set(), quiet: new Set() };
  for (const b of S.bridges) ctx.abut.add(b.a).add(b.b);

  // lock gates first: their winches claim quay cells before anything else
  if (S.feature && S.feature.kind === 'canal') for (const P of S.plots) if (P.water) lockGates(ctx, P);
  for (const P of S.plots) {
    if (P.building) decorateBuilding(ctx, P);
    else if (P.water) decorateWater(ctx, P);
    else decorateTerrace(ctx, P);
  }
  decorateStairs(ctx);
  decorateBridges(ctx);
  procession(ctx);
  return out;
}

const hasDeck = (ctx, i, j) => {
  const v = ctx.S.deck[j * N + i];
  return v === v;
};

// ---------------------------------------------------------------------------

function sideCells(P, d) {
  const cells = [];
  if (d === 0) for (let j = P.z0; j < P.z1; j++) cells.push([P.x1 - 1, j]);
  else if (d === 2) for (let j = P.z0; j < P.z1; j++) cells.push([P.x0, j]);
  else if (d === 1) for (let i = P.x0; i < P.x1; i++) cells.push([i, P.z1 - 1]);
  else for (let i = P.x0; i < P.x1; i++) cells.push([i, P.z0]);
  return cells;
}

function sideInfo(ctx, P, d) {
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

function runs(arr, pred) {
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

function regionUsed(ctx, x0, z0, x1, z1, allow2 = false) {
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
function roomFor(ctx, P, cells) {
  const { S } = ctx;
  const take = new Set(cells.map(([i, j]) => j * N + i));
  const floor = (c) => S.kind[c] === K_FLOOR || S.kind[c] === K_LANDING;
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

function mark(ctx, x0, z0, x1, z1, v = 3) {
  for (let j = z0; j < z1; j++) for (let i = x0; i < x1; i++) ctx.used[j * N + i] = v;
}

function inside(P, i, j) {
  return i >= P.x0 && i < P.x1 && j >= P.z0 && j < P.z1;
}

function blockEdge(ctx, i, j, d) {
  if (i >= 0 && j >= 0 && i < N && j < N) ctx.out.eblock[j * N + i] |= 1 << d;
  const ni = i + DX[d];
  const nj = j + DZ[d];
  if (ni >= 0 && nj >= 0 && ni < N && nj < N) ctx.out.eblock[nj * N + ni] |= 1 << ((d + 2) % 4);
}

// ---------------------------------------------------------------------------

function decorateTerrace(ctx, P) {
  const { rng, out } = ctx;
  const y = P.level * LEVEL_H;
  let sides = [0, 1, 2, 3].map((d) => sideInfo(ctx, P, d));
  const area = P.w * P.d;

  // Hidden gardens: terraces nobody can reach become lawns with trees.
  if (!P.reachable && P.w >= 4 && P.d >= 4) {
    for (let j = P.z0 + 1; j < P.z1 - 1; j++) for (let i = P.x0 + 1; i < P.x1 - 1; i++) out.floorMat[j * N + i] = M.GRASS;
    const trees = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < trees; k++) {
      const i = P.x0 + 1 + Math.floor(rng() * (P.w - 2));
      const j = P.z0 + 1 + Math.floor(rng() * (P.d - 2));
      if (ctx.used[j * N + i] !== 0) continue;
      out.feats.push({ t: 'palm', x: (i + 0.5) * CELL, z: (j + 0.5) * CELL, y, pot: false, s: 0.9 + rng() * 0.5, seed: rng() * 1e6 });
    }
  }

  const F = ctx.S.feature;
  let program = P.role || (P.nest < 0 ? 'parterre' : 'plaza');
  if (program === 'plaza' && P.reachable && P.w >= 9 && P.d >= 9 && !regionUsed(ctx, P.x0 + 1, P.z0 + 1, P.x1 - 1, P.z1 - 1) && rng() < 0.55) {
    program = 'cloister';
    cloister(ctx, P, y);
  }
  // set pieces furnish themselves; the generic scatter below stays off them
  const open = program === 'plaza';
  if (open && P.reachable && area >= 24 && rng() < 0.1 + 0.3 * ctx.S.district.wet && rill(ctx, P, y, sides)) sides = [0, 1, 2, 3].map((d) => sideInfo(ctx, P, d));
  if (program === 'summit' && P.reachable) shrine(ctx, P, y, F.shrine);
  else if (program === 'court' && P.reachable) court(ctx, P, y, F.garden);
  else if (program === 'parterre' && P.reachable) court(ctx, P, y, rng() < 0.55);
  else if (program === 'quay') quay(ctx, P, y);
  else if (open && P.reachable) centrePiece(ctx, P, y);

  // Walls rising from this terrace: planters, benches, doors, ground-floor windows.
  for (let d = 0; d < 4; d++) {
    const s = sides[d];
    const out_ = (d + 2) % 4; // direction facing back into the plot
    for (const run of runs(s, (e) => e.rel === 'up' && e.wall >= LEVEL_H - 0.05)) {
      let doorAt = -1;
      if (rng() < (program === 'quay' ? 0.8 : 0.5)) {
        const cand = run.filter((e) => e.u !== 1 && e.u !== 3);
        if (cand.length) doorAt = cand[Math.floor(rng() * cand.length)].t;
      }
      const planter = new Set();
      const piece = wallPieces(ctx, P, run, d, y, doorAt, program);
      if (program !== 'cloister' && program !== 'summit' && P.reachable) {
        // (usage read afresh: a centrepiece may have claimed cells since)
        const u = (e) => ctx.used[e.j * N + e.i];
        for (let k = 0; k < run.length; k++) {
          const e = run[k];
          if (e.t === doorAt || u(e) !== 0 || piece.has(e.t) || rng() > (program === 'tier' ? 0.3 : 0.22)) continue;
          let len = 0;
          const want = 2 + Math.floor(rng() * 2);
          while (k + len < run.length && len < want && u(run[k + len]) === 0 && run[k + len].t !== doorAt && !piece.has(run[k + len].t)) len++;
          if (len < 1) continue;
          const seg = run.slice(k, k + len);
          if (!roomFor(ctx, P, seg.map((q) => [q.i, q.j]))) continue;
          placePlanter(ctx, seg, d, y);
          for (const q of seg) planter.add(q.t);
          k += len;
        }
      }
      for (const e of run) {
        if (e.u === 1) continue;
        const isDoor = e.t === doorAt;
        const quiet = planter.has(e.t) || piece.has(e.t) || ctx.quiet.has(e.j * N + e.i);
        out.band0.push({ i: e.i, j: e.j, d, y, door: isDoor, low: quiet, owner: [e.owner.bx, e.owner.bz, e.owner.plot] });
        // (not in the one-cell walk round a cloister, which a bench would close)
        if (!isDoor && !quiet && ctx.used[e.j * N + e.i] === 0 && P.reachable && program !== 'summit' && program !== 'cloister' && rng() < (program === 'quay' ? 0.12 : 0.06) && roomFor(ctx, P, [[e.i, e.j]])) {
          // bench against the wall
          const [cx, cz] = edgeCentre(e.i, e.j, d);
          const inset = 0.45;
          out.feats.push({ t: 'bench', x: cx - DX[d] * inset, z: cz - DZ[d] * inset, y, rot: dirAngle(out_) });
          out.boxes.push(orientedBox(cx - DX[d] * inset, cz - DZ[d] * inset, d, 1.5, 0.5, y));
          ctx.used[e.j * N + e.i] = 3;
        }
      }
    }
  }

  // Arcade screens along drops, 2 m in from the balustrade. A ziggurat may
  // wrap one of its tiers in them.
  const colonnade = program === 'tier' && F.colonnade === P.tier;
  if ((open || colonnade) && P.reachable) {
    for (let d = 0; d < 4; d++) {
      for (const run of runs(sides[d], (e) => e.rel === 'down' && e.u === 0)) {
        if (run.length < (colonnade ? 2 : 4) || rng() > (colonnade ? 1 : 0.32)) continue;
        const inner = run.every((e) => {
          const ii = e.i - DX[d];
          const jj = e.j - DZ[d];
          return inside(P, ii, jj) && ctx.used[jj * N + ii] === 0;
        });
        if (!inner) continue;
        const a = run[0];
        const b = run[run.length - 1];
        let [ax, az] = arcadeEnd(a.i, a.j, d, -1);
        let [bx, bz] = arcadeEnd(b.i, b.j, d, 1);
        // end columns never overhang a stair or a drop beyond the run
        const ux = DZ[d] !== 0 ? 1 : 0;
        const uz = DX[d] !== 0 ? 1 : 0;
        const level = (i, j) => {
          const n = ctx.look(i, j);
          return n.kind !== K_STAIR && n.kind !== K_BUILDING && Math.abs(n.base - y) < 0.01;
        };
        if (!level(a.i - ux, a.j - uz) || !level(a.i - ux - DX[d], a.j - uz - DZ[d])) {
          ax += ux * 0.4;
          az += uz * 0.4;
        }
        if (!level(b.i + ux, b.j + uz) || !level(b.i + ux - DX[d], b.j + uz - DZ[d])) {
          bx -= ux * 0.4;
          bz -= uz * 0.4;
        }
        out.feats.push({ t: 'arcade', ax, az, bx, bz, y, d });
        const len = Math.hypot(bx - ax, bz - az);
        const n = Math.round(len / CELL);
        for (let k = 0; k <= n; k++) {
          const f = k / n;
          out.circles.push([ax + (bx - ax) * f, az + (bz - az) * f, 0.28, y]);
        }
        for (const e of run) {
          ctx.used[e.j * N + e.i] = 2;
          ctx.used[(e.j - DZ[d]) * N + (e.i - DX[d])] = 2;
        }
      }
    }
  }

  // Potted plants and benches along the balustrades (in step on a ziggurat)
  if ((open || program === 'tier' || program === 'court') && P.reachable) {
    const tierPots = program === 'tier' ? rng() < 0.6 : false;
    for (let d = 0; d < 4; d++) {
      for (const run of runs(sides[d], (e) => e.rel === 'down')) {
        if (run.length < 3 || rng() > (program === 'tier' ? (tierPots ? 1 : 0) : 0.5)) continue;
        const benches = program !== 'tier' && rng() < 0.3;
        for (let k = 1; k < run.length - 1; k += 2 + (rng() < 0.5 ? 1 : 0)) {
          const e = run[k];
          if (ctx.used[e.j * N + e.i] !== 0 || !roomFor(ctx, P, [[e.i, e.j]])) continue;
          const [cx, cz] = edgeCentre(e.i, e.j, d);
          if (benches) {
            const x = cx - DX[d] * 0.62;
            const z = cz - DZ[d] * 0.62;
            out.feats.push({ t: 'bench', x, z, y, rot: dirAngle(d) });
            out.boxes.push(orientedBox(x, z, d, 1.5, 0.5, y));
          } else {
            const x = cx - DX[d] * 0.62;
            const z = cz - DZ[d] * 0.62;
            const r = rng();
            if (r < 0.4) out.feats.push({ t: 'palm', x, z, y, pot: true, s: 0.75 + rng() * 0.35, seed: rng() * 1e6 });
            else out.feats.push({ t: 'potplant', x, z, y, k: r < 0.75 ? 'agave' : 'broadleaf', seed: rng() * 1e6 });
            out.circles.push([x, z, 0.5, y]);
          }
          ctx.used[e.j * N + e.i] = 3;
        }
      }
    }
  }

  // Corners
  const corners = [
    [P.x0, P.z0, 2, 3],
    [P.x1 - 1, P.z0, 0, 3],
    [P.x1 - 1, P.z1 - 1, 0, 1],
    [P.x0, P.z1 - 1, 2, 1],
  ];
  for (const [i, j, da, db] of corners) {
    const ra = sides[da].find((e) => e.i === i && e.j === j)?.rel;
    const rb = sides[db].find((e) => e.i === i && e.j === j)?.rel;
    const cx = (i + 0.5) * CELL + DX[da] * 0.35 + DX[db] * 0.35;
    const cz = (j + 0.5) * CELL + DZ[da] * 0.35 + DZ[db] * 0.35;
    if (ra === 'down' && rb === 'down' && !ctx.abut.has(j * N + i) && !hasDeck(ctx, i, j) && (program === 'tier' || rng() < 0.45)) {
      // pinnacle pier on the outer corner of the balustrade
      const px = (i + 0.5 + DX[da] * 0.5 + DX[db] * 0.5) * CELL - (DX[da] + DX[db]) * 0.16;
      const pz = (j + 0.5 + DZ[da] * 0.5 + DZ[db] * 0.5) * CELL - (DZ[da] + DZ[db]) * 0.16;
      out.feats.push({ t: 'pinnacle', x: px, z: pz, y, h: 2.6 + rng() * 1.6 });
      out.boxes.push([px - 0.4, pz - 0.4, px + 0.4, pz + 0.4, y]);
      continue;
    }
    if (!P.reachable || ctx.used[j * N + i] !== 0 || !roomFor(ctx, P, [[i, j]])) continue;
    if (ra === 'up' && rb === 'up' && rng() < 0.5) {
      if (rng() < 0.5) {
        out.feats.push({ t: 'urns', x: cx, z: cz, y, n: 1 + Math.floor(rng() * 3), seed: rng() * 1e6 });
        out.circles.push([cx, cz, 0.7, y]);
      } else {
        out.feats.push({ t: 'palm', x: cx, z: cz, y, pot: true, s: 0.8 + rng() * 0.4, seed: rng() * 1e6 });
        out.circles.push([cx, cz, 0.5, y]);
      }
      ctx.used[j * N + i] = 3;
    } else if (rng() < 0.12) {
      out.feats.push({ t: 'urns', x: cx, z: cz, y, n: 1, seed: rng() * 1e6 });
      out.circles.push([cx, cz, 0.4, y]);
      ctx.used[j * N + i] = 3;
    }
  }

  // Big plazas get a scatter of potted palms, urns and benches.
  if (open && P.reachable && area >= 42) {
    const want = Math.floor(area / 36) + (rng() < 0.5 ? 1 : 0);
    let placed = 0;
    for (let tries = 0; tries < want * 6 && placed < want; tries++) {
      const i = P.x0 + 1 + Math.floor(rng() * (P.w - 2));
      const j = P.z0 + 1 + Math.floor(rng() * (P.d - 2));
      if (ctx.used[j * N + i] !== 0 || regionUsed(ctx, i - 1, j - 1, i + 2, j + 2, true) || !roomFor(ctx, P, [[i, j]])) continue;
      const x = (i + 0.5) * CELL;
      const z = (j + 0.5) * CELL;
      const r = rng();
      if (r < 0.45) {
        out.feats.push({ t: 'palm', x, z, y, pot: true, s: 0.8 + rng() * 0.4, seed: rng() * 1e6 });
        out.circles.push([x, z, 0.5, y]);
      } else if (r < 0.7) {
        out.feats.push({ t: 'potplant', x, z, y, k: rng() < 0.6 ? 'agave' : 'broadleaf', seed: rng() * 1e6 });
        out.circles.push([x, z, 0.5, y]);
      } else if (r < 0.88) {
        out.feats.push({ t: 'urns', x, z, y, n: 1 + Math.floor(rng() * 3), seed: rng() * 1e6 });
        out.circles.push([x + 0.1, z + 0.2, 0.75, y]);
      } else {
        const d = Math.floor(rng() * 4);
        out.feats.push({ t: 'bench', x, z, y, rot: dirAngle(d) });
        out.boxes.push(orientedBox(x, z, d, 1.5, 0.5, y));
      }
      ctx.used[j * N + i] = 3;
      placed++;
    }
  }

  // Devotees: where they start their day. Most wander, some stand or kneel.
  if (P.reachable && area >= 20 && program !== 'summit' && rng() < (program === 'court' ? 0.8 : 0.22)) {
    const count = 1 + Math.floor(rng() * 3);
    const cxm = ((P.x0 + P.x1) / 2) * CELL;
    const czm = ((P.z0 + P.z1) / 2) * CELL;
    for (let k = 0; k < count; k++) {
      const c = freeSpot(ctx, P, 8);
      if (!c) continue;
      const x = (c[0] + 0.3 + rng() * 0.4) * CELL;
      const z = (c[1] + 0.3 + rng() * 0.4) * CELL;
      const face = Math.atan2(cxm - x, czm - z) + (rng() - 0.5) * 1.2;
      const r = rng();
      out.spawns.push({ x, y, z, rot: face, mode: r < 0.6 ? 'wander' : r < 0.82 ? 'still' : 'pray', seed: Math.floor(rng() * 1e6) });
    }
  }
}

function freeSpot(ctx, P, tries) {
  for (let t = 0; t < tries; t++) {
    const i = P.x0 + Math.floor(ctx.rng() * P.w);
    const j = P.z0 + Math.floor(ctx.rng() * P.d);
    if (ctx.used[j * N + i] === 0 && !hasDeck(ctx, i, j)) return [i, j];
  }
  return null;
}

function edgeCentre(i, j, d) {
  return [(i + 0.5 + DX[d] * 0.5) * CELL, (j + 0.5 + DZ[d] * 0.5) * CELL];
}

// End point of an arcade line that runs 1 cell in from side d.
function arcadeEnd(i, j, d, sign) {
  // line lies on the inner edge of the side row: between cell (i,j) and (i-DX,j-DZ)
  const lx = (i + 0.5 - DX[d] * 0.5) * CELL;
  const lz = (j + 0.5 - DZ[d] * 0.5) * CELL;
  // along direction: perpendicular to d
  const ax = DZ[d] !== 0 ? 1 : 0;
  const az = DX[d] !== 0 ? 1 : 0;
  return [lx + ax * sign * CELL * 0.5, lz + az * sign * CELL * 0.5];
}

export function dirAngle(d) {
  return Math.atan2(DX[d], DZ[d]);
}

// Box of length `len` along the wall and depth `dep` out from it, centred at (x,z).
function orientedBox(x, z, d, len, dep, y) {
  const alongX = DZ[d] !== 0;
  const hx = alongX ? len / 2 : dep / 2;
  const hz = alongX ? dep / 2 : len / 2;
  return [x - hx, z - hz, x + hx, z + hz, y];
}

function placePlanter(ctx, seg, d, y) {
  const { out, rng } = ctx;
  const a = seg[0];
  const b = seg[seg.length - 1];
  const [ax, az] = edgeCentre(a.i, a.j, d);
  const [bx, bz] = edgeCentre(b.i, b.j, d);
  const dep = 0.95;
  const cx = (ax + bx) / 2 - DX[d] * (dep / 2);
  const cz = (az + bz) / 2 - DZ[d] * (dep / 2);
  const len = seg.length * CELL - 0.2;
  const plants = [];
  const count = Math.max(1, Math.round(len / 1.45));
  const kind = rng() < 0.55 ? 'agave' : 'broadleaf';
  for (let k = 0; k < count; k++) {
    const f = (k + 0.5) / count - 0.5;
    const along = f * len;
    const px = cx + (DZ[d] !== 0 ? along : 0) + (rng() - 0.5) * 0.15;
    const pz = cz + (DX[d] !== 0 ? along : 0) + (rng() - 0.5) * 0.15;
    plants.push({ x: px, z: pz, k: rng() < 0.2 ? (kind === 'agave' ? 'broadleaf' : 'agave') : kind, s: 0.8 + rng() * 0.5, r: rng() * Math.PI * 2, seed: rng() * 1e6 });
  }
  const palm = seg.length >= 2 && rng() < 0.35;
  out.feats.push({ t: 'planter', x: cx, z: cz, y, d, len, dep, plants, palm, seed: rng() * 1e6 });
  out.boxes.push(orientedBox(cx, cz, d, len, dep, y));
  for (const e of seg) ctx.used[e.j * N + e.i] = 3;
}

function cloister(ctx, P, y) {
  const { out, rng } = ctx;
  const R = { x0: P.x0 + 1, z0: P.z0 + 1, x1: P.x1 - 1, z1: P.z1 - 1 };
  const ent = [];
  // entrance on each side at the middle edge
  const mx = Math.floor((R.x0 + R.x1 - 1) / 2);
  const mz = Math.floor((R.z0 + R.z1 - 1) / 2);
  const entrances = new Set();
  const key = (i, j, d) => `${i},${j},${d}`;
  // side d: edge between cell inside R at the border and the outside ring cell
  const edges = [];
  for (let j = R.z0; j < R.z1; j++) {
    edges.push([R.x1 - 1, j, 0, j === mz]);
    edges.push([R.x0, j, 2, j === mz]);
  }
  for (let i = R.x0; i < R.x1; i++) {
    edges.push([i, R.z1 - 1, 1, i === mx]);
    edges.push([i, R.z0, 3, i === mx]);
  }
  for (const [i, j, d, isEnt] of edges) {
    if (isEnt) {
      entrances.add(key(i, j, d));
      ent.push([i, j, d]);
    } else blockEdge(ctx, i, j, d);
  }
  // columns on every corner of the ring
  const X0 = R.x0 * CELL;
  const Z0 = R.z0 * CELL;
  const X1 = R.x1 * CELL;
  const Z1 = R.z1 * CELL;
  for (let x = X0; x <= X1 + 1e-6; x += CELL) {
    out.circles.push([x, Z0, 0.3, y]);
    out.circles.push([x, Z1, 0.3, y]);
  }
  for (let z = Z0 + CELL; z < Z1 - 1e-6; z += CELL) {
    out.circles.push([X0, z, 0.3, y]);
    out.circles.push([X1, z, 0.3, y]);
  }
  for (const [x, z] of [[X0, Z0], [X1, Z0], [X1, Z1], [X0, Z1]]) out.boxes.push([x - 0.45, z - 0.45, x + 0.45, z + 0.45, y]);

  // lawn with a cross of paths
  const L = { x0: R.x0 + 1, z0: R.z0 + 1, x1: R.x1 - 1, z1: R.z1 - 1 };
  for (let j = L.z0; j < L.z1; j++) {
    for (let i = L.x0; i < L.x1; i++) {
      if (i === mx || j === mz) continue;
      ctx.out.floorMat[j * N + i] = M.GRASS;
    }
  }
  mark(ctx, R.x0, R.z0, R.x1, R.z1, 2);
  const cx = (mx + 0.5) * CELL;
  const cz = (mz + 0.5) * CELL;
  const lawnW = L.x1 - L.x0;
  const lawnD = L.z1 - L.z0;
  if (lawnW >= 5 && lawnD >= 5 && rng() < 0.6) {
    out.feats.push({ t: 'pool', x: cx, z: cz, y, r: 2.3 });
    out.circles.push([cx, cz, 2.4, y]);
  } else {
    out.feats.push({ t: 'fountain', x: cx, z: cz, y });
    out.circles.push([cx, cz, 1.45, y]);
  }
  // urns / plants in the lawn quadrants
  for (const [qi, qj] of [[L.x0, L.z0], [L.x1 - 1, L.z0], [L.x1 - 1, L.z1 - 1], [L.x0, L.z1 - 1]]) {
    if (qi === mx || qj === mz || rng() < 0.4) continue;
    const x = (qi + 0.5) * CELL;
    const z = (qj + 0.5) * CELL;
    if (rng() < 0.5) {
      out.feats.push({ t: 'palm', x, z, y, pot: false, s: 0.8 + rng() * 0.4, seed: rng() * 1e6 });
      out.circles.push([x, z, 0.35, y]);
    } else {
      out.feats.push({ t: 'shrub', x, z, y, seed: rng() * 1e6 });
      out.circles.push([x, z, 0.6, y]);
    }
  }
  out.feats.push({ t: 'cloister', x0: X0, z0: Z0, x1: X1, z1: Z1, y, ent, seed: rng() * 1e6 });
}

function centrePiece(ctx, P, y, forced = null, at = null) {
  const { rng, out } = ctx;
  const r = rng();
  let type = forced;
  if (type) {
    // chosen by the caller
  } else if (P.w >= 7 && P.d >= 7 && r < 0.12) type = 'statue';
  else if (P.w >= 7 && P.d >= 7 && r < 0.22) type = 'pool';
  else if (P.w >= 8 && P.d >= 8 && r < 0.3) type = 'basin';
  else if (P.w >= 7 && P.d >= 7 && r < 0.38) type = 'garch';
  else if (P.w >= 6 && P.d >= 6 && r < 0.45) type = 'obelisk';
  else if (P.w >= 5 && P.d >= 5 && r < 0.64) type = 'fountain';
  else if (P.w >= 5 && P.d >= 5 && r < 0.76) type = 'palmbed';
  else if (P.w >= 5 && P.d >= 5 && r < 0.88) type = 'sarchfree';
  else return false;
  const size = type === 'pool' || type === 'basin' ? 3 : type === 'sarchfree' ? 1 : type === 'garch' ? 4 : 2;
  const ci = at ? at[0] : Math.round((P.x0 + P.x1) / 2);
  const cj = at ? at[1] : Math.round((P.z0 + P.z1) / 2);
  const offsets = [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (const [oi, oj] of offsets) {
    const i0 = ci + oi - Math.floor(size / 2);
    const j0 = cj + oj - Math.floor(size / 2);
    const i1 = i0 + size;
    const j1 = j0 + size;
    if (i0 - 1 < P.x0 || j0 - 1 < P.z0 || i1 + 1 > P.x1 || j1 + 1 > P.z1) continue;
    if (regionUsed(ctx, i0, j0, i1, j1)) continue;
    if (regionUsed(ctx, i0 - 1, j0 - 1, i1 + 1, j1 + 1, true)) continue;
    const x = ((i0 + i1) / 2) * CELL;
    const z = ((j0 + j1) / 2) * CELL;
    if (type === 'statue') {
      const face = rng() < 0.5 ? (rng() < 0.5 ? 0 : Math.PI) : rng() < 0.5 ? Math.PI / 2 : -Math.PI / 2;
      out.feats.push({ t: 'statue', x, z, y, rot: face, seed: rng() * 1e6 });
      out.boxes.push([x - 1.05, z - 1.05, x + 1.05, z + 1.05, y]);
    } else if (type === 'obelisk') {
      out.feats.push({ t: 'obelisk', x, z, y, h: 6 + rng() * 3, seed: rng() * 1e6 });
      out.boxes.push([x - 0.75, z - 0.75, x + 0.75, z + 0.75, y]);
    } else if (type === 'pool') {
      out.feats.push({ t: 'pool', x, z, y, r: 2.4 });
      out.circles.push([x, z, 2.5, y]);
    } else if (type === 'fountain') {
      out.feats.push({ t: 'fountain', x, z, y });
      out.circles.push([x, z, 1.45, y]);
    } else if (type === 'basin') {
      // a long basin with a row of jets, laid along the plot
      const alongX = P.w >= P.d;
      out.feats.push({ t: 'basin', x, z, y, rot: alongX ? Math.PI / 2 : 0 });
      out.boxes.push(alongX ? [x - 2.75, z - 1.35, x + 2.75, z + 1.35, y] : [x - 1.35, z - 2.75, x + 1.35, z + 2.75, y]);
    } else if (type === 'palmbed') {
      out.feats.push({ t: 'palmbed', x, z, y, seed: rng() * 1e6 });
      out.boxes.push([x - 1.6, z - 1.6, x + 1.6, z + 1.6, y]);
    } else if (type === 'garch') {
      const alongX = rng() < 0.5;
      out.feats.push({ t: 'garch', x, z, y, rot: alongX ? 0 : Math.PI / 2, striped: rng() < 0.5 });
      for (const sg of [-1, 1]) {
        const ox = alongX ? sg * 2.05 : 0;
        const oz = alongX ? 0 : sg * 2.05;
        const hx = alongX ? 0.5 : 0.55;
        const hz = alongX ? 0.55 : 0.5;
        out.boxes.push([x + ox - hx, z + oz - hz, x + ox + hx, z + oz + hz, y]);
      }
      mark(ctx, i0, j0, i1, j1, 2);
      return true;
    } else if (type === 'sarchfree') {
      // (at the spot just checked, i0 j0, not the plot's middle)
      const alongX = rng() < 0.5;
      const px = (i0 + 0.5) * CELL;
      const pz = (j0 + 0.5) * CELL;
      out.feats.push({ t: 'sarch', x: px, z: pz, y, rot: alongX ? 0 : Math.PI / 2, span: 2.2 });
      for (const s of [-1, 1]) {
        const ox = alongX ? s * 1.4 : 0;
        const oz = alongX ? 0 : s * 1.4;
        out.boxes.push([px + ox - 0.3, pz + oz - 0.3, px + ox + 0.3, pz + oz + 0.3, y]);
      }
      // its piers stand in the neighbouring cells: keep props clear of them
      for (let j = j0 - 1; j <= j0 + 1; j++) for (let i = i0 - 1; i <= i0 + 1; i++) if (ctx.used[j * N + i] === 0) ctx.used[j * N + i] = 2;
      return true;
    }
    mark(ctx, i0, j0, i1, j1, 3);
    // keep a clear ring around it
    for (let j = j0 - 1; j < j1 + 1; j++) for (let i = i0 - 1; i < i1 + 1; i++) if (ctx.used[j * N + i] === 0) ctx.used[j * N + i] = 2;
    return true;
  }
  return false;
}

// The top of a ziggurat: a domed pavilion, the sun idol or an obelisk, with
// devotees kneeling round it.
function shrine(ctx, P, y, kind) {
  const { rng, out } = ctx;
  const x = ((P.x0 + P.x1) / 2) * CELL;
  const z = ((P.z0 + P.z1) / 2) * CELL;
  const ci = Math.floor((P.x0 + P.x1) / 2);
  const cj = Math.floor((P.z0 + P.z1) / 2);
  if (kind === 'pavilion') {
    out.feats.push({ t: 'pavilion', x, z, y, seed: rng() * 1e6 });
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) out.boxes.push([x + sx * 1.7 - 0.32, z + sz * 1.7 - 0.32, x + sx * 1.7 + 0.32, z + sz * 1.7 + 0.32, y]);
  } else if (kind === 'statue') {
    const faces = ctx.S.feature.axes;
    const rot = [Math.PI / 2, 0, -Math.PI / 2, Math.PI][faces[0]];
    out.feats.push({ t: 'statue', x, z, y, rot, seed: rng() * 1e6 });
    out.boxes.push([x - 1.05, z - 1.05, x + 1.05, z + 1.05, y]);
  } else {
    out.feats.push({ t: 'obelisk', x, z, y, h: 8 + rng() * 3, seed: rng() * 1e6 });
    out.boxes.push([x - 0.75, z - 0.75, x + 0.75, z + 0.75, y]);
  }
  mark(ctx, ci - 1, cj - 1, ci + 1, cj + 1, 3);
  // urns on the summit's corners
  for (const [i, j] of [[P.x0, P.z0], [P.x1 - 1, P.z0], [P.x1 - 1, P.z1 - 1], [P.x0, P.z1 - 1]]) {
    if (ctx.used[j * N + i] !== 0) continue;
    const ux = (i + 0.5) * CELL + (i === P.x0 ? -0.3 : 0.3);
    const uz = (j + 0.5) * CELL + (j === P.z0 ? -0.3 : 0.3);
    out.feats.push({ t: 'urns', x: ux, z: uz, y, n: 1, seed: rng() * 1e6 });
    out.circles.push([ux, uz, 0.45, y]);
    ctx.used[j * N + i] = 3;
  }
  // kneeling devotees facing it
  const n = 2 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const a = rng() * Math.PI * 2;
    const r = 3.1 + rng() * 0.6;
    const px = x + Math.sin(a) * r;
    const pz = z + Math.cos(a) * r;
    const i = Math.floor(px / CELL);
    const j = Math.floor(pz / CELL);
    if (!inside(P, i, j) || ctx.used[j * N + i] !== 0) continue;
    out.spawns.push({ x: px, y, z: pz, rot: a + Math.PI, mode: 'pray', seed: Math.floor(rng() * 1e6) });
    ctx.used[j * N + i] = 3;
  }
}

// A sunken court: two matching pieces either side of its middle (clear of any
// bridge overhead), or an orchard of palms on a lawn.
function court(ctx, P, y, garden) {
  const { rng, out } = ctx;
  if (garden) {
    for (let j = P.z0 + 1; j < P.z1 - 1; j++) {
      for (let i = P.x0 + 1; i < P.x1 - 1; i++) {
        const c = j * N + i;
        if (ctx.used[c] === 0 && !hasDeck(ctx, i, j)) out.floorMat[c] = M.GRASS;
      }
    }
    const ox = P.x0 + 2;
    const oz = P.z0 + 2;
    for (let j = oz; j < P.z1 - 2; j += 3) {
      for (let i = ox; i < P.x1 - 2; i += 3) {
        if (regionUsed(ctx, i - 1, j - 1, i + 2, j + 2, true) || hasDeck(ctx, i, j)) continue;
        const x = (i + 0.5) * CELL;
        const z = (j + 0.5) * CELL;
        out.feats.push({ t: 'palm', x, z, y, pot: false, s: 1.0 + rng() * 0.45, seed: rng() * 1e6 });
        out.circles.push([x, z, 0.35, y]);
        ctx.used[j * N + i] = 3;
      }
    }
    return;
  }
  const alongX = P.w >= P.d;
  const type = rng.pick(['pool', 'fountain', 'palmbed', 'statue', 'obelisk', 'basin']);
  const ci = Math.round((P.x0 + P.x1) / 2);
  const cj = Math.round((P.z0 + P.z1) / 2);
  const q = Math.round((alongX ? P.w : P.d) / 4);
  const spots = alongX ? [[P.x0 + q, cj], [P.x1 - q, cj]] : [[ci, P.z0 + q], [ci, P.z1 - q]];
  let placed = 0;
  for (const at of spots) if (centrePiece(ctx, P, y, type, at)) placed++;
  if (!placed) centrePiece(ctx, P, y, 'fountain');
}

// Quays: mooring posts along the water.
function quay(ctx, P, y) {
  const { out } = ctx;
  for (let d = 0; d < 4; d++) {
    const s = sideInfo(ctx, P, d);
    s.forEach((e, k) => {
      if (e.rel !== 'water' || k % 3 !== 1 || e.u !== 0 || hasDeck(ctx, e.i, e.j)) return;
      const [cx, cz] = edgeCentre(e.i, e.j, d);
      const x = cx - DX[d] * 0.35;
      const z = cz - DZ[d] * 0.35;
      out.feats.push({ t: 'bollard', x, z, y });
      out.circles.push([x, z, 0.22, y]);
    });
  }
}

// Water. Where a cascade reach meets a lower one the water pours over a weir
// (some with a sluice gate on the crest); where a reach or a flooded well meets
// a high wall it comes out of a spout or a grated culvert, or drains into one.
// A stepwell's tank holds an islet; a reflecting pool gets rows of jets.
function decorateWater(ctx, P) {
  const { out, S, rng } = ctx;
  const F = S.feature;
  const y = P.level * LEVEL_H;
  const ys = y - WATER_DROP;
  const kind = P.feature ? F.kind : P.pool ? 'pool' : 'well';
  if (kind === 'tank') return islet(ctx, P, ys, F.islet);
  if (kind === 'pool') return poolJets(ctx, P, y, ys);
  const alongX = P.feature ? F.alongX : P.w >= P.d;
  const ends = alongX ? [[P.x0, 2], [P.x1 - 1, 0]] : [[P.z0, 3], [P.z1 - 1, 1]];
  const width = (alongX ? P.d : P.w) * CELL;
  const cascade = kind === 'cascade';
  for (const [e, d] of ends) {
    const x = alongX ? (d === 0 ? P.x1 * CELL : P.x0 * CELL) : ((P.x0 + P.x1) / 2) * CELL;
    const z = alongX ? ((P.z0 + P.z1) / 2) * CELL : d === 1 ? P.z1 * CELL : P.z0 * CELL;
    const ni = alongX ? e + DX[d] : Math.floor((P.x0 + P.x1) / 2);
    const nj = alongX ? Math.floor((P.z0 + P.z1) / 2) : e + DZ[d];
    const n = ctx.look(ni, nj);
    const rot = dirAngle(d);
    if (n.kind === K_WATER) {
      if (!cascade || n.base > ys - 0.5) continue;
      out.feats.push({ t: 'weir', x, z, y: ys, drop: ys - n.base, w: width, rot });
      // a sluice gate on the crest, clear of any bridge overhead
      const row = sideCells(P, d);
      if (F.sluice && rng() < 0.75 && row.every(([i, j]) => !hasDeck(ctx, i, j) && !hasDeck(ctx, i - DX[d], j - DZ[d]))) {
        out.feats.push({ t: 'sluice', x: x - DX[d] * 0.7, z: z - DZ[d] * 0.7, y: ys, w: width, rot, open: 0.5 + rng() * 1.1 });
      }
      continue;
    }
    // the wall at this end must rise well above the quays
    if (n.base < y + 2.4) continue;
    const head = cascade ? d !== P.down : d === ends[0][1];
    if (cascade && head && P.step !== 0) continue;
    if (cascade && !head && P.step !== P.steps - 1) continue;
    const inward = dirAngle((d + 2) % 4);
    if (!cascade && rng() < 0.5) out.feats.push({ t: 'spout', x, z, y, rot: inward });
    else {
      const w = Math.min(width - 1.0, 4.2);
      // the water it pours churns white below it (drawn with the water)
      const churn = [];
      if (head) {
        for (const [i, j] of sideCells(P, d)) {
          const off = alongX ? (j + 0.5) * CELL - z : (i + 0.5) * CELL - x;
          if (Math.abs(off) < w / 2 + 0.6) churn.push([i, j, d]);
        }
      }
      out.feats.push({ t: 'culvert', x, z, y: ys, rot: inward, w, pour: head, room: n.base - ys, churn });
    }
  }
}

// Mitre gates across a canal: two crimson leaves meeting in a shallow point,
// with a winch on the quay beside each heel. Kept clear of bridges.
function lockGates(ctx, P) {
  const { S, rng, out } = ctx;
  const alongX = S.feature.alongX;
  const len = alongX ? P.w : P.d;
  const a0 = alongX ? P.x0 : P.z0;
  const c0 = alongX ? P.z0 : P.x0;
  const c1 = alongX ? P.z1 : P.x1;
  if (rng() < 0.15) return;
  const want = len >= 20 && rng() < 0.55 ? 2 : 1;
  const ys = P.level * LEVEL_H - WATER_DROP;
  const quayY = P.level * LEVEL_H;
  const cell = (a, c) => (alongX ? [a, c] : [c, a]);
  const cand = [];
  for (let a = a0 + 3; a <= a0 + len - 3; a++) {
    const u = (a - a0) / len;
    cand.push({ a, score: -Math.min(Math.abs(u - 0.33), Math.abs(u - 0.67)) * 3 + rng() * 0.5 });
  }
  cand.sort((p, q) => q.score - p.score);
  const placed = [];
  for (const { a } of cand) {
    if (placed.length >= want) break;
    if (placed.some((b) => Math.abs(b - a) < 6)) continue;
    let clear = true;
    for (let k = a - 2; k <= a + 1 && clear; k++) {
      for (let c = c0 - 2; c < c1 + 2 && clear; c++) {
        const [i, j] = cell(k, c);
        if (i >= 0 && j >= 0 && i < N && j < N && hasDeck(ctx, i, j)) clear = false;
      }
    }
    if (!clear) continue;
    // a winch on each quay, on the downstream side of the gate line
    const posts = [
      [cell(a, c0 - 1), alongX ? 1 : 0],
      [cell(a, c1), alongX ? 3 : 2],
    ];
    const ok = posts.every(([[i, j]]) => {
      if (i < 0 || j < 0 || i >= N || j >= N) return false;
      const c = j * N + i;
      return S.kind[c] === K_FLOOR && Math.abs(S.base[c] - quayY) < 0.01 && ctx.used[c] === 0 && roomFor(ctx, S.plots[S.plotId[c]], [[i, j]]);
    });
    if (!ok) continue;
    placed.push(a);
    const w = (c1 - c0) * CELL;
    const mid = ((c0 + c1) / 2) * CELL;
    const along = a * CELL;
    const [gx, gz] = alongX ? [along, mid] : [mid, along];
    const down = alongX ? 0 : 1;
    out.feats.push({ t: 'lockgate', x: gx, z: gz, y: ys, w, rot: dirAngle(down), rise: WATER_DROP, seed: rng() * 1e6 });
    for (const [[i, j], toward] of posts) {
      // toward: from the quay cell over the water
      const inX = (i + 0.5) * CELL + DX[toward] * 0.45;
      const inZ = (j + 0.5) * CELL + DZ[toward] * 0.45;
      const px = alongX ? along + 0.75 : inX;
      const pz = alongX ? inZ : along + 0.75;
      out.feats.push({ t: 'winch', x: px, z: pz, y: quayY, rot: dirAngle(toward) });
      out.circles.push([px, pz, 0.42, quayY]);
      ctx.used[j * N + i] = 3;
    }
  }
}

// A reflecting pool flush with its ring of terraces. A long one gets a row of
// jets arching in from each side; a squarish one an islet with a plume.
function poolJets(ctx, P, y, ys) {
  const { out, rng } = ctx;
  const alongX = P.w >= P.d;
  const len = alongX ? P.w : P.d;
  const wide = alongX ? P.d : P.w;
  if (len - wide < 2 && wide >= 4) return islet(ctx, P, ys, 'jet');
  const at = [];
  for (let k = 0; k < len; k++) {
    // no jets under a bridge
    let free = true;
    for (let c = 0; c < wide && free; c++) {
      const i = alongX ? P.x0 + k : P.x0 + c;
      const j = alongX ? P.z0 + c : P.z0 + k;
      if (hasDeck(ctx, i, j)) free = false;
    }
    if (free) at.push((k + 0.5) * CELL - (len * CELL) / 2);
  }
  if (!at.length) return;
  const x = ((P.x0 + P.x1) / 2) * CELL;
  const z = ((P.z0 + P.z1) / 2) * CELL;
  out.feats.push({ t: 'jets', x, z, y: ys, rot: alongX ? Math.PI / 2 : 0, width: wide * CELL, rim: y - ys, at, both: wide >= 2 && rng() < 0.8 });
}

// An islet in the middle of the water: a plinth carrying a domed pavilion, or
// a basin with a plume. Devotees kneel on the ledges round it.
function islet(ctx, P, ys, kind) {
  const { out, S, rng } = ctx;
  const x = ((P.x0 + P.x1) / 2) * CELL;
  const z = ((P.z0 + P.z1) / 2) * CELL;
  const room = Math.min(P.w, P.d) * CELL;
  if (room < 5) return;
  if (kind === 'pavilion' && room < 9) kind = 'jet';
  out.feats.push({ t: 'islet', x, z, y: ys, kind, size: kind === 'pavilion' ? 5.2 : 2.6, rise: WATER_DROP + 0.1, seed: rng() * 1e6 });
  if (!P.feature) return;
  const y = P.level * LEVEL_H;
  const n = 2 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const d = Math.floor(rng() * 4);
    const cells = sideCells(P, d);
    const [wi, wj] = cells[Math.floor(rng() * cells.length)];
    const i = wi + DX[d];
    const j = wj + DZ[d];
    if (i < 0 || j < 0 || i >= N || j >= N) continue;
    const c = j * N + i;
    if (S.kind[c] !== K_FLOOR || ctx.used[c] !== 0 || Math.abs(S.base[c] - y) > 0.01) continue;
    const px = (i + 0.5) * CELL - DX[d] * 0.3;
    const pz = (j + 0.5) * CELL - DZ[d] * 0.3;
    out.spawns.push({ x: px, y, z: pz, rot: dirAngle((d + 2) % 4), mode: 'pray', seed: Math.floor(rng() * 1e6) });
    ctx.used[c] = 3;
  }
}

function decorateBuilding(ctx, P) {
  const { rng, out } = ctx;
  const y = P.level * LEVEL_H;
  const X0 = P.x0 * CELL;
  const Z0 = P.z0 * CELL;
  const X1 = P.x1 * CELL;
  const Z1 = P.z1 * CELL;
  if (P.roof === 'flat') {
    if (rng() < 0.5) {
      const n = 1 + Math.floor(rng() * 3);
      for (let k = 0; k < n; k++) {
        const x = X0 + 1.5 + rng() * (X1 - X0 - 3);
        const z = Z0 + 1.5 + rng() * (Z1 - Z0 - 3);
        out.feats.push({ t: 'palm', x, z, y, pot: true, s: 0.8 + rng() * 0.5, seed: rng() * 1e6 });
      }
    }
    if (rng() < 0.35) {
      const cx = X0 + 1.4 + Math.floor(rng() * 2) * (X1 - X0 - 2.8);
      const cz = Z0 + 1.4 + Math.floor(rng() * 2) * (Z1 - Z0 - 2.8);
      out.feats.push({ t: 'turret', x: cx, z: cz, y, h: 2.5 + rng() * 3, r: 1.0 });
    }
  } else if (P.roof === 'dome' && rng() < 0.55) {
    // pinnacles on the corners of the parapet round the dome
    for (const [x, z] of [[X0 + 0.55, Z0 + 0.55], [X1 - 0.55, Z0 + 0.55], [X1 - 0.55, Z1 - 0.55], [X0 + 0.55, Z1 - 0.55]]) out.feats.push({ t: 'pinnacle', x, z, y, h: 2.6 });
  } else if (P.roof === 'hip' && rng() < 0.3) {
    const cx = rng() < 0.5 ? X0 + 1.2 : X1 - 1.2;
    const cz = rng() < 0.5 ? Z0 + 1.2 : Z1 - 1.2;
    out.feats.push({ t: 'turret', x: cx, z: cz, y, h: 3.5 + rng() * 3, r: 1.0 });
  }
}

// A rill: a narrow raised channel fed by a spout in a wall, running straight
// across the terrace. Stepping slabs cross it at every cell boundary, so it
// never cuts the terrace in two. At a drop it spills through a scupper into a
// basin (or water) below; otherwise it ends in a small basin of its own.
function rill(ctx, P, y, sides) {
  const { S, rng, out } = ctx;
  let best = null;
  for (let d = 0; d < 4; d++) {
    const r = (d + 2) % 4;
    const len = d % 2 === 0 ? P.w : P.d;
    const lat = d % 2 === 0 ? P.d : P.w;
    if (len < 3 || lat < 3) continue;
    for (const e of sides[d]) {
      if (e.rel !== 'up' || e.wall < LEVEL_H - 0.05) continue;
      const lp = d % 2 === 0 ? e.j - P.z0 : e.i - P.x0;
      if (lp === 0 || lp === lat - 1) continue;
      const cells = [];
      for (let k = 0; k < len; k++) {
        const i = e.i + DX[r] * k;
        const j = e.j + DZ[r] * k;
        const c = j * N + i;
        if (ctx.used[c] !== 0 || hasDeck(ctx, i, j) || S.kind[c] !== K_FLOOR) break;
        // the paths either side of it stay level floor
        const side = [1, -1].every((sg) => {
          const a = i + DZ[r] * sg;
          const b = j + DX[r] * sg;
          const q = b * N + a;
          return S.kind[q] === K_FLOOR && Math.abs(S.base[q] - y) < 0.01 && ctx.used[q] !== 1;
        });
        if (!side) break;
        cells.push([i, j]);
      }
      if (cells.length < len) continue;
      const score = -Math.abs(lp - (lat - 1) / 2) + rng() * 0.6;
      if (!best || score > best.score) best = { d, r, cells, score, e };
    }
  }
  if (!best) return false;
  const { d, r, cells, e } = best;
  const n = cells.length;
  const [lx, lz] = edgeCentre(e.i, e.j, d); // on the wall face
  const last = cells[n - 1];
  // where the water goes at the far end
  let spill = null;
  const end = sides[r].find((q) => q.i === last[0] && q.j === last[1]);
  if (end && (end.rel === 'down' || end.rel === 'water')) {
    const ni = last[0] + DX[r];
    const nj = last[1] + DZ[r];
    const nb = ctx.look(ni, nj);
    const drop = y - nb.base;
    const inBlock = ni >= 0 && nj >= 0 && ni < N && nj < N;
    const deckFree = nb.deck !== nb.deck;
    if (nb.kind === K_WATER && deckFree && drop > 1.2) spill = { y: nb.base, basin: false };
    else if (inBlock && nb.kind === K_FLOOR && deckFree && drop >= 2.5 && ctx.used[nj * N + ni] === 0 && S.plotId[nj * N + ni] > P.id && roomFor(ctx, S.plots[S.plotId[nj * N + ni]], [[ni, nj]])) {
      spill = { y: nb.base, basin: true };
      const [ex, ez] = edgeCentre(last[0], last[1], r);
      const bx = ex + DX[r] * 0.8;
      const bz = ez + DZ[r] * 0.8;
      out.circles.push([bx, bz, 0.75, nb.base]);
      ctx.used[nj * N + ni] = 3;
    }
  }
  out.feats.push({ t: 'rill', x: lx, z: lz, y, rot: dirAngle(r), n, spill });
  // collision: the channel between the slabs, the head basin, the end basin
  const L = n * CELL;
  const seg = (z0, z1, hw) => out.boxes.push(localBox(lx, lz, r, -hw, z0, hw, z1, y));
  seg(0, 0.9, 0.68);
  for (let k = 0; k < n; k++) {
    const z0 = k === 0 ? 0.9 : k * CELL + 0.5;
    const z1 = k === n - 1 ? L : (k + 1) * CELL - 0.5;
    if (z1 > z0) seg(z0, z1, 0.47);
  }
  if (!spill) seg(L - 1.8, L - 0.2, 0.8);
  for (const [i, j] of cells) ctx.used[j * N + i] = 3;
  ctx.quiet.add(e.j * N + e.i);
  return true;
}

// Axis-aligned box of a rectangle given in a frame at (ox, oz) whose +z runs
// along direction r and +x across it.
function localBox(ox, oz, r, x0, z0, x1, z1, y) {
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

// Along a wall rising from a terrace: now and then a carved relief across two
// bays, or a wall fountain with a basin at its foot. Returns the bays taken.
function wallPieces(ctx, P, run, d, y, doorAt, program) {
  const { rng, out } = ctx;
  const taken = new Set();
  if (!P.reachable || program === 'summit' || program === 'cloister') return taken;
  const free = (e) => e && ctx.used[e.j * N + e.i] === 0 && e.t !== doorAt;
  const face = (d + 2) % 4;
  const r = rng();
  if (run.length >= 2 && r < 0.1) {
    const pairs = [];
    for (let k = 0; k + 1 < run.length; k++) if (free(run[k]) && free(run[k + 1])) pairs.push(k);
    if (!pairs.length) return taken;
    const mid = (run.length - 2) / 2;
    pairs.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
    const k = pairs[0];
    const [ax, az] = edgeCentre(run[k].i, run[k].j, d);
    const [bx, bz] = edgeCentre(run[k + 1].i, run[k + 1].j, d);
    out.feats.push({ t: 'relief', x: (ax + bx) / 2, z: (az + bz) / 2, y, rot: dirAngle(face), kind: rng() < 0.5 ? 'lunette' : 'panel', seed: rng() * 1e6 });
    for (const e of [run[k], run[k + 1]]) {
      taken.add(e.t);
      ctx.used[e.j * N + e.i] = 2;
    }
  } else if (r < 0.17) {
    const cand = run.filter((e) => free(e) && roomFor(ctx, P, [[e.i, e.j]]));
    if (!cand.length) return taken;
    const e = cand[Math.floor(rng() * cand.length)];
    const [cx, cz] = edgeCentre(e.i, e.j, d);
    out.feats.push({ t: 'wallfountain', x: cx, z: cz, y, rot: dirAngle(face) });
    out.boxes.push(orientedBox(cx - DX[d] * 0.45, cz - DZ[d] * 0.45, d, 1.7, 0.9, y));
    taken.add(e.t);
    ctx.used[e.j * N + e.i] = 3;
  }
  return taken;
}

function decorateStairs(ctx) {
  const { S, rng, out } = ctx;
  for (const s of S.stairs) {
    if (s.w > 2 || rng() > 0.25) continue;
    // arch over the top exit
    let cx;
    let cz;
    let rot;
    if (s.type === 'parallel') {
      const [li, lj] = s.landing;
      const d = s.wallDir;
      [cx, cz] = edgeCentre(li, lj, d);
      rot = dirAngle(d);
    } else {
      const xs = s.exit.map((c) => c[0]);
      const zs = s.exit.map((c) => c[1]);
      const ci = (Math.min(...xs) + Math.max(...xs) + 1) / 2;
      const cj = (Math.min(...zs) + Math.max(...zs) + 1) / 2;
      cx = ci * CELL - DX[s.dir] * CELL * 0.5;
      cz = cj * CELL - DZ[s.dir] * CELL * 0.5;
      rot = dirAngle(s.dir);
    }
    const span = s.w * CELL + 0.2;
    const ax = Math.cos(rot);
    const az = -Math.sin(rot);
    const piers = [-1, 1].map((sg) => [cx + ax * sg * (span / 2 + 0.25), cz + az * sg * (span / 2 + 0.25)]);
    // its piers stand in the cells either side: never close to furniture, which
    // would shut the way past them
    const blocked = piers.some(([px, pz]) => {
      const r = 0.3 + 0.8; // the pier, and room to walk by it
      for (let j = Math.floor((pz - r) / CELL); j <= Math.floor((pz + r) / CELL); j++) {
        for (let i = Math.floor((px - r) / CELL); i <= Math.floor((px + r) / CELL); i++) {
          if (i >= 0 && j >= 0 && i < N && j < N && ctx.used[j * N + i] === 3) return true;
        }
      }
      return false;
    });
    if (blocked) continue;
    out.feats.push({ t: 'sarch', x: cx, z: cz, y: s.hT, rot, span });
    for (const [px, pz] of piers) out.boxes.push([px - 0.3, pz - 0.3, px + 0.3, pz + 0.3, s.hT]);
  }
}

// Bridge piers are obstacles for whoever walks underneath; some bridges get a
// horseshoe arch over each entrance.
function decorateBridges(ctx) {
  const { S, out } = ctx;
  for (const br of S.bridges) {
    const ax = DX[br.d];
    const az = DZ[br.d];
    const sx = br.i0 * CELL + (ax ? 0 : CELL / 2);
    const sz = br.j0 * CELL + (az ? 0 : CELL / 2);
    for (const t of br.piers) {
      const px = sx + ax * t * CELL;
      const pz = sz + az * t * CELL;
      for (const k of [t - 1, t]) {
        const c = br.cells[k];
        if (S.kind[c] === K_WATER) continue;
        const hx = ax ? 0.36 : 1.02;
        const hz = az ? 0.36 : 1.02;
        out.boxes.push([px - hx, pz - hz, px + hx, pz + hz, S.base[c]]);
      }
    }
    if (!br.gate) continue;
    for (const [end, dir] of [[br.a, br.d], [br.b, (br.d + 2) % 4]]) {
      const i = end % N;
      const j = Math.floor(end / N);
      const lat = (dir + 1) % 4;
      const ok = [1, -1].every((sg) => {
        const li = i + DX[lat] * sg;
        const lj = j + DZ[lat] * sg;
        if (li < 0 || lj < 0 || li >= N || lj >= N) return false;
        const c = lj * N + li;
        return S.kind[c] === K_FLOOR && Math.abs(S.base[c] - br.y) < 0.01 && ctx.used[c] !== 1;
      });
      if (!ok) continue;
      const [ex, ez] = edgeCentre(i, j, dir);
      const cx = ex - DX[dir] * 0.45;
      const cz = ez - DZ[dir] * 0.45;
      const rot = dirAngle(dir);
      out.feats.push({ t: 'sarch', x: cx, z: cz, y: br.y, rot, span: 2.2 });
      const px = Math.cos(rot);
      const pz = -Math.sin(rot);
      for (const sg of [-1, 1]) {
        const qx = cx + px * sg * 1.35;
        const qz = cz + pz * sg * 1.35;
        out.boxes.push([qx - 0.3, qz - 0.3, qx + 0.3, qz + 0.3, br.y]);
      }
    }
  }
}

// Now and then a line of devotees walks the terraces together.
function procession(ctx) {
  const { S, rng, out } = ctx;
  if (rng() > 0.32) return;
  const cands = S.plots.filter((P) => P.reachable && !P.building && !P.water && P.w * P.d >= 24);
  if (!cands.length) return;
  const P = rng.pick(cands);
  const c = freeSpot(ctx, P, 12);
  if (!c) return;
  out.spawns.push({ x: (c[0] + 0.5) * CELL, y: P.level * LEVEL_H, z: (c[1] + 0.5) * CELL, rot: rng() * Math.PI * 2, mode: 'lead', count: 3 + Math.floor(rng() * 3), seed: Math.floor(rng() * 1e6) });
}
