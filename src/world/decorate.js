// Second generation phase: furnish terraces (cloisters, fountains, planters,
// arcades, statues, devotees...) and record collision shapes. Needs read access
// to neighbouring blocks' structure through look(i, j) for block-local cells
// that may lie outside the block.

import { BLOCK, CELL, LEVEL_H, K_STAIR, K_BUILDING, K_LANDING, DX, DZ, M } from '../config.js';
import { hash2, makeRng } from './rng.js';

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
  };
  const used = S.used.slice();
  const ctx = { S, look, rng, out, used };

  for (const P of S.plots) {
    if (P.building) decorateBuilding(ctx, P);
    else decorateTerrace(ctx, P);
  }
  decorateStairs(ctx);
  return out;
}

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
    if (n.kind === K_STAIR || n.kind === K_LANDING) rel = 'stair';
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
  const sides = [0, 1, 2, 3].map((d) => sideInfo(ctx, P, d));
  const area = P.w * P.d;

  // Hidden gardens: terraces nobody can reach become lawns with trees.
  if (!P.reachable && P.w >= 4 && P.d >= 4) {
    for (let j = P.z0 + 1; j < P.z1 - 1; j++) for (let i = P.x0 + 1; i < P.x1 - 1; i++) out.floorMat[j * N + i] = M.GRASS;
    const trees = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < trees; k++) {
      const i = P.x0 + 1 + Math.floor(rng() * (P.w - 2));
      const j = P.z0 + 1 + Math.floor(rng() * (P.d - 2));
      out.feats.push({ t: 'palm', x: (i + 0.5) * CELL, z: (j + 0.5) * CELL, y, pot: false, s: 0.9 + rng() * 0.5, seed: rng() * 1e6 });
    }
  }

  let program = 'plaza';
  if (P.reachable && P.w >= 9 && P.d >= 9 && !regionUsed(ctx, P.x0 + 1, P.z0 + 1, P.x1 - 1, P.z1 - 1) && rng() < 0.55) {
    program = 'cloister';
    cloister(ctx, P, y);
  }

  if (program !== 'cloister' && P.reachable) centrePiece(ctx, P, y);

  // Walls rising from this terrace: planters, benches, doors, ground-floor windows.
  for (let d = 0; d < 4; d++) {
    const s = sides[d];
    const out_ = (d + 2) % 4; // direction facing back into the plot
    for (const run of runs(s, (e) => e.rel === 'up' && e.wall >= LEVEL_H - 0.05)) {
      let doorAt = -1;
      if (rng() < 0.5) {
        const cand = run.filter((e) => e.u !== 1);
        if (cand.length) doorAt = cand[Math.floor(rng() * cand.length)].t;
      }
      const planter = new Set();
      if (program !== 'cloister' && P.reachable) {
        for (let k = 0; k < run.length; k++) {
          const e = run[k];
          if (e.t === doorAt || e.u !== 0 || rng() > 0.22) continue;
          let len = 0;
          const want = 2 + Math.floor(rng() * 2);
          while (k + len < run.length && len < want && run[k + len].u === 0 && run[k + len].t !== doorAt) len++;
          if (len < 1) continue;
          const seg = run.slice(k, k + len);
          placePlanter(ctx, seg, d, y);
          for (const q of seg) planter.add(q.t);
          k += len;
        }
      }
      for (const e of run) {
        if (e.u === 1) continue;
        const isDoor = e.t === doorAt;
        out.band0.push({ i: e.i, j: e.j, d, y, door: isDoor, low: planter.has(e.t), owner: [e.owner.bx, e.owner.bz, e.owner.plot] });
        if (!isDoor && !planter.has(e.t) && e.u === 0 && P.reachable && rng() < 0.06) {
          // bench against the wall
          const [cx, cz] = edgeCentre(e.i, e.j, d);
          const inset = 0.45;
          out.feats.push({ t: 'bench', x: cx - DX[d] * inset, z: cz - DZ[d] * inset, y, rot: dirAngle(out_) });
          out.boxes.push(orientedBox(cx - DX[d] * inset, cz - DZ[d] * inset, d, 1.5, 0.5, y));
        }
      }
    }
  }

  // Arcade screens along drops, 2 m in from the balustrade.
  if (program !== 'cloister' && P.reachable) {
    for (let d = 0; d < 4; d++) {
      for (const run of runs(sides[d], (e) => e.rel === 'down' && e.u === 0)) {
        if (run.length < 4 || rng() > 0.32) continue;
        const inner = run.every((e) => {
          const ii = e.i - DX[d];
          const jj = e.j - DZ[d];
          return inside(P, ii, jj) && ctx.used[jj * N + ii] === 0;
        });
        if (!inner) continue;
        const a = run[0];
        const b = run[run.length - 1];
        const [ax, az] = arcadeEnd(a.i, a.j, d, -1);
        const [bx, bz] = arcadeEnd(b.i, b.j, d, 1);
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

  // Potted plants and benches along the balustrades
  if (program !== 'cloister' && P.reachable) {
    for (let d = 0; d < 4; d++) {
      for (const run of runs(sides[d], (e) => e.rel === 'down')) {
        if (run.length < 3 || rng() > 0.5) continue;
        const benches = rng() < 0.3;
        for (let k = 1; k < run.length - 1; k += 2 + (rng() < 0.5 ? 1 : 0)) {
          const e = run[k];
          if (ctx.used[e.j * N + e.i] !== 0) continue;
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
    if (ra === 'down' && rb === 'down' && rng() < 0.45) {
      // pinnacle pier on the outer corner of the balustrade
      const px = (i + 0.5 + DX[da] * 0.5 + DX[db] * 0.5) * CELL - (DX[da] + DX[db]) * 0.16;
      const pz = (j + 0.5 + DZ[da] * 0.5 + DZ[db] * 0.5) * CELL - (DZ[da] + DZ[db]) * 0.16;
      out.feats.push({ t: 'pinnacle', x: px, z: pz, y, h: 2.6 + rng() * 1.6 });
      out.boxes.push([px - 0.4, pz - 0.4, px + 0.4, pz + 0.4, y]);
      continue;
    }
    if (!P.reachable || ctx.used[j * N + i] !== 0) continue;
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
  if (program !== 'cloister' && P.reachable && area >= 42) {
    const want = Math.floor(area / 36) + (rng() < 0.5 ? 1 : 0);
    let placed = 0;
    for (let tries = 0; tries < want * 6 && placed < want; tries++) {
      const i = P.x0 + 1 + Math.floor(rng() * (P.w - 2));
      const j = P.z0 + 1 + Math.floor(rng() * (P.d - 2));
      if (ctx.used[j * N + i] !== 0 || regionUsed(ctx, i - 1, j - 1, i + 2, j + 2, true)) continue;
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

  // Devotees: silent, still figures.
  if (P.reachable && area >= 20 && rng() < 0.24) {
    const count = 1 + Math.floor(rng() * 3);
    const cxm = ((P.x0 + P.x1) / 2) * CELL;
    const czm = ((P.z0 + P.z1) / 2) * CELL;
    for (let k = 0; k < count; k++) {
      for (let tries = 0; tries < 8; tries++) {
        const i = P.x0 + 1 + Math.floor(rng() * Math.max(1, P.w - 2));
        const j = P.z0 + 1 + Math.floor(rng() * Math.max(1, P.d - 2));
        if (!inside(P, i, j) || ctx.used[j * N + i] !== 0) continue;
        const x = (i + 0.3 + rng() * 0.4) * CELL;
        const z = (j + 0.3 + rng() * 0.4) * CELL;
        const face = Math.atan2(cxm - x, czm - z) + (rng() - 0.5) * 1.2;
        out.feats.push({ t: 'devotee', x, z, y, rot: face, pose: rng() < 0.3 ? 'kneel' : 'stand', seed: rng() * 1e6 });
        out.circles.push([x, z, 0.38, y]);
        ctx.used[j * N + i] = 3;
        break;
      }
    }
  }
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

function centrePiece(ctx, P, y) {
  const { rng, out } = ctx;
  const r = rng();
  let type;
  if (P.w >= 7 && P.d >= 7 && r < 0.13) type = 'statue';
  else if (P.w >= 7 && P.d >= 7 && r < 0.26) type = 'pool';
  else if (P.w >= 7 && P.d >= 7 && r < 0.38) type = 'garch';
  else if (P.w >= 5 && P.d >= 5 && r < 0.64) type = 'fountain';
  else if (P.w >= 5 && P.d >= 5 && r < 0.76) type = 'palmbed';
  else if (P.w >= 5 && P.d >= 5 && r < 0.88) type = 'sarchfree';
  else return;
  const size = type === 'pool' ? 3 : type === 'sarchfree' ? 1 : type === 'garch' ? 4 : 2;
  const ci = Math.round((P.x0 + P.x1) / 2);
  const cj = Math.round((P.z0 + P.z1) / 2);
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
    } else if (type === 'pool') {
      out.feats.push({ t: 'pool', x, z, y, r: 2.4 });
      out.circles.push([x, z, 2.5, y]);
    } else if (type === 'fountain') {
      out.feats.push({ t: 'fountain', x, z, y });
      out.circles.push([x, z, 1.45, y]);
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
      return;
    } else if (type === 'sarchfree') {
      const alongX = rng() < 0.5;
      out.feats.push({ t: 'sarch', x: (ci + 0.5) * CELL, z: (cj + 0.5) * CELL, y, rot: alongX ? 0 : Math.PI / 2, span: 2.2 });
      const px = (ci + 0.5) * CELL;
      const pz = (cj + 0.5) * CELL;
      for (const s of [-1, 1]) {
        const ox = alongX ? s * 1.4 : 0;
        const oz = alongX ? 0 : s * 1.4;
        out.boxes.push([px + ox - 0.3, pz + oz - 0.3, px + ox + 0.3, pz + oz + 0.3, y]);
      }
      mark(ctx, ci, cj, ci + 1, cj + 1, 2);
      return;
    }
    mark(ctx, i0, j0, i1, j1, 3);
    // keep a clear ring around it
    for (let j = j0 - 1; j < j1 + 1; j++) for (let i = i0 - 1; i < i1 + 1; i++) if (ctx.used[j * N + i] === 0) ctx.used[j * N + i] = 2;
    return;
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
  } else if (P.roof === 'hip' && rng() < 0.3) {
    const cx = rng() < 0.5 ? X0 + 1.2 : X1 - 1.2;
    const cz = rng() < 0.5 ? Z0 + 1.2 : Z1 - 1.2;
    out.feats.push({ t: 'turret', x: cx, z: cz, y, h: 3.5 + rng() * 3, r: 1.0 });
  }
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
    out.feats.push({ t: 'sarch', x: cx, z: cz, y: s.hT, rot, span });
    const ax = Math.cos(rot);
    const az = -Math.sin(rot);
    for (const sg of [-1, 1]) {
      const px = cx + ax * sg * (span / 2 + 0.25);
      const pz = cz + az * sg * (span / 2 + 0.25);
      out.boxes.push([px - 0.3, pz - 0.3, px + 0.3, pz + 0.3, s.hT]);
    }
  }
}
