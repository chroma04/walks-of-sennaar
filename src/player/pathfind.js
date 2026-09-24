// A* over a 0.5 m lattice using the world's walkability queries, followed by
// line-of-sight smoothing. Used for click / tap to walk.

const STEP = 0.5;
const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
];

class Heap {
  constructor() {
    this.a = [];
  }
  push(n) {
    const a = this.a;
    a.push(n);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].f < a[m].f) m = l;
        if (r < a.length && a[r].f < a[m].f) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
  get size() {
    return this.a.length;
  }
}

const K = (ix, iz) => (ix + 1e6) * 4e6 + (iz + 1e6);

const MARGIN = 0.12;

// Plan with a little clearance so the traveller never grazes corners; fall back
// to the bare radius when squeezed (e.g. starting right next to a wall).
export function findPath(world, from, goal, radius, maxNodes = 14000) {
  return plan(world, from, goal, radius + MARGIN, maxNodes) || plan(world, from, goal, radius, maxNodes);
}

function plan(world, from, goal, radius, maxNodes) {
  const sx = Math.round(from.x / STEP);
  const sz = Math.round(from.z / STEP);
  // nearest standable lattice point to the goal
  const gx = Math.round(goal.x / STEP);
  const gz = Math.round(goal.z / STEP);
  let target = null;
  let best = Infinity;
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) {
      const x = (gx + dx) * STEP;
      const z = (gz + dz) * STEP;
      const h = world.standAt(x, z, radius);
      if (Number.isNaN(h)) continue;
      const d = Math.hypot(x - goal.x, z - goal.z) + Math.abs(h - goal.y) * 0.5;
      if (d < best) {
        best = d;
        target = { ix: gx + dx, iz: gz + dz };
      }
    }
  }
  if (!target) return null;
  const tx = target.ix;
  const tz = target.iz;
  const h0 = (ix, iz) => Math.hypot(ix - tx, iz - tz);

  const open = new Heap();
  const nodes = new Map();
  const start = { ix: sx, iz: sz, x: from.x, z: from.z, y: from.y, g: 0, f: h0(sx, sz), parent: null, closed: false };
  nodes.set(K(sx, sz), start);
  open.push(start);
  let found = null;
  let expanded = 0;
  let closest = start;
  while (open.size && expanded < maxNodes) {
    const n = open.pop();
    if (n.closed) continue;
    n.closed = true;
    expanded++;
    if (n.ix === tx && n.iz === tz) {
      found = n;
      break;
    }
    if (n.f - n.g < closest.f - closest.g) closest = n;
    for (const [ox, oz, cost] of DIRS) {
      const ix = n.ix + ox;
      const iz = n.iz + oz;
      const k = K(ix, iz);
      let m = nodes.get(k);
      if (m && m.closed) continue;
      const x = ix * STEP;
      const z = iz * STEP;
      if (!m) {
        const y = world.canTraverse(n.x, n.z, n.y, x, z, radius);
        if (Number.isNaN(y)) {
          nodes.set(k, { closed: true });
          continue;
        }
        // diagonal moves must not cut corners
        if (ox && oz) {
          const ya = world.standAt(n.x + ox * STEP, n.z, radius, n.y);
          const yb = world.standAt(n.x, n.z + oz * STEP, radius, n.y);
          if (Number.isNaN(ya) || Number.isNaN(yb)) continue;
        }
        m = { ix, iz, x, z, y, g: Infinity, f: Infinity, parent: null, closed: false };
        nodes.set(k, m);
      } else if (m.y === undefined) continue;
      else if (Math.abs(m.y - n.y) > 0.55 || world.crossesBarrier(n.x, n.z, x, z)) continue;
      const g = n.g + cost + Math.abs(m.y - n.y) * 0.8;
      if (g < m.g) {
        m.g = g;
        m.f = g + h0(ix, iz) * 1.05;
        m.parent = n;
        open.push(m);
      }
    }
  }
  const end = found || (closest !== start ? closest : null);
  if (!end) return null;
  const pts = [];
  for (let n = end; n; n = n.parent) pts.push({ x: n.x, y: n.y, z: n.z });
  pts.reverse();
  return { points: smooth(world, pts, radius), complete: !!found };
}

function clearLine(world, a, b, radius) {
  const d = Math.hypot(b.x - a.x, b.z - a.z);
  const n = Math.max(1, Math.ceil(d / 0.25));
  let px = a.x;
  let pz = a.z;
  let py = a.y;
  for (let k = 1; k <= n; k++) {
    const x = a.x + ((b.x - a.x) * k) / n;
    const z = a.z + ((b.z - a.z) * k) / n;
    const y = world.canTraverse(px, pz, py, x, z, radius);
    if (Number.isNaN(y)) return false;
    px = x;
    pz = z;
    py = y;
  }
  return true;
}

function smooth(world, pts, radius) {
  if (pts.length <= 2) return pts.slice(1);
  const out = [];
  let i = 0;
  while (i < pts.length - 1) {
    let j = Math.min(pts.length - 1, i + 32);
    while (j > i + 1 && !clearLine(world, pts[i], pts[j], radius)) j--;
    out.push(pts[j]);
    i = j;
  }
  return out;
}
