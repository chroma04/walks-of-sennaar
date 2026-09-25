// Composition: furnishing laid out on purpose rather than scattered. A plaza
// takes an axis from its main entrance (a stair head, a gate from the next
// block, a bridge); its centrepiece stands on that line and faces the way in,
// a paved runner may lead up to it, and rows of cypresses, palms or lamps line
// the axis either side. Entrances are framed by matching pairs, and whatever
// else stands about the plaza comes in pairs mirrored across the axis.

import { BLOCK, CELL, LEVEL_H, K_FLOOR, DX, DZ } from '../config.js';
import { hasDeck, roomFor, inside, dirAngle, orientedBox } from './site.js';

const N = BLOCK;

// ---------------------------------------------------------------------------
// Props that come in pairs and rows

// One look shared by every member of a pair or a row.
export function propSpec(ctx, kind) {
  const { rng } = ctx;
  return { kind, seed: Math.floor(rng() * 1e6), s: 0.85 + rng() * 0.3, n: 1 + Math.floor(rng() * 2) };
}

// Places a prop at (x, z), turned to face direction `face`.
export function putProp(ctx, spec, x, z, y, face = 0) {
  const { out } = ctx;
  const { kind, seed } = spec;
  switch (kind) {
    case 'palm':
      out.feats.push({ t: 'palm', x, z, y, pot: true, s: spec.s, seed });
      out.circles.push([x, z, 0.5, y]);
      break;
    case 'agave':
      out.feats.push({ t: 'potplant', x, z, y, k: 'agave', seed });
      out.circles.push([x, z, 0.5, y]);
      break;
    case 'urn':
      out.feats.push({ t: 'urns', x, z, y, n: 1, seed });
      out.circles.push([x, z, 0.42, y]);
      break;
    case 'urns':
      out.feats.push({ t: 'urns', x, z, y, n: spec.n + 1, seed });
      out.circles.push([x + 0.1, z + 0.2, 0.75, y]);
      break;
    case 'pitpalm':
      out.feats.push({ t: 'pitpalm', x, z, y, s: spec.s + 0.1, seed });
      out.boxes.push([x - 0.56, z - 0.56, x + 0.56, z + 0.56, y]);
      break;
    case 'cypress':
      out.feats.push({ t: 'cypress', x, z, y, seed });
      out.boxes.push([x - 0.56, z - 0.56, x + 0.56, z + 0.56, y]);
      break;
    case 'stele':
      out.feats.push({ t: 'stele', x, z, y, rot: dirAngle(face), seed });
      out.boxes.push(orientedBox(x, z, face, 1.1, 0.52, y));
      break;
    case 'bench':
      out.feats.push({ t: 'bench', x, z, y, rot: dirAngle(face) });
      out.boxes.push(orientedBox(x, z, face, 1.5, 0.5, y));
      break;
    default:
      // lamp, brazier, banner
      out.feats.push({ t: kind, x, z, y, rot: dirAngle(face), seed });
      out.circles.push([x, z, kind === 'lamp' ? 0.3 : 0.34, y]);
  }
}

// ---------------------------------------------------------------------------
// Entrances and the axis

// Where the walk comes into plot P: the heads and feet of its stairs, gates
// from the next block and the ends of bridges. h is the heading on the way in.
export function entrances(ctx, P) {
  const { S } = ctx;
  const y = P.level * LEVEL_H;
  const onP = ([i, j]) => inside(P, i, j) && S.kind[j * N + i] === K_FLOOR && Math.abs(S.base[j * N + i] - y) < 0.01;
  const res = [];
  for (const s of S.stairs) {
    if (s.high === P.id && s.exit.every(onP)) res.push({ kind: 'top', cells: s.exit, h: s.type === 'parallel' ? s.wallDir : s.dir, w: s.w });
    if (s.low === P.id && s.foot.every(onP)) res.push({ kind: 'foot', cells: s.foot, h: (s.dir + 2) % 4, w: s.w });
  }
  for (const g of S.gates) if (onP([g.i, g.j])) res.push({ kind: 'gate', cells: [[g.i, g.j]], h: (g.dir + 2) % 4, w: 1 });
  for (const br of S.bridges) {
    for (const [end, h] of [[br.a, (br.d + 2) % 4], [br.b, br.d]]) {
      const cell = [end % N, Math.floor(end / N)];
      if (onP(cell)) res.push({ kind: 'bridge', cells: [cell], h, w: 1, arch: !!br.gate });
    }
  }
  for (const e of res) {
    const lat = (e.h + 1) % 4;
    const ls = e.cells.map(([i, j]) => (lat % 2 === 0 ? i : j));
    e.c = (Math.min(...ls) + Math.max(...ls) + 1) / 2; // lateral centre, in cells
    e.a = e.h % 2 === 0 ? e.cells[0][0] : e.cells[0][1]; // along index of its cells
  }
  return res;
}

// Extents of P along heading h and across it.
export function extents(P, h) {
  return h % 2 === 0 ? { a0: P.x0, a1: P.x1, l0: P.z0, l1: P.z1 } : { a0: P.z0, a1: P.z1, l0: P.x0, l1: P.x1 };
}

const sgnOf = (h) => (h === 0 || h === 1 ? 1 : -1);
export const cellAt = (h, a, l) => (h % 2 === 0 ? [a, l] : [l, a]);

// The axis of a plaza: the line in from its most telling entrance, one that
// looks well across the plot and not too far off its middle.
export function chooseAxis(ctx, P, ents) {
  let best = null;
  for (const e of ents) {
    const { a0, a1, l0, l1 } = extents(P, e.h);
    const depth = sgnOf(e.h) > 0 ? a1 - e.a : e.a - a0 + 1;
    if (depth < 4) continue;
    const off = Math.abs(e.c - (l0 + l1) / 2) / ((l1 - l0) / 2);
    const kindW = { top: 1.2, gate: 1.0, foot: 0.8, bridge: 0.9 }[e.kind];
    const score = kindW + (e.w >= 2 ? 0.3 : 0) + 1.2 * (depth / (a1 - a0)) - 1.4 * off + ctx.rng() * 0.3;
    if (!best || score > best.score) best = { score, e };
  }
  if (!best) return null;
  const { e } = best;
  return { h: e.h, c: e.c, e };
}

// ---------------------------------------------------------------------------
// Framing entrances

// Whether a prop cell touches (or is) a cell some other prop stands in. Props
// in neighbouring cells leave gaps between them too narrow to walk, and those
// can close off slivers of floor.
export function besideProp(ctx, i, j, props = null) {
  for (let q = j - 1; q <= j + 1; q++) {
    for (let p = i - 1; p <= i + 1; p++) {
      if (p < 0 || q < 0 || p >= N || q >= N) continue;
      const c = q * N + p;
      if (props ? props.has(c) : ctx.used[c] === 3) return true;
    }
  }
  return false;
}

function freeFloor(ctx, P, [i, j], y) {
  const { S } = ctx;
  if (!inside(P, i, j)) return false;
  const c = j * N + i;
  return S.kind[c] === K_FLOOR && Math.abs(S.base[c] - y) < 0.01 && ctx.used[c] === 0 && !hasDeck(ctx, i, j) && !ctx.abut.has(c) && !besideProp(ctx, i, j);
}

// Claims a cell for a composed prop.
export function claim(ctx, i, j) {
  ctx.used[j * N + i] = 3;
  ctx.props.add(j * N + i);
}

// Big props sit square in their cells: pulled to one side they would leave a
// strip beside them just wide enough to stand in and be shut in.
const BIG = new Set(['cypress', 'pitpalm', 'palm', 'agave', 'urns']);

// A matching pair either side of an entrance, drawn in towards it.
export function flank(ctx, P, e, spec, y) {
  const lat = (e.h + 1) % 4;
  const proj = ([i, j]) => i * DX[lat] + j * DZ[lat];
  const cs = e.cells.slice().sort((p, q) => proj(p) - proj(q));
  const lo = cs[0];
  const hi = cs[cs.length - 1];
  const A = [lo[0] - DX[lat], lo[1] - DZ[lat]];
  const B = [hi[0] + DX[lat], hi[1] + DZ[lat]];
  if (!freeFloor(ctx, P, A, y) || !freeFloor(ctx, P, B, y) || !roomFor(ctx, P, [A, B])) return false;
  const back = (e.h + 2) % 4;
  const pull = BIG.has(spec.kind) ? 0 : 0.4;
  for (const [[i, j], sg] of [[A, 1], [B, -1]]) {
    const x = (i + 0.5) * CELL + DX[back] * pull + DX[lat] * sg * pull;
    const z = (j + 0.5) * CELL + DZ[back] * pull + DZ[lat] * sg * pull;
    putProp(ctx, spec, x, z, y, back);
    claim(ctx, i, j);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Along the axis

// A paved runner from an entrance up to the foot of the centrepiece.
export function runner(ctx, P, y, e, piece) {
  const { S } = ctx;
  const h = e.h;
  const sg = sgnOf(h);
  const pa0 = h % 2 === 0 ? piece.i0 : piece.j0;
  const pa1 = h % 2 === 0 ? piece.i1 : piece.j1;
  const stop = sg > 0 ? pa0 : pa1 - 1; // first cell of the piece met on the way
  const steps = [];
  for (let a = e.a; a !== stop; a += sg) {
    steps.push(a);
    if (steps.length > N) return false;
  }
  if (steps.length < 2) return false;
  const cols = Number.isInteger(e.c) ? [e.c - 1, e.c] : [e.c - 0.5];
  const cells = [];
  for (const a of steps) {
    for (const l of cols) {
      const [i, j] = cellAt(h, a, l);
      if (!inside(P, i, j)) return false;
      const c = j * N + i;
      const u = ctx.used[c];
      if (S.kind[c] !== K_FLOOR || Math.abs(S.base[c] - y) > 0.01 || u === 1 || u === 3 || hasDeck(ctx, i, j)) return false;
      cells.push(c);
    }
  }
  const start = sg > 0 ? e.a : e.a + 1; // boundary the walk comes in across
  const end = sg > 0 ? stop : stop + 1;
  const [x, z] = h % 2 === 0 ? [start * CELL, e.c * CELL] : [e.c * CELL, start * CELL];
  ctx.out.feats.push({ t: 'runner', x, z, y, rot: dirAngle(h), len: Math.abs(end - start) * CELL });
  for (const c of cells) if (ctx.used[c] === 0) ctx.used[c] = 2;
  return true;
}

// Rows of trees or lamps either side of the axis, mirrored across it and
// spaced evenly about the middle of the plot.
export function allee(ctx, P, y, axis, specs) {
  const { h, c } = axis;
  const { a0, a1, l0, l1 } = extents(P, h);
  if (a1 - a0 < 7 || l1 - l0 < 6) return false;
  // the rows' lateral cells, about a quarter of the way across each side
  const want = Math.max(1.5, (l1 - l0) / 4);
  let lA = null;
  for (let l = Math.ceil(c) - 1; l >= l0 + 1; l--) {
    const m = 2 * c - l - 1;
    const dist = c - (l + 0.5);
    if (m > l1 - 2 || dist < 1.4) continue;
    if (lA === null || Math.abs(dist - want) < Math.abs(c - (lA + 0.5) - want)) lA = l;
  }
  if (lA === null) return false;
  const lB = 2 * c - lA - 1;
  const mid = (a0 + a1 - 1) / 2;
  const offs = [];
  for (let o = Number.isInteger(mid) ? 0 : 0.5; mid - o >= a0 + 1; o += 2) offs.push(o);
  let placed = 0;
  offs.forEach((o, oi) => {
    for (const a of o === 0 ? [mid] : [mid - o, mid + o]) {
      if (a > a1 - 2) continue;
      const A = cellAt(h, a, lA);
      const B = cellAt(h, a, lB);
      if (!freeFloor(ctx, P, A, y) || !freeFloor(ctx, P, B, y) || !roomFor(ctx, P, [A, B])) continue;
      const spec = specs[oi % specs.length];
      const lat = (h + 1) % 4;
      for (const [[i, j], toward] of [[A, lat], [B, (lat + 2) % 4]]) {
        putProp(ctx, spec, (i + 0.5) * CELL, (j + 0.5) * CELL, y, toward);
        claim(ctx, i, j);
      }
      placed++;
    }
  });
  return placed >= 2;
}

// Four matching pieces at the corners of the clear ring round a centrepiece.
export function satellites(ctx, P, y, piece, spec) {
  const { S } = ctx;
  const cells = [
    [piece.i0 - 1, piece.j0 - 1],
    [piece.i1, piece.j0 - 1],
    [piece.i1, piece.j1],
    [piece.i0 - 1, piece.j1],
  ];
  const ok = cells.every(([i, j]) => {
    if (!inside(P, i, j)) return false;
    const c = j * N + i;
    return S.kind[c] === K_FLOOR && Math.abs(S.base[c] - y) < 0.01 && (ctx.used[c] === 0 || ctx.used[c] === 2) && !hasDeck(ctx, i, j) && !ctx.abut.has(c) && !besideProp(ctx, i, j, ctx.props);
  });
  if (!ok || !roomFor(ctx, P, cells)) return false;
  const cx = ((piece.i0 + piece.i1) / 2) * CELL;
  const cz = ((piece.j0 + piece.j1) / 2) * CELL;
  for (const [i, j] of cells) {
    let x = (i + 0.5) * CELL;
    let z = (j + 0.5) * CELL;
    // drawn in a little towards the piece
    const pull = BIG.has(spec.kind) ? 0 : 0.3;
    x += Math.sign(cx - x) * pull;
    z += Math.sign(cz - z) * pull;
    const face = Math.abs(cx - x) > Math.abs(cz - z) ? (cx > x ? 0 : 2) : cz > z ? 1 : 3;
    putProp(ctx, spec, x, z, y, face);
    claim(ctx, i, j);
  }
  return true;
}

// Two benches either side of a centrepiece, looking at it across the axis.
export function facingBenches(ctx, P, y, axis, piece) {
  const { S } = ctx;
  const h = axis.h;
  const lat = (h + 1) % 4;
  const pa0 = h % 2 === 0 ? piece.i0 : piece.j0;
  const pa1 = h % 2 === 0 ? piece.i1 : piece.j1;
  const pl0 = h % 2 === 0 ? piece.j0 : piece.i0;
  const pl1 = h % 2 === 0 ? piece.j1 : piece.i1;
  const am = (pa0 + pa1) / 2;
  const along = Number.isInteger(am) ? [am - 1, am] : [am - 0.5];
  const sides = [
    [pl0 - 1, lat],
    [pl1, (lat + 2) % 4],
  ];
  const all = [];
  for (const [l] of sides) for (const a of along) all.push(cellAt(h, a, l));
  const ok = all.every(([i, j]) => {
    if (!inside(P, i, j)) return false;
    const c = j * N + i;
    return S.kind[c] === K_FLOOR && Math.abs(S.base[c] - y) < 0.01 && (ctx.used[c] === 0 || ctx.used[c] === 2) && !hasDeck(ctx, i, j);
  });
  if (!ok || !roomFor(ctx, P, all)) return false;
  const spec = { kind: 'bench' };
  for (const [l, face] of sides) {
    const [x, z] = h % 2 === 0 ? [am * CELL, (l + 0.5) * CELL] : [(l + 0.5) * CELL, am * CELL];
    // set back a little from the piece
    putProp(ctx, spec, x - DX[face] * 0.35, z - DZ[face] * 0.35, y, face);
  }
  for (const [i, j] of all) claim(ctx, i, j);
  return true;
}

// Whatever else stands about a big plaza comes in pairs mirrored across its
// axis (or across its middle, if it has none).
export function mirroredScatter(ctx, P, y, axis, want) {
  const { rng } = ctx;
  const h = axis ? axis.h : P.w >= P.d ? 0 : 1;
  const { a0, a1, l0, l1 } = extents(P, h);
  const c = axis ? axis.c : (l0 + l1) / 2;
  let placed = 0;
  for (let tries = 0; tries < want * 8 && placed < want; tries++) {
    const a = a0 + 1 + Math.floor(rng() * (a1 - a0 - 2));
    const l = l0 + 1 + Math.floor(rng() * (l1 - l0 - 2));
    const m = 2 * c - l - 1;
    if (!Number.isInteger(m) || m < l0 + 1 || m > l1 - 2 || Math.abs(m - l) < 2) continue;
    const A = cellAt(h, a, l);
    const B = cellAt(h, a, m);
    const clear = ([i, j]) => {
      for (let q = j - 1; q <= j + 1; q++) {
        for (let p = i - 1; p <= i + 1; p++) {
          if (p < 0 || q < 0 || p >= N || q >= N) return false;
          const u = ctx.used[q * N + p];
          if (u === 1 || u === 3) return false;
        }
      }
      return true;
    };
    if (!freeFloor(ctx, P, A, y) || !freeFloor(ctx, P, B, y) || !clear(A) || !clear(B) || !roomFor(ctx, P, [A, B])) continue;
    const r = rng();
    const spec = propSpec(ctx, r < 0.35 ? 'palm' : r < 0.55 ? 'agave' : r < 0.72 ? 'urns' : r < 0.86 ? 'bench' : 'lamp');
    const lat = (h + 1) % 4;
    for (const [[i, j], toward] of [[A, l < c ? lat : (lat + 2) % 4], [B, l < c ? (lat + 2) % 4 : lat]]) {
      // benches run along the axis; the rest turn to face it
      putProp(ctx, spec, (i + 0.5) * CELL, (j + 0.5) * CELL, y, spec.kind === 'bench' ? lat : toward);
      claim(ctx, i, j);
    }
    placed++;
  }
  return placed;
}

// A long narrow plaza (three or five cells across) gets a single row down its
// middle, spaced evenly about its centre, like the median of a boulevard.
export function median(ctx, P, y, spec) {
  const h = P.w >= P.d ? 0 : 1;
  const { a0, a1, l0, l1 } = extents(P, h);
  const across = l1 - l0;
  if (a1 - a0 < 8 || (across !== 3 && across !== 5)) return false;
  const l = (l0 + l1 - 1) / 2;
  const mid = (a0 + a1 - 1) / 2;
  const at = [];
  for (let o = Number.isInteger(mid) ? 0 : 1.5; mid - o >= a0 + 1; o += 3) at.push(...(o === 0 ? [mid] : [mid - o, mid + o]));
  let placed = 0;
  for (const a of at) {
    if (a > a1 - 2) continue;
    const cell = cellAt(h, a, l);
    if (!freeFloor(ctx, P, cell, y) || !roomFor(ctx, P, [cell])) continue;
    putProp(ctx, spec, (cell[0] + 0.5) * CELL, (cell[1] + 0.5) * CELL, y, h);
    claim(ctx, cell[0], cell[1]);
    placed++;
  }
  return placed >= 2;
}
