// The walkable plots of a square of blocks as one graph: same-level frontage
// that no stair fills, stairs and bridges inside a block, and same-level
// ground across block edges. Used by the checks to tell what the traveller
// should be able to reach from the spawn.

import { BLOCK, K_BUILDING, K_WATER, K_STAIR } from '../src/config.js';

const N = BLOCK;

// S: Map "bx,bz" -> structure, covering the square [-R, R]^2 around (cx, cz).
export function plotGraph(S, R, cx = 0, cz = 0) {
  const ids = new Map();
  const nodes = [];
  const id = (bx, bz, p) => ids.get(`${bx},${bz},${p}`);
  for (const [key, T] of S) {
    const [bx, bz] = key.split(',').map(Number);
    for (const p of T.plots) {
      if (p.building || p.water) continue;
      ids.set(`${bx},${bz},${p.id}`, nodes.length);
      nodes.push({ bx, bz, T, p, area: p.w * p.d });
    }
  }
  const parent = nodes.map((_, k) => k);
  const find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const join = (a, b) => {
    if (a === undefined || b === undefined) return;
    parent[find(a)] = find(b);
  };
  const walk = (T, c) => T.kind[c] !== K_BUILDING && T.kind[c] !== K_WATER;
  for (const [key, T] of S) {
    const [bx, bz] = key.split(',').map(Number);
    for (const s of T.stairs) join(id(bx, bz, s.low), id(bx, bz, s.high));
    for (const b of T.bridges) join(id(bx, bz, b.pa), id(bx, bz, b.pb));
    // same-level cell pairs, inside the block and across its east and south edges
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const c = j * N + i;
        if (!walk(T, c) || T.kind[c] === K_STAIR) continue;
        for (const [di, dj] of [[1, 0], [0, 1]]) {
          let U = T;
          let ni = i + di;
          let nj = j + dj;
          let nbx = bx;
          let nbz = bz;
          if (ni >= N || nj >= N) {
            nbx += di;
            nbz += dj;
            U = S.get(`${nbx},${nbz}`);
            if (!U) continue;
            ni %= N;
            nj %= N;
          }
          const d = nj * N + ni;
          if (!walk(U, d) || U.kind[d] === K_STAIR || Math.abs(T.base[c] - U.base[d]) > 0.01) continue;
          join(id(bx, bz, T.plotId[c]), id(nbx, nbz, U.plotId[d]));
        }
      }
    }
  }
  // areas inside the square, skipping its outer ring of blocks (their far sides are cut off)
  const inner = (n) => Math.abs(n.bx - cx) < R && Math.abs(n.bz - cz) < R;
  const area = new Map();
  let walkArea = 0;
  for (let k = 0; k < nodes.length; k++) {
    if (!inner(nodes[k])) continue;
    walkArea += nodes[k].area;
    area.set(find(k), (area.get(find(k)) || 0) + nodes[k].area);
  }
  let mainArea = 0;
  for (const a of area.values()) mainArea = Math.max(mainArea, a);
  const T0 = S.get(`${cx},${cz}`);
  const g = T0.gates.find((q) => q.dir === 3) || T0.gates[0];
  const spawn = find(id(cx, cz, T0.plotId[g.j * N + g.i]));
  return { nodes, find, id, walkArea, mainArea, spawnArea: area.get(spawn) || 0, spawn };
}
