// Turns a block's structure + decoration into one merged mesh, and finalises the
// collision edge flags (balustrades, stair cheeks).

import { BLOCK, CELL, LEVEL_H, STEPS_PER_CELL, K_FLOOR, K_STAIR, K_BUILDING, K_LANDING, K_WATER, DX, DZ, M } from '../config.js';
import { GeoBuilder, T, circle } from './geometry.js';
import { hash3 } from './rng.js';
import { stairRamp, WATER_DROP, DECK_T } from './layout.js';
import { dirAngle } from './decorate.js';
import { COLUMN_H } from './templates.js';

const N = BLOCK;

export function wallPattern(obx, obz, oplot, dir, bandLevel) {
  const h = hash3(0x7a11 + oplot * 131 + dir * 7, obx, obz, bandLevel + 1000);
  const r = (h % 1000) / 1000;
  if (r < 0.3) return 'single';
  if (r < 0.48) return 'alt';
  if (r < 0.62) return 'twin';
  if (r < 0.73) return 'tall';
  if (r < 0.85) return 'blind';
  return 'plain';
}

function edgeCentre(i, j, d) {
  return [(i + 0.5 + DX[d] * 0.5) * CELL, (j + 0.5 + DZ[d] * 0.5) * CELL];
}

export function meshBlock(S, D, look, tp) {
  const b = new GeoBuilder(1 << 16);
  const eblock = D.eblock.slice();
  const plotOf = (c) => S.plots[S.plotId[c]];
  const setEdge = (i, j, d) => {
    if (i >= 0 && j >= 0 && i < N && j < N) eblock[j * N + i] |= 1 << d;
    const ni = i + DX[d];
    const nj = j + DZ[d];
    if (ni >= 0 && nj >= 0 && ni < N && nj < N) eblock[nj * N + ni] |= 1 << ((d + 2) % 4);
  };

  // --- floors (one quad per cell keeps the mesh free of T-junction cracks) --
  const floorMat = (c) => {
    const k = S.kind[c];
    if (k === K_FLOOR || k === K_LANDING) return D.floorMat[c] === M.GRASS ? M.GRASS : M.STONE;
    if (k === K_BUILDING && plotOf(c).roof === 'flat') return M.STONE;
    if (k === K_WATER) return M.WATER;
    return -1;
  };
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const m = floorMat(c);
      if (m < 0) continue;
      const y = S.base[c];
      b.m = m;
      b.quad([i * CELL, y, (j + 1) * CELL], [(i + 1) * CELL, y, (j + 1) * CELL], [(i + 1) * CELL, y, j * CELL], [i * CELL, y, j * CELL]);
    }
  }

  // --- walls ----------------------------------------------------------------
  const along = (i, j, d) => (d % 2 === 0 ? S.bz * N + j : S.bx * N + i);
  const emitBand = (pat, al, yb) => {
    switch (pat) {
      case 'single':
        b.appendTemplate(tp.windowSingle, T.translate(0, yb + 0.45, 0));
        break;
      case 'alt':
        if ((al & 1) === 0) b.appendTemplate(tp.windowSingle, T.translate(0, yb + 0.45, 0));
        else b.appendTemplate(tp.windowSmall, T.translate(0, yb + 1.2, 0));
        break;
      case 'twin':
        b.appendTemplate(tp.windowTwin, T.translate(0, yb + 0.4, 0));
        break;
      case 'tall':
        b.appendTemplate(tp.windowTall, T.translate(0, yb + 0.3, 0));
        break;
      case 'blind':
        b.appendTemplate(tp.blindArch, T.translate(0, yb + 0.12, 0));
        break;
      default:
    }
  };

  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const hC = S.base[c];
      const kc = S.kind[c];
      for (let d = 0; d < 4; d++) {
        const n = look(i + DX[d], j + DZ[d]);
        const hN = n.base;
        if (hC <= hN + 0.01) continue;
        // storeys over canal water count from the quays
        const hS = n.kind === K_WATER ? hN + WATER_DROP : hN;
        const [ex, ez] = edgeCentre(i, j, d);
        const stairish = kc === K_STAIR || kc === K_LANDING || n.kind === K_STAIR || n.kind === K_LANDING;
        b.withTransform(T.chain(T.translate(ex, 0, ez), T.rotY(dirAngle(d))), () => {
          b.m = M.STONE;
          b.quad([-1, hN - 0.2, 0], [1, hN - 0.2, 0], [1, hC, 0], [-1, hC, 0]);
          if (kc === K_STAIR) return;
          const h = hC - hN;
          if (h > 0.9) b.box(-1.06, hC - 0.34, 0, 1.06, hC, 0.11, 0b010111);
          const hs = hC - hS;
          if (stairish || hs < LEVEL_H - 0.05) return;
          const bands = Math.round(hs / LEVEL_H);
          for (let k = 1; k < bands; k++) {
            const y = hS + k * LEVEL_H;
            b.box(-1.03, y - 0.07, 0, 1.03, y + 0.07, 0.06, 0b011111);
          }
          const first = n.kind === K_FLOOR ? 1 : 0;
          const plot = S.plotId[c];
          for (let k = first; k < bands; k++) {
            const yb = hS + k * LEVEL_H;
            const pat = wallPattern(S.bx, S.bz, plot, d, Math.round(yb / LEVEL_H));
            emitBand(pat, along(i, j, d), yb);
          }
        });
      }
    }
  }

  // Ground-floor decoration of walls seen from this block's terraces.
  for (const r of D.band0) {
    const [ex, ez] = edgeCentre(r.i, r.j, r.d);
    const face = (r.d + 2) % 4;
    b.withTransform(T.chain(T.translate(ex, 0, ez), T.rotY(dirAngle(face))), () => {
      if (r.door) {
        b.appendTemplate(tp.door, T.translate(0, r.y, 0));
        return;
      }
      if (r.low) return;
      const pat = wallPattern(r.owner[0], r.owner[1], r.owner[2], face, Math.round(r.y / LEVEL_H));
      emitBand(pat, along(r.i, r.j, r.d), r.y);
    });
  }

  // --- balustrades ----------------------------------------------------------
  const posts = new Map();
  const edgeTopOf = (n, i, j, d) => {
    if (n.kind !== K_STAIR || !n.stair) return n.base;
    // endpoints of the shared edge, in the neighbour's block frame
    const ex0 = (i + (d === 0 ? 1 : 0)) * CELL;
    const ez0 = (j + (d === 1 ? 1 : 0)) * CELL;
    const ex1 = ex0 + (d % 2 === 1 ? CELL : 0);
    const ez1 = ez0 + (d % 2 === 0 ? CELL : 0);
    return Math.min(stairRamp(n.stair, ex0 - n.ox, ez0 - n.oz), stairRamp(n.stair, ex1 - n.ox, ez1 - n.oz));
  };
  const railed = new Uint8Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const k = S.kind[c];
      const flat = k === K_BUILDING && plotOf(c).roof === 'flat';
      if (!(k === K_FLOOR || k === K_LANDING || flat)) continue;
      const top = S.base[c];
      for (let d = 0; d < 4; d++) {
        const n = look(i + DX[d], j + DZ[d]);
        if (n.kind === K_BUILDING && n.base > top - 0.01) continue;
        if (n.deck === n.deck && Math.abs(n.deck - top) < 0.01) continue; // onto a bridge
        if (top - edgeTopOf(n, i, j, d) <= 1.0) continue;
        railed[c] |= 1 << d;
      }
    }
  }
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const c = j * N + i;
      const rm = railed[c];
      if (!rm) continue;
      const top = S.base[c];
      const walk = S.kind[c] !== K_BUILDING;
      for (let d = 0; d < 4; d++) {
        if (!(rm & (1 << d))) continue;
        const [ex, ez] = edgeCentre(i, j, d);
        const ix = ex - DX[d] * 0.15;
        const iz = ez - DZ[d] * 0.15;
        b.appendTemplate(tp.balPanel, T.chain(T.translate(ix, top, iz), T.rotY(dirAngle(d))));
        if (walk) setEdge(i, j, d);
        // posts at both ends of the edge
        const ax = DZ[d] !== 0 ? 1 : 0;
        const az = DX[d] !== 0 ? 1 : 0;
        for (const sg of [-1, 1]) {
          let px = ix + ax * sg * 1.0;
          let pz = iz + az * sg * 1.0;
          // outer corner: pull the post onto the perpendicular rail line
          const perp = sg > 0 ? (ax ? 0 : 1) : ax ? 2 : 3;
          if (rm & (1 << perp)) {
            px -= DX[perp] * 0.15;
            pz -= DZ[perp] * 0.15;
          }
          const key = `${Math.round(px * 20)},${Math.round(pz * 20)},${top}`;
          if (!posts.has(key)) posts.set(key, [px, top, pz]);
        }
      }
    }
  }
  for (const [px, py, pz] of posts.values()) b.appendTemplate(tp.balPost, T.translate(px, py, pz));

  // --- stairs and bridges ---------------------------------------------------
  for (const s of S.stairs) meshStair(b, s, look, tp, setEdge);
  for (const br of S.bridges) meshBridge(b, br, S, tp);

  // --- roofs ----------------------------------------------------------------
  for (const P of S.plots) {
    if (!P.building || P.roof === 'flat') continue;
    roof(b, P);
  }

  // --- features -------------------------------------------------------------
  for (const f of D.feats) feature(b, f, tp);

  return { geo: b.freeze(), eblock };
}

// ---------------------------------------------------------------------------

function meshStair(b, s, look, tp, setEdge) {
  const steps = s.n * STEPS_PER_CELL;
  const rise = (s.hT - s.hB) / steps;
  const tread = CELL / STEPS_PER_CELL;
  const xs = s.cells.map((c) => c[0]);
  const zs = s.cells.map((c) => c[1]);
  const X0 = Math.min(...xs) * CELL;
  const X1 = (Math.max(...xs) + 1) * CELL;
  const Z0 = Math.min(...zs) * CELL;
  const Z1 = (Math.max(...zs) + 1) * CELL;

  // local frame: x along the stair (bottom to top), z across, origin at the
  // middle of the bottom edge
  const dx = DX[s.dir];
  const dz = DZ[s.dir];
  const ang = Math.atan2(-dz, dx);
  const ox = s.dir === 0 ? X0 : s.dir === 2 ? X1 : (X0 + X1) / 2;
  const oz = s.dir === 1 ? Z0 : s.dir === 3 ? Z1 : (Z0 + Z1) / 2;
  const ca = Math.cos(ang);
  const sa = Math.sin(ang);
  const toWorld = (lx, lz) => [ox + ca * lx + sa * lz, oz - sa * lx + ca * lz];
  const W = s.w * CELL;
  const slope = rise / tread;
  const cheekTop = (a) => Math.min(s.hB + rise + 0.12 + slope * a, s.hT + 0.12);
  const F = T.chain(T.translate(ox, 0, oz), T.rotY(ang));

  // cheek walls where the stair stands proud of its surroundings
  const cheeks = {};
  for (const sg of [-1, 1]) {
    const [wx, wz] = [sa * sg, ca * sg];
    const sideDir = Math.abs(wx) > 0.5 ? (wx > 0 ? 0 : 2) : wz > 0 ? 1 : 3;
    const cheek = [];
    for (let t = 0; t < s.n; t++) {
      const [px, pz] = toWorld((t + 0.5) * CELL, sg * (W / 2 - 0.5));
      const ci = Math.floor(px / CELL);
      const cj = Math.floor(pz / CELL);
      const n = look(ci + DX[sideDir], cj + DZ[sideDir]);
      const rampTop = stairRamp(s, ...toWorld((t + 1) * CELL, 0));
      let drop = false;
      if (n.kind !== K_BUILDING) {
        let nTop = n.base;
        if (n.kind === K_STAIR && n.stair) nTop = stairRamp(n.stair, px + DX[sideDir] * CELL - n.ox, pz + DZ[sideDir] * CELL - n.oz);
        drop = rampTop - nTop > 0.9 && n.base < rampTop - 0.5;
      }
      cheek.push(drop);
      if (drop) setEdge(ci, cj, sideDir);
    }
    cheeks[sg] = { cheek, sideDir };
  }

  // steps; their side faces are dropped where a cheek covers them
  const sideMask = (sideDir) => (sideDir === 0 ? 1 : sideDir === 2 ? 2 : sideDir === 1 ? 16 : 32);
  b.m = M.STONE;
  const y0 = s.hB - 0.2;
  for (let k = 0; k < steps; k++) {
    const a0 = k * tread;
    const a1 = (k + 1) * tread;
    const top = s.hB + (k + 1) * rise;
    const t = Math.floor(k / STEPS_PER_CELL);
    let faces = 4;
    faces |= s.dir === 0 ? 2 : s.dir === 2 ? 1 : s.dir === 1 ? 32 : 16;
    for (const sg of [-1, 1]) if (!cheeks[sg].cheek[t]) faces |= sideMask(cheeks[sg].sideDir);
    switch (s.dir) {
      case 0:
        b.box(X0 + a0, y0, Z0, X0 + a1, top, Z1, faces);
        break;
      case 2:
        b.box(X1 - a1, y0, Z0, X1 - a0, top, Z1, faces);
        break;
      case 1:
        b.box(X0, y0, Z0 + a0, X1, top, Z0 + a1, faces);
        break;
      default:
        b.box(X0, y0, Z1 - a1, X1, top, Z1 - a0, faces);
    }
  }

  b.withTransform(F, () => {
    for (const sg of [-1, 1]) {
      const { cheek } = cheeks[sg];
      for (let t = 0; t < s.n; t++) {
        if (!cheek[t]) continue;
        const a0 = t * CELL;
        const a1 = (t + 1) * CELL;
        const pts = [[a0, y0], [a1, y0], [a1, cheekTop(a1)]];
        const brk = (s.hT - s.hB - rise) / slope; // where the cheek top flattens
        if (brk > a0 && brk < a1) pts.push([brk, cheekTop(brk)]);
        pts.push([a0, cheekTop(a0)]);
        const z0 = sg > 0 ? W / 2 - 0.26 : -W / 2;
        const z1 = sg > 0 ? W / 2 : -W / 2 + 0.26;
        b.m = M.STONE;
        b.extrude(pts, [], z0, z1, { front: true, back: true, sides: true });
        const zc = (z0 + z1) / 2;
        const xc = (a0 + a1) / 2;
        b.appendTemplate(tp.balPanel, T.chain(T.translate(xc, cheekTop(xc), zc), T.shearYX(slope)));
        if (t === 0 || !cheek[t - 1]) b.appendTemplate(tp.balPost, T.translate(a0 + 0.14, cheekTop(a0 + 0.14), zc));
        if (t === s.n - 1 || !cheek[t + 1]) b.appendTemplate(tp.balPost, T.translate(a1 - 0.14, Math.min(cheekTop(a1 - 0.14), s.hT), zc));
      }
    }
  });
}

// A bridge: a deck with balustrades on a row of arches. Piers stand where the
// layout put them; each opening gets the tallest pointed arch that still leaves
// headroom above the ground below, flattening to a segmental one when it must.
function meshBridge(b, br, S, tp) {
  const ax = DX[br.d];
  const az = DZ[br.d];
  const sx = br.i0 * CELL + (ax ? 0 : CELL / 2);
  const sz = br.j0 * CELL + (az ? 0 : CELL / 2);
  const F = T.chain(T.translate(sx, 0, sz), T.rotY(Math.atan2(-az, ax)));
  const L = br.n * CELL;
  const y = br.y;
  const yb = y - DECK_T;
  const hw = CELL / 2;
  const ground = br.cells.map((c) => S.base[c]);
  b.withTransform(F, () => {
    b.m = M.STONE;
    b.box(0, yb, -hw, L, y, hw, 4 | 16 | 32);
    for (const sg of [-1, 1]) {
      b.box(0, y - 0.34, sg > 0 ? hw : -hw - 0.11, L, y, sg > 0 ? hw + 0.11 : -hw, 4 | 8 | (sg > 0 ? 16 : 32));
      b.box(0, yb - 0.1, sg > 0 ? hw : -hw - 0.07, L, yb + 0.05, sg > 0 ? hw + 0.07 : -hw, 4 | 8 | (sg > 0 ? 16 : 32));
      for (let t = 0; t < br.n; t++) b.appendTemplate(tp.balPanel, T.translate(t * CELL + 1, y, sg * (hw - 0.15)));
      for (let t = 0; t <= br.n; t++) b.appendTemplate(tp.balPost, T.translate(t * CELL, y, sg * (hw - 0.15)));
    }
    const cuts = [0, ...br.piers, br.n];
    const PH = 0.36;
    const spring = [];
    for (let k = 1; k < cuts.length; k++) {
      const c0 = cuts[k - 1];
      const c1 = cuts[k];
      const u0 = c0 * CELL + (c0 > 0 ? PH : 0);
      const u1 = c1 * CELL - (c1 < br.n ? PH : 0);
      const w = u1 - u0;
      let gmax = -Infinity;
      for (let t = c0; t < c1; t++) gmax = Math.max(gmax, ground[t] + (S.kind[br.cells[t]] === K_WATER ? WATER_DROP : 0));
      const top = yb - 0.32;
      let rise = Math.min(w * 0.78, top - (gmax + 2.3));
      let ys = top - rise;
      const arch = [];
      if (rise < 0.25) {
        ys = top;
        rise = 0;
        arch.push([u0, ys], [u1, ys]);
      } else if (rise >= w / 2) {
        // pointed: two arcs centred on the springing line
        const c = (rise * rise - (w * w) / 4) / w;
        const R = c + w / 2;
        const ta = Math.atan2(rise, -c);
        const m = 7;
        for (let q = 0; q <= m; q++) {
          const a = Math.PI - ((Math.PI - ta) * q) / m;
          arch.push([u0 + w / 2 + c + R * Math.cos(a), ys + R * Math.sin(a), u0 + w / 2 + c, ys]);
        }
        for (let q = m - 1; q >= 0; q--) {
          const a = Math.PI - ((Math.PI - ta) * q) / m;
          arch.push([u0 + w / 2 - c - R * Math.cos(a), ys + R * Math.sin(a), u0 + w / 2 - c, ys]);
        }
      } else {
        // segmental
        const R = (w * w) / 4 / (2 * rise) + rise / 2;
        const yc = ys + rise - R;
        const a0 = Math.atan2(ys - yc, -w / 2);
        const a1 = Math.atan2(ys - yc, w / 2);
        const m = 12;
        for (let q = 0; q <= m; q++) {
          const a = a0 + ((a1 - a0) * q) / m;
          arch.push([u0 + w / 2 + R * Math.cos(a), yc + R * Math.sin(a), u0 + w / 2, yc]);
        }
      }
      // spandrel over the opening, full width
      const poly = [];
      for (const p of [[c0 * CELL, yb], [c0 * CELL, ys], ...arch, [c1 * CELL, ys], [c1 * CELL, yb]]) {
        const q = poly[poly.length - 1];
        if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-4) poly.push([p[0], p[1]]);
      }
      b.m = M.STONE;
      b.extrude(poly, [], -hw, hw, { front: true, back: true, sides: true });
      // voussoirs on both faces
      if (rise > 0) {
        const band = 0.34;
        for (const face of [1, -1]) {
          for (let q = 0; q < arch.length - 1; q++) {
            const p0 = arch[q];
            const p1 = arch[q + 1];
            const n0 = norm(p0[0] - p0[2], p0[1] - p0[3]);
            const n1 = norm(p1[0] - p1[2], p1[1] - p1[3]);
            const quad = [[p0[0], p0[1]], [p1[0], p1[1]], [p1[0] + n1[0] * band, p1[1] + n1[1] * band], [p0[0] + n0[0] * band, p0[1] + n0[1] * band]];
            b.m = br.striped ? (q % 2 === 0 ? M.STRIPE : M.CREAM) : M.STONE;
            const z0 = face > 0 ? hw : -hw - 0.06;
            b.extrude(quad, [], z0, z0 + 0.06, { front: face > 0, back: face < 0, sides: true });
          }
        }
      }
      spring[k] = ys;
    }
    // piers, down to the lower of the two grounds they stand between
    for (let k = 1; k < cuts.length - 1; k++) {
      const t = cuts[k];
      const u = t * CELL;
      const gA = ground[t - 1];
      const gB = ground[t];
      const ys = Math.min(spring[k], spring[k + 1]);
      b.m = M.STONE;
      b.box(u - PH, Math.min(gA, gB) - 0.2, -hw, u + PH, ys, hw, 0b110011);
      b.box(u - PH - 0.08, ys - 0.2, -hw - 0.08, u + PH + 0.08, ys, hw + 0.08, 0b111111);
      for (const [g, sg] of [[gA, -1], [gB, 1]]) {
        const x0 = sg < 0 ? u - PH - 0.1 : u;
        const x1 = sg < 0 ? u : u + PH + 0.1;
        b.box(x0, g, -hw - 0.1, x1, g + 0.4, hw + 0.1, 0b110111 & (sg < 0 ? ~1 : ~2));
      }
    }
  });
}

function norm(x, y) {
  const l = Math.hypot(x, y) || 1;
  return [x / l, y / l];
}

function roof(b, P) {
  const oh = 0.4;
  const X0 = P.x0 * CELL - oh;
  const X1 = P.x1 * CELL + oh;
  const Z0 = P.z0 * CELL - oh;
  const Z1 = P.z1 * CELL + oh;
  const y0 = P.level * LEVEL_H + 0.02;
  const w = X1 - X0;
  const d = Z1 - Z0;
  const pitch = P.roof === 'pyramid' ? 1.0 : 0.5;
  b.m = M.ROOF;
  if (w >= d) {
    const rh = (d / 2) * pitch;
    const zc = (Z0 + Z1) / 2;
    const ra = X0 + d / 2;
    const rb = X1 - d / 2;
    const top = y0 + rh;
    b.quad([X0, y0, Z1], [X1, y0, Z1], [rb, top, zc], [ra, top, zc]);
    b.quad([X1, y0, Z0], [X0, y0, Z0], [ra, top, zc], [rb, top, zc]);
    b.triangle([X1, y0, Z1], [X1, y0, Z0], [rb, top, zc]);
    b.triangle([X0, y0, Z0], [X0, y0, Z1], [ra, top, zc]);
  } else {
    const rh = (w / 2) * pitch;
    const xc = (X0 + X1) / 2;
    const ra = Z0 + w / 2;
    const rb = Z1 - w / 2;
    const top = y0 + rh;
    b.quad([X1, y0, Z1], [X1, y0, Z0], [xc, top, ra], [xc, top, rb]);
    b.quad([X0, y0, Z0], [X0, y0, Z1], [xc, top, rb], [xc, top, ra]);
    b.triangle([X0, y0, Z1], [X1, y0, Z1], [xc, top, rb]);
    b.triangle([X1, y0, Z0], [X0, y0, Z0], [xc, top, ra]);
  }
  // fascia
  b.m = M.CREAM;
  const f = 0.2;
  b.quad([X0, y0 - f, Z1], [X1, y0 - f, Z1], [X1, y0, Z1], [X0, y0, Z1]);
  b.quad([X1, y0 - f, Z0], [X0, y0 - f, Z0], [X0, y0, Z0], [X1, y0, Z0]);
  b.quad([X1, y0 - f, Z1], [X1, y0 - f, Z0], [X1, y0, Z0], [X1, y0, Z1]);
  b.quad([X0, y0 - f, Z0], [X0, y0 - f, Z1], [X0, y0, Z1], [X0, y0, Z0]);
  if (P.roof === 'pyramid') {
    b.m = M.GOLD;
    const xc = (X0 + X1) / 2;
    const zc = (Z0 + Z1) / 2;
    const top = y0 + (Math.min(w, d) / 2) * pitch;
    b.withTransform(T.translate(xc, top - 0.1, zc), () => b.lathe([[0.12, 0], [0.16, 0.25], [0.02, 0.8]], 8));
  }
}

// ---------------------------------------------------------------------------

function pickVar(arr, seed) {
  return arr[Math.abs(Math.floor(seed)) % arr.length];
}

function trough(b, len, dep, h, rim, soilMat = M.SOIL) {
  const x0 = -len / 2;
  const x1 = len / 2;
  const z0 = -dep / 2;
  const z1 = dep / 2;
  b.m = M.STONE;
  b.box(x0, 0, z0, x1, h, z1, 0b110011);
  // rim top
  b.box(x0, h - 0.01, z0, x1, h, z0 + rim, 0b000100);
  b.box(x0, h - 0.01, z1 - rim, x1, h, z1, 0b000100);
  b.box(x0, h - 0.01, z0 + rim, x0 + rim, h, z1 - rim, 0b000100);
  b.box(x1 - rim, h - 0.01, z0 + rim, x1, h, z1 - rim, 0b000100);
  // inner walls
  b.quad([x0 + rim, h - 0.12, z1 - rim], [x0 + rim, h - 0.12, z0 + rim], [x0 + rim, h, z0 + rim], [x0 + rim, h, z1 - rim]);
  b.quad([x1 - rim, h - 0.12, z0 + rim], [x1 - rim, h - 0.12, z1 - rim], [x1 - rim, h, z1 - rim], [x1 - rim, h, z0 + rim]);
  b.quad([x1 - rim, h - 0.12, z1 - rim], [x0 + rim, h - 0.12, z1 - rim], [x0 + rim, h, z1 - rim], [x1 - rim, h, z1 - rim]);
  b.quad([x0 + rim, h - 0.12, z0 + rim], [x1 - rim, h - 0.12, z0 + rim], [x1 - rim, h, z0 + rim], [x0 + rim, h, z0 + rim]);
  b.m = soilMat;
  b.quad([x0 + rim, h - 0.12, z1 - rim], [x1 - rim, h - 0.12, z1 - rim], [x1 - rim, h - 0.12, z0 + rim], [x0 + rim, h - 0.12, z0 + rim]);
}

function pot(b) {
  b.m = M.STONE;
  b.lathe([[0.3, 0], [0.42, 0.45], [0.47, 0.55], [0.45, 0.6]], 10);
  b.m = M.SOIL;
  b.lathe([[0.45, 0.6], [0.0, 0.56]], 10);
}

function feature(b, f, tp) {
  const at = (x, y, z, rot = 0, s = 1) => T.chain(T.translate(x, y, z), T.rotY(rot), T.scale(s, s, s));
  switch (f.t) {
    case 'planter': {
      b.withTransform(T.chain(T.translate(f.x, f.y, f.z), T.rotY(dirAngle(f.d))), () => trough(b, f.len, f.dep, 0.6, 0.12));
      for (const p of f.plants) {
        const tpl = p.k === 'agave' ? pickVar(tp.agave, p.seed) : pickVar(tp.broadleaf, p.seed);
        b.appendTemplate(tpl, at(p.x, f.y + 0.48, p.z, p.r, p.s));
      }
      if (f.palm) b.appendTemplate(pickVar(tp.palm, f.seed), at(f.x, f.y + 0.48, f.z, f.seed % 6, 0.85));
      break;
    }
    case 'palm':
      if (f.pot) {
        b.withTransform(T.translate(f.x, f.y, f.z), () => pot(b));
        b.appendTemplate(pickVar(tp.palm, f.seed), at(f.x, f.y + 0.56, f.z, f.seed % 6, f.s * 0.75));
      } else b.appendTemplate(pickVar(tp.palm, f.seed), at(f.x, f.y, f.z, f.seed % 6, f.s));
      break;
    case 'shrub':
      b.appendTemplate(pickVar(tp.broadleaf, f.seed), at(f.x, f.y, f.z, f.seed % 6, 1.35));
      break;
    case 'urns': {
      const offs = [[0, 0], [0.42, 0.2], [-0.2, 0.4]];
      for (let k = 0; k < f.n; k++) {
        const u = pickVar(tp.urn, f.seed + k);
        b.appendTemplate(u, at(f.x + offs[k][0], f.y, f.z + offs[k][1], k, k === 0 ? 1.15 : 0.85));
      }
      break;
    }
    case 'bench':
      b.appendTemplate(tp.bench, at(f.x, f.y, f.z, f.rot));
      break;
    case 'pinnacle': {
      const k = Math.max(0, Math.min(3, Math.round((f.h - 2.6) / 0.6)));
      b.appendTemplate(tp.pinnacles[k], T.translate(f.x, f.y, f.z));
      break;
    }
    case 'fountain':
      b.appendTemplate(tp.fountain, T.translate(f.x, f.y, f.z));
      break;
    case 'pool':
      b.appendTemplate(tp.pools[f.r] || tp.pools[2.4], T.translate(f.x, f.y, f.z));
      break;
    case 'statue':
      b.appendTemplate(pickVar(tp.statue, f.seed), at(f.x, f.y, f.z, f.rot));
      break;
    case 'garch':
      b.appendTemplate(tp.grandArch[f.striped ? 1 : 0], at(f.x, f.y, f.z, f.rot));
      break;
    case 'potplant':
      b.withTransform(T.translate(f.x, f.y, f.z), () => pot(b));
      b.appendTemplate(f.k === 'agave' ? pickVar(tp.agave, f.seed) : pickVar(tp.broadleaf, f.seed), at(f.x, f.y + 0.56, f.z, f.seed % 6, 0.8));
      break;
    case 'sarch':
      b.appendTemplate(tp.getStripedArch(f.span), at(f.x, f.y, f.z, f.rot));
      break;
    case 'palmbed': {
      b.withTransform(T.translate(f.x, f.y, f.z), () => trough(b, 3.2, 3.2, 0.55, 0.16, M.GRASS));
      b.appendTemplate(pickVar(tp.palm, f.seed), at(f.x, f.y + 0.43, f.z, f.seed % 6, 1.1));
      for (let k = 0; k < 4; k++) {
        const a = (k / 4) * Math.PI * 2 + 0.6;
        b.appendTemplate(pickVar(tp.agave, f.seed + k), at(f.x + Math.cos(a) * 0.95, f.y + 0.43, f.z + Math.sin(a) * 0.95, a, 0.8));
      }
      break;
    }
    case 'arcade': {
      const len = Math.hypot(f.bx - f.ax, f.bz - f.az);
      const n = Math.round(len / CELL);
      const ux = (f.bx - f.ax) / len;
      const uz = (f.bz - f.az) / len;
      const rot = Math.atan2(-uz, ux);
      for (let k = 0; k <= n; k++) {
        const x = f.ax + ux * k * CELL;
        const z = f.az + uz * k * CELL;
        b.appendTemplate(tp.column, T.translate(x, f.y, z));
        if (k < n) b.appendTemplate(tp.arcadeArch, at(x + ux * CELL * 0.5, f.y + COLUMN_H, z + uz * CELL * 0.5, rot));
      }
      break;
    }
    case 'cloister':
      cloister(b, f, tp, at);
      break;
    case 'pavilion':
      b.appendTemplate(tp.pavilion, T.translate(f.x, f.y, f.z));
      break;
    case 'obelisk': {
      const k = Math.max(0, Math.min(tp.obelisks.length - 1, Math.round(f.h) - 6));
      b.appendTemplate(tp.obelisks[k], at(f.x, f.y, f.z, (f.seed % 4) * (Math.PI / 2)));
      break;
    }
    case 'spout':
      b.appendTemplate(tp.spout, at(f.x, f.y, f.z, f.rot));
      break;
    case 'bollard':
      b.appendTemplate(tp.bollard, T.translate(f.x, f.y, f.z));
      break;
    case 'turret':
      turret(b, f);
      break;
    default:
  }
}

function cloister(b, f, tp, at) {
  const ent = new Set(f.ent.map(([i, j, d]) => `${i},${j},${d}`));
  const sides = [
    // [x0, z0, x1, z1, d, edges(i,j)]
    { ax: f.x0, az: f.z0, bx: f.x1, bz: f.z0, d: 3 },
    { ax: f.x1, az: f.z0, bx: f.x1, bz: f.z1, d: 0 },
    { ax: f.x1, az: f.z1, bx: f.x0, bz: f.z1, d: 1 },
    { ax: f.x0, az: f.z1, bx: f.x0, bz: f.z0, d: 2 },
  ];
  for (const s of sides) {
    const len = Math.hypot(s.bx - s.ax, s.bz - s.az);
    const n = Math.round(len / CELL);
    const ux = (s.bx - s.ax) / len;
    const uz = (s.bz - s.az) / len;
    const rot = Math.atan2(-uz, ux);
    for (let k = 0; k < n; k++) {
      const x = s.ax + ux * k * CELL;
      const z = s.az + uz * k * CELL;
      if (k > 0) b.appendTemplate(tp.column, T.translate(x, f.y, z));
      const mx = x + ux * CELL * 0.5;
      const mz = z + uz * CELL * 0.5;
      b.appendTemplate(tp.arcadeArch, at(mx, f.y + COLUMN_H, mz, rot));
      // which cell edge is this?
      const ci = Math.floor((mx - DX[s.d] * 0.5) / CELL);
      const cj = Math.floor((mz - DZ[s.d] * 0.5) / CELL);
      if (!ent.has(`${ci},${cj},${s.d}`)) b.appendTemplate(tp.parapet, at(mx, f.y, mz, rot));
    }
  }
  for (const [x, z] of [[f.x0, f.z0], [f.x1, f.z0], [f.x1, f.z1], [f.x0, f.z1]]) b.appendTemplate(tp.cornerPier, T.translate(x, f.y, z));
}

function turret(b, f) {
  const r = f.r;
  const y0 = f.y - 0.3;
  const y1 = f.y + f.h;
  b.withTransform(T.translate(f.x, 0, f.z), () => {
    b.m = M.STONE;
    b.prism(circle(r, 8, 0, 0, Math.PI / 8), y0, y1, { top: false });
    b.prism(circle(r + 0.12, 8, 0, 0, Math.PI / 8), y1 - 0.5, y1 - 0.32, { top: true });
    b.prism(circle(r + 0.2, 8, 0, 0, Math.PI / 8), y1, y1 + 0.16, { top: false });
    b.m = M.DARK;
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 8 + Math.PI / 8;
      b.withTransform(T.chain(T.rotY(a), T.translate(0, 0, r * Math.cos(Math.PI / 8) + 0.005)), () => {
        b.quad([-0.14, y1 - 1.6, 0], [0.14, y1 - 1.6, 0], [0.14, y1 - 0.8, 0], [-0.14, y1 - 0.8, 0]);
      });
    }
    b.m = M.ROOF;
    b.lathe([[r + 0.25, y1 + 0.16], [0.0, y1 + 0.16 + r * 2.1]], 8, { smooth: false, phase: Math.PI / 8 });
    b.m = M.GOLD;
    b.lathe([[0.08, y1 + r * 2.0], [0.12, y1 + r * 2.1 + 0.15], [0.0, y1 + r * 2.1 + 0.55]], 6);
  });
}
