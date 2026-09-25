// Reusable geometry pieces, built once per worker and stamped with transforms.

import { GeoBuilder, T, pointedArch, pointedArchHeight, roundArch, circle, rect, quatrefoil } from './geometry.js';
import { M } from '../config.js';
import { makeRng } from './rng.js';

const HEX = (r, phase = Math.PI / 6) => circle(r, 6, 0, 0, phase);

function setSway(tpl, y0, y1, max = 255, onlyMat = M.FOLIAGE) {
  for (let i = 0; i < tpl.count; i++) {
    if (tpl.mat[i * 2] !== onlyMat) continue;
    const y = tpl.pos[i * 3 + 1];
    const f = Math.max(0, Math.min(1, (y - y0) / (y1 - y0)));
    tpl.mat[i * 2 + 1] = Math.round(f * f * max);
  }
  return tpl;
}

// ---------------------------------------------------------------------------
// Wall pieces (local XY is the wall plane, +Z points out of the wall)

function archFrame(b, w, hs, k, t, depth, y0 = 0, paneMat = M.WINDOW) {
  const r = k * w;
  const wi = w - 2 * t;
  const ki = (r - t) / wi;
  const outer = pointedArch(w, hs, k, 5, y0);
  const inner = pointedArch(wi, hs, ki, 5, y0 + t);
  b.m = M.STONE;
  b.extrude(outer, [inner], 0, depth, { front: true, sides: true });
  if (paneMat !== null) {
    const top = pointedArchHeight(wi, hs, ki);
    b.m = paneMat;
    b.extrude(inner, [], 0, 0.02, { front: true, sides: false, uvScale: [-wi / 2, y0 + t, 1 / wi, 1 / (top - y0 - t)] });
  }
}

function windowSingle() {
  const b = new GeoBuilder(512);
  archFrame(b, 1.0, 1.3, 0.8, 0.11, 0.09, 0);
  b.m = M.STONE;
  b.box(-0.6, -0.1, 0, 0.6, 0.02, 0.17, 0b010111);
  return b.freeze();
}

function windowTwin() {
  const b = new GeoBuilder(512);
  b.withTransform(T.translate(-0.3, 0, 0), () => archFrame(b, 0.5, 1.5, 1.0, 0.07, 0.08, 0));
  b.withTransform(T.translate(0.3, 0, 0), () => archFrame(b, 0.5, 1.5, 1.0, 0.07, 0.08, 0));
  b.m = M.STONE;
  b.box(-0.65, -0.1, 0, 0.65, 0.02, 0.15, 0b010111);
  return b.freeze();
}

function windowTall() {
  const b = new GeoBuilder(512);
  archFrame(b, 0.85, 1.65, 0.85, 0.1, 0.09, 0);
  b.m = M.STONE;
  b.box(-0.52, -0.1, 0, 0.52, 0.02, 0.16, 0b010111);
  return b.freeze();
}

function windowSmall() {
  const b = new GeoBuilder(256);
  archFrame(b, 0.7, 0.65, 0.8, 0.09, 0.08, 0);
  return b.freeze();
}

function blindArch() {
  const b = new GeoBuilder(512);
  const w = 1.7;
  b.m = M.STONE;
  // ring only (open at the bottom): build as two jambs + arch band
  const ringOuter = [];
  const ringInner = [];
  for (let s = 0; s <= 9; s++) {
    const a = (s / 9) * Math.PI;
    ringOuter.push([(w / 2) * Math.cos(a), 1.35 + (w / 2) * Math.sin(a)]);
    ringInner.push([((w - 0.24) / 2) * Math.cos(a), 1.35 + ((w - 0.24) / 2) * Math.sin(a)]);
  }
  const band = ringOuter.concat(ringInner.slice().reverse());
  b.extrude(band, [], 0, 0.1, { front: true, sides: true });
  b.box(-w / 2, 0, 0, -w / 2 + 0.12, 1.35, 0.1, 0b010111);
  b.box(w / 2 - 0.12, 0, 0, w / 2, 1.35, 0.1, 0b010111);
  b.m = M.WINDOW;
  const pane = roundArch(w - 0.24, 1.35, 9, 0);
  b.extrude(pane, [], 0, 0.015, { front: true, sides: false, uvScale: [-(w - 0.24) / 2, 0, 1 / (w - 0.24), 1 / 2.2] });
  return b.freeze();
}

function door() {
  const b = new GeoBuilder(512);
  const w = 1.5;
  const hs = 1.6;
  const k = 0.75;
  const t = 0.16;
  const r = k * w;
  const wi = w - 2 * t;
  const ki = (r - t) / wi;
  const outer = pointedArch(w, hs, k, 6, 0);
  // frame open at the bottom: outer arch minus inner arch starting at y = 0
  const inner = pointedArch(wi, hs, ki, 6, 0);
  const frame = [];
  // outer from bottom-left CCW up over to bottom-right... construct explicitly
  const oTop = outer.slice(2); // right springer .. apex .. left springer
  const iTop = inner.slice(2);
  frame.push([w / 2, 0]);
  frame.push(...oTop);
  frame.push([-w / 2, 0]);
  frame.push([-wi / 2, 0]);
  frame.push(...iTop.slice().reverse());
  frame.push([wi / 2, 0]);
  b.m = M.STONE;
  b.extrude(frame, [], 0, 0.15, { front: true, sides: true });
  const top = pointedArchHeight(wi, hs, ki);
  b.m = M.DOOR;
  b.extrude(inner, [], 0, 0.03, { front: true, sides: false, uvScale: [-wi / 2, 0, 1 / wi, 1 / top] });
  b.m = M.STONE;
  b.box(-0.95, 0, 0, 0.95, 0.1, 0.45, 0b010111);
  return b.freeze();
}

// ---------------------------------------------------------------------------
// Balustrade (spans x in [-1, 1], centred on z = 0)

function balustradePanel() {
  const b = new GeoBuilder(1024);
  const holes = [];
  for (const hx of [-0.63, -0.21, 0.21, 0.63]) {
    holes.push(pointedArch(0.24, 0.3, 0.9, 3, 0.22).map(([x, y]) => [x + hx, y]));
  }
  const outer = rect(-0.87, 0.1, 0.87, 0.8);
  b.m = M.STONE;
  b.extrude(outer, holes, -0.07, 0.07, { front: true, back: true, sides: false });
  for (const h of holes) b.extrudeRing(h.slice().reverse(), -0.07, 0.07);
  // rail
  b.box(-1, 0.8, -0.13, 1, 0.93, 0.13, 0b110100);
  // plinth
  b.box(-1, 0, -0.11, 1, 0.1, 0.11, 0b110100);
  return b.freeze();
}

function balustradePost() {
  const b = new GeoBuilder(128);
  b.m = M.STONE;
  b.box(-0.14, 0, -0.14, 0.14, 1.02, 0.14, 0b110111);
  b.frustum(0, 1.02, 0, 0.34, 0.2, 0.1, true);
  return b.freeze();
}

// ---------------------------------------------------------------------------
// Arcades

export const COLUMN_H = 2.57;
export const ARCADE_H = COLUMN_H + 1.36;

function column() {
  const b = new GeoBuilder(512);
  b.m = M.STONE;
  b.box(-0.26, 0, -0.26, 0.26, 0.28, 0.26, 0b110111);
  b.lathe([[0.16, 0.28], [0.15, 2.2]], 10);
  b.frustum(0, 2.2, 0, 0.3, 0.52, 0.25, false);
  b.box(-0.29, 2.45, -0.29, 0.29, COLUMN_H, 0.29, 0b110111);
  return b.freeze();
}

function arcadeArch() {
  const b = new GeoBuilder(1024);
  const r = 0.72;
  const outer = [[-1, 0], [-r, 0]];
  for (let s = 1; s < 10; s++) {
    const a = Math.PI - (s / 10) * Math.PI;
    outer.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  outer.push([r, 0], [1, 0], [1, 1.1], [-1, 1.1]);
  b.m = M.STONE;
  b.extrude(outer, [], -0.22, 0.22, { front: true, back: true, sides: true });
  // archivolt moulding on both faces
  const band = [];
  for (let s = 0; s <= 10; s++) {
    const a = (s / 10) * Math.PI;
    band.push([(r + 0.15) * Math.cos(a), (r + 0.15) * Math.sin(a)]);
  }
  for (let s = 10; s >= 0; s--) {
    const a = (s / 10) * Math.PI;
    band.push([r * Math.cos(a), r * Math.sin(a)]);
  }
  b.extrude(band, [], 0.22, 0.28, { front: true, sides: true });
  b.withTransform(T.rotY(Math.PI), () => b.extrude(band, [], 0.22, 0.28, { front: true, sides: true }));
  // entablature
  b.box(-1, 1.1, -0.28, 1, 1.36, 0.28, 0b110100);
  return b.freeze();
}

function parapet() {
  const b = new GeoBuilder(128);
  b.m = M.STONE;
  b.box(-0.8, 0, -0.17, 0.8, 0.55, 0.17, 0b110100);
  b.box(-0.84, 0.55, -0.23, 0.84, 0.64, 0.23, 0b110111);
  return b.freeze();
}

function cornerPier(h = ARCADE_H) {
  const b = new GeoBuilder(256);
  b.m = M.STONE;
  b.box(-0.45, 0, -0.45, 0.45, h, 0.45, 0b110111);
  b.box(-0.52, h, -0.52, 0.52, h + 0.14, 0.52, 0b110111);
  b.frustum(0, h + 0.14, 0, 0.8, 0.62, 0.3, false);
  b.frustum(0, h + 0.44, 0, 0.62, 0.0, 1.5, false);
  return b.freeze();
}

function pinnacle(h) {
  const b = new GeoBuilder(256);
  b.m = M.STONE;
  b.box(-0.38, 0, -0.38, 0.38, h, 0.38, 0b110111);
  b.box(-0.45, h - 0.5, -0.45, 0.45, h - 0.36, 0.45, 0b110111);
  b.box(-0.44, h, -0.44, 0.44, h + 0.12, 0.44, 0b110111);
  b.frustum(0, h + 0.12, 0, 0.6, 0.0, 1.1, false);
  return b.freeze();
}

// Horseshoe arch with alternating red and cream voussoirs.
function stripedArch(span) {
  const b = new GeoBuilder(1024);
  const ri = span / 2 + 0.05;
  const ro = ri + 0.42;
  const hp = 2.3;
  const cy = hp + 0.3;
  const a0 = (-28 * Math.PI) / 180;
  const a1 = Math.PI - a0;
  const n = 13;
  for (let k = 0; k < n; k++) {
    const t0 = a0 + ((a1 - a0) * k) / n;
    const t1 = a0 + ((a1 - a0) * (k + 1)) / n;
    const poly = [];
    const seg = 3;
    for (let s = 0; s <= seg; s++) {
      const t = t0 + ((t1 - t0) * s) / seg;
      poly.push([ro * Math.cos(t), cy + ro * Math.sin(t)]);
    }
    for (let s = seg; s >= 0; s--) {
      const t = t0 + ((t1 - t0) * s) / seg;
      poly.push([ri * Math.cos(t), cy + ri * Math.sin(t)]);
    }
    b.m = k % 2 === 0 ? M.STRIPE : M.CREAM;
    b.extrude(poly, [], -0.3, 0.3, { front: true, back: true, sides: true });
  }
  const px = ri + 0.2;
  const yEnd = cy + ro * Math.sin(a0);
  b.m = M.CREAM;
  for (const s of [-1, 1]) {
    b.box(s * px - 0.26, 0, -0.3, s * px + 0.26, yEnd + 0.05, 0.3, 0b110111);
    b.box(s * px - 0.33, 0, -0.36, s * px + 0.33, 0.3, 0.36, 0b110111);
  }
  return b.freeze();
}

// Tall freestanding pointed arch, like the great gateways on the terraces.
function grandArch(striped) {
  const b = new GeoBuilder(2048);
  const W = 5.0;
  const H = 6.7;
  const ow = 3.1;
  const hs = 3.4;
  const k = 0.82;
  const t = 0.45;
  const inner = pointedArch(ow, hs, k, 8, 0).slice(2); // right springer .. apex .. left springer
  const outline = [[W / 2, 0], [W / 2, H], [-W / 2, H], [-W / 2, 0], [-ow / 2, 0], ...inner.slice().reverse(), [ow / 2, 0]];
  b.m = M.STONE;
  b.extrude(outline, [], -t, t, { front: true, back: true, sides: true });
  b.box(-W / 2 - 0.16, H, -t - 0.14, W / 2 + 0.16, H + 0.32, t + 0.14, 0b110111);
  for (const sg of [-1, 1]) b.box(sg > 0 ? ow / 2 + 0.05 : -W / 2 - 0.1, 0, -t - 0.1, sg > 0 ? W / 2 + 0.1 : -ow / 2 - 0.05, 0.4, t + 0.1, 0b110111);
  // archivolt: a band of voussoirs around the opening on both faces
  const r = k * ow;
  const cx = ow / 2 - r;
  const ta = Math.acos((r - ow / 2) / r);
  const band = 0.42;
  const segs = 7;
  for (const face of [1, -1]) {
    b.withTransform(face > 0 ? T.identity() : T.rotY(Math.PI), () => {
      let n = 0;
      for (const side of [1, -1]) {
        for (let q = 0; q < segs; q++) {
          const a0 = (q / segs) * ta;
          const a1 = ((q + 1) / segs) * ta;
          const P = (a, rr) => [side * (cx + rr * Math.cos(a)), hs + rr * Math.sin(a)];
          const poly = [P(a0, r), P(a0, r + band), P(a1, r + band), P(a1, r)];
          b.m = striped ? ((n++ + (side > 0 ? 0 : 1)) % 2 === 0 ? M.STRIPE : M.CREAM) : M.STONE;
          b.extrude(side > 0 ? poly.slice().reverse() : poly, [], t, t + 0.07, { front: true, sides: true });
        }
      }
    });
  }
  return b.freeze();
}

// ---------------------------------------------------------------------------
// Water features

function fountain() {
  const b = new GeoBuilder(1024);
  b.m = M.STONE;
  b.prism(HEX(1.4), 0, 0.12, { top: true });
  b.prism(HEX(1.32), 0.12, 0.58, { hole: HEX(1.12), top: true });
  b.m = M.WATER;
  b.prism(HEX(1.13), 0.12, 0.44, { top: true, sides: false });
  b.m = M.STONE;
  b.prism(HEX(0.24), 0.4, 1.0, { top: false });
  b.prism(HEX(0.72), 0.95, 1.26, { hole: HEX(0.56), top: true });
  b.m = M.WATER;
  b.prism(HEX(0.57), 1.0, 1.18, { top: true, sides: false });
  b.m = M.STONE;
  b.lathe([[0.1, 1.15], [0.07, 1.4], [0.12, 1.47], [0.05, 1.52]], 8, { capTop: true });
  b.m = M.WHITE;
  b.lathe([[0.07, 1.5], [0.035, 1.85], [0.0, 2.05]], 6);
  return b.freeze();
}

function pool(R) {
  const b = new GeoBuilder(2048);
  b.m = M.STONE;
  b.prism(quatrefoil(R + 0.5, 8), 0, 0.14, { top: true });
  b.prism(quatrefoil(R + 0.25, 8), 0.14, 0.5, { hole: quatrefoil(R, 8), top: true });
  b.m = M.WATER;
  b.prism(quatrefoil(R, 8), 0.14, 0.36, { top: true, sides: false });
  b.m = M.STONE;
  b.prism(HEX(0.3), 0.3, 0.55, { top: true });
  b.m = M.WHITE;
  b.lathe([[0.06, 0.55], [0.03, 0.95], [0.0, 1.15]], 6);
  return b.freeze();
}

// ---------------------------------------------------------------------------
// Plants

function blade(b, base, dirA, elev, len, width, curl, segs = 4, fold = 0.25) {
  // spine from base, heading dirA (around Y) at elevation elev, curling down by curl
  const cd = Math.cos(dirA);
  const sd = Math.sin(dirA);
  const spine = [base];
  for (let s = 1; s <= segs; s++) {
    const e = elev - curl * ((s - 0.5) / segs);
    const st = len / segs;
    const p = spine[s - 1];
    spine.push([p[0] + cd * Math.cos(e) * st, p[1] + Math.sin(e) * st, p[2] + sd * Math.cos(e) * st]);
  }
  const side = [-sd, 0, cd];
  const verts = [];
  for (let s = 0; s <= segs; s++) {
    const p = spine[s];
    const t = s / segs;
    const w = s === segs ? 0 : width * Math.pow(Math.sin(Math.PI * Math.min(0.999, 0.12 + t * 0.88)), 0.8);
    const drop = w * fold;
    verts.push(p, [p[0] + side[0] * w, p[1] - drop, p[2] + side[2] * w], [p[0] - side[0] * w, p[1] - drop, p[2] - side[2] * w]);
  }
  const tris = [];
  for (let s = 0; s < segs; s++) {
    const c0 = s * 3;
    const c1 = c0 + 3;
    tris.push([c0, c1 + 1, c0 + 1], [c0, c1, c1 + 1], [c0, c0 + 2, c1 + 2], [c0, c1 + 2, c1]);
  }
  b.leaf(verts, tris);
}

function agave(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(1024);
  b.m = M.FOLIAGE;
  const n = 11 + Math.floor(rng() * 4);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng() * 0.4;
    const elev = 0.55 + rng() * 0.75;
    const len = 0.55 + rng() * 0.55;
    blade(b, [Math.cos(a) * 0.06, 0.05, Math.sin(a) * 0.06], a, elev, len, 0.07 + rng() * 0.03, 0.35 + rng() * 0.3, 3, 0.35);
  }
  return setSway(b.freeze(), 0, 1.0, 120);
}

function broadleaf(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(2048);
  const n = 5 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng() * 0.5;
    const h = 0.35 + rng() * 0.45;
    const cd = Math.cos(a);
    const sd = Math.sin(a);
    // stalk
    b.m = M.TRUNK;
    blade(b, [0, 0, 0], a, 1.25, h, 0.035, 0.1, 2, 0);
    const tip = [cd * h * Math.cos(1.2), h * Math.sin(1.2), sd * h * Math.cos(1.2)];
    b.m = M.FOLIAGE;
    blade(b, tip, a, 0.55 + rng() * 0.4, 0.8 + rng() * 0.5, 0.2 + rng() * 0.08, 1.2 + rng() * 0.6, 6, 0.3);
  }
  return setSway(b.freeze(), 0, 1.4, 170);
}

function palm(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(4096);
  const H = 3.6 + rng() * 1.4;
  const lean = (rng() - 0.5) * 0.5;
  const la = rng() * Math.PI * 2;
  const segs = 7;
  const ring = 8;
  const centres = [];
  for (let s = 0; s <= segs; s++) {
    const t = s / segs;
    const off = lean * t * t * H * 0.35;
    centres.push([Math.cos(la) * off, t * H, Math.sin(la) * off]);
  }
  b.m = M.TRUNK;
  for (let s = 0; s < segs; s++) {
    const r0 = 0.19 - 0.07 * (s / segs);
    const r1 = 0.19 - 0.07 * ((s + 1) / segs);
    const c0 = centres[s];
    const c1 = centres[s + 1];
    const rows = [
      [c0, r0 * 1.08],
      [[c1[0], c1[1] - 0.02, c1[2]], r1 * 0.92],
    ];
    const vv = rows.map(([c, r]) => {
      const row = [];
      for (let q = 0; q <= ring; q++) {
        const a = (q / ring) * Math.PI * 2;
        row.push(b.vert(c[0] + Math.cos(a) * r, c[1], c[2] + Math.sin(a) * r, Math.cos(a), 0.15, Math.sin(a)));
      }
      return row;
    });
    for (let q = 0; q < ring; q++) {
      b.tri(vv[0][q], vv[1][q + 1], vv[0][q + 1]);
      b.tri(vv[0][q], vv[1][q], vv[1][q + 1]);
    }
  }
  const top = centres[segs];
  // fronds
  b.m = M.FOLIAGE;
  const n = 9 + Math.floor(rng() * 3);
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2 + rng() * 0.3;
    const elev = 0.35 + rng() * 0.55;
    const len = 1.7 + rng() * 0.8;
    frond(b, top, a, elev, len);
  }
  b.m = M.TRUNK;
  b.lathe([[0.16, top[1] - 0.25], [0.2, top[1] - 0.05], [0.08, top[1] + 0.12]], 7, { phase: 0 });
  const tpl = b.freeze();
  return setSway(tpl, H * 0.6, H + 0.8, 255);
}

function frond(b, base, dirA, elev, len) {
  const segs = 8;
  const cd = Math.cos(dirA);
  const sd = Math.sin(dirA);
  const side = [-sd, 0, cd];
  let p = base;
  const spine = [p];
  for (let s = 1; s <= segs; s++) {
    const t = s / segs;
    const e = elev - 2.1 * t * t;
    const st = len / segs;
    p = [p[0] + cd * Math.cos(e) * st, p[1] + Math.sin(e) * st, p[2] + sd * Math.cos(e) * st];
    spine.push(p);
  }
  // vertices: spine, then per segment and side an inner notch and an outer tooth
  const verts = spine.slice();
  const tris = [];
  const width = (t) => 0.42 * Math.sin(Math.PI * Math.min(1, 0.08 + t * 0.95)) + 0.02;
  for (let s = 0; s < segs; s++) {
    const A = spine[s];
    const B = spine[s + 1];
    const w0 = width(s / segs);
    const w1 = width((s + 1) / segs);
    for (const sg of [1, -1]) {
      const oA = verts.length;
      verts.push([A[0] + side[0] * sg * w0 * 0.55, A[1] - w0 * 0.3, A[2] + side[2] * sg * w0 * 0.55]);
      const oB = verts.length;
      verts.push([B[0] + side[0] * sg * w1, B[1] - w1 * 0.45 - 0.04, B[2] + side[2] * sg * w1]);
      tris.push([s, oB, oA], [s, s + 1, oB]);
    }
  }
  b.leaf(verts, tris);
}

// ---------------------------------------------------------------------------
// Figures and objects

function urn(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(512);
  const s = 0.8 + rng() * 0.5;
  b.m = M.STONE;
  b.lathe(
    [[0.13, 0], [0.2, 0.06], [0.29, 0.28], [0.31, 0.46], [0.24, 0.68], [0.12, 0.8], [0.1, 0.9], [0.16, 0.96]].map(([r, y]) => [r * s, y * s]),
    10,
  );
  b.m = M.DARK;
  b.lathe([[0.15 * s, 0.955 * s], [0.0, 0.93 * s]], 10);
  return b.freeze();
}

export function devotee(seed, pose) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(1024);
  const tall = 1.0 + rng() * 0.12;
  if (pose === 'kneel') {
    b.withTransform(T.chain(T.rotX(0.18)), () => {
      b.m = M.ROBE;
      b.lathe([[0.5, 0], [0.48, 0.12], [0.38, 0.55], [0.28, 0.9], [0.24, 1.05], [0.22, 1.2], [0.16, 1.38], [0.05, 1.5], [0.0, 1.52]].map(([r, y]) => [r, y * tall]), 12);
      b.m = M.DARK;
      b.withTransform(T.chain(T.translate(0, 1.12 * tall, 0.2), T.scale(0.15, 0.2, 0.1)), () => b.lathe([[0.0, -1], [0.9, -0.6], [1, 0], [0.9, 0.6], [0, 1]], 8));
    });
    return b.freeze();
  }
  b.m = M.ROBE;
  b.lathe(
    [[0.44, 0], [0.43, 0.08], [0.36, 0.6], [0.29, 1.2], [0.26, 1.45], [0.25, 1.62], [0.24, 1.8], [0.2, 2.0], [0.13, 2.18], [0.04, 2.3], [0.0, 2.32]].map(([r, y]) => [r, y * tall]),
    12,
  );
  b.m = M.GOLD;
  b.lathe([[0.3, 1.08 * tall], [0.31, 1.12 * tall], [0.3, 1.16 * tall]], 12);
  // hood opening with a pale mask inside
  b.m = M.DARK;
  b.withTransform(T.chain(T.translate(0, 1.78 * tall, 0.17), T.scale(0.14, 0.2, 0.1)), () => b.lathe([[0.0, -1], [0.9, -0.6], [1, 0], [0.9, 0.6], [0, 1]], 8));
  b.m = M.MASK;
  b.withTransform(T.chain(T.translate(0, 1.76 * tall, 0.2), T.scale(0.1, 0.14, 0.08)), () => b.lathe([[0.0, -1], [0.9, -0.6], [1, 0], [0.9, 0.6], [0, 1]], 8));
  return b.freeze();
}

function statue(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(4096);
  b.m = M.STONE;
  b.box(-1.05, 0, -1.05, 1.05, 0.22, 1.05, 0b110111);
  b.box(-0.9, 0.22, -0.9, 0.9, 1.35, 0.9, 0b110111);
  b.box(-0.98, 1.35, -0.98, 0.98, 1.5, 0.98, 0b110111);
  // inscription panel on the front
  b.box(-0.7, 0.45, 0.9, 0.7, 1.1, 0.96, 0b010111);
  b.m = M.GLYPH;
  let x = -0.55;
  for (let g = 0; g < 4; g++) {
    glyph(b, x, 0.78, 0.97, 0.22, rng);
    x += 0.37;
  }
  // head
  const hy = 1.5;
  b.withTransform(T.chain(T.translate(0, hy + 0.05, 0), T.rotX(-0.28)), () => {
    b.m = M.GOLD;
    b.lathe(
      [[0.0, 0], [0.32, 0.06], [0.52, 0.3], [0.62, 0.62], [0.63, 0.95], [0.56, 1.3], [0.4, 1.58], [0.18, 1.74], [0.0, 1.78]],
      16,
    );
    // mouth opening
    b.m = M.DARK;
    b.withTransform(T.chain(T.translate(0, 0.42, 0.5), T.rotX(0.5), T.scale(0.26, 0.2, 0.08)), () => b.lathe([[0.0, -1], [0.9, -0.6], [1, 0], [0.9, 0.6], [0, 1]], 10));
    // crest ridge
    b.m = M.GOLD;
    b.box(-0.035, 0.9, 0.45, 0.035, 1.5, 0.62, 0b110111);
  });
  // halo
  b.withTransform(T.translate(0, hy + 1.05, -0.35), () => {
    const outer = circle(1.55, 28);
    const inner = circle(1.36, 28);
    b.m = M.GOLD;
    b.extrude(outer, [inner], -0.08, 0.08, { front: true, back: true, sides: true });
    const teeth = 14;
    for (let k = 0; k < teeth; k++) {
      const a = (k / teeth) * Math.PI * 2;
      const a0 = a - 0.1;
      const a1 = a + 0.1;
      const tri = [
        [1.37 * Math.cos(a0), 1.37 * Math.sin(a0)],
        [1.37 * Math.cos(a1), 1.37 * Math.sin(a1)],
        [1.12 * Math.cos(a), 1.12 * Math.sin(a)],
      ];
      b.extrude(tri, [], -0.05, 0.05, { front: true, back: true, sides: true });
    }
    b.m = M.STONE;
    b.box(-0.08, -1.2, -0.12, 0.08, -0.3, 0.05, 0b110111);
  });
  return b.freeze();
}

function glyph(b, x, y, z, s, rng) {
  // A few chunky strokes: bars, hooks and dots, loosely in the style of the Devotees' script.
  const strokes = 2 + Math.floor(rng() * 3);
  const w = 0.035;
  for (let k = 0; k < strokes; k++) {
    const kind = rng();
    if (kind < 0.45) {
      const vx = rng() < 0.5;
      const ox = (rng() - 0.5) * s * 0.6;
      const oy = (rng() - 0.5) * s * 0.6;
      if (vx) b.box(x + ox - w, y - s / 2, z, x + ox + w, y + s / 2, z + 0.02, 0b010000);
      else b.box(x - s / 2, y + oy - w, z, x + s / 2, y + oy + w, z + 0.02, 0b010000);
    } else if (kind < 0.8) {
      const ox = (rng() < 0.5 ? -1 : 1) * s * 0.3;
      b.box(x - s / 2, y + s / 2 - 2 * w, z, x + s / 2, y + s / 2, z + 0.02, 0b010000);
      b.box(x + ox - w, y - s / 2, z, x + ox + w, y + s / 2, z + 0.02, 0b010000);
    } else {
      const ox = (rng() - 0.5) * s * 0.5;
      b.box(x + ox - 1.5 * w, y - s / 2, z, x + ox + 1.5 * w, y - s / 2 + 3 * w, z + 0.02, 0b010000);
    }
  }
}

function bench() {
  const b = new GeoBuilder(128);
  b.m = M.STONE;
  b.box(-0.75, 0.36, -0.24, 0.75, 0.48, 0.24, 0b110111);
  b.box(-0.62, 0, -0.18, -0.4, 0.36, 0.18, 0b110111);
  b.box(0.4, 0, -0.18, 0.62, 0.36, 0.18, 0b110111);
  return b.freeze();
}

// Domed pavilion (qubba): four pointed arches under a drum and a dome, 4 m
// square, open so one can walk through.
function pavilion() {
  const b = new GeoBuilder(4096);
  const H = 4.1;
  const ow = 2.76;
  const inner = pointedArch(ow, 2.0, 0.62, 8, 0).slice(2);
  const outline = [[2, 0], [2, H], [-2, H], [-2, 0], [-ow / 2, 0], ...inner.slice().reverse(), [ow / 2, 0]];
  b.m = M.STONE;
  b.box(-2.15, 0, -2.15, 2.15, 0.14, 2.15, 0b110111);
  for (let k = 0; k < 4; k++) {
    b.withTransform(T.chain(T.rotY((k * Math.PI) / 2), T.translate(0, 0, 1.7)), () => {
      b.m = M.STONE;
      b.extrude(outline, [], -0.32, 0.32, { front: true, back: true, sides: true });
      // striped voussoirs round the opening, outside face only
      const r = 0.62 * ow;
      const cx = ow / 2 - r;
      const ta = Math.acos((r - ow / 2) / r);
      let n = 0;
      for (const side of [1, -1]) {
        for (let q = 0; q < 5; q++) {
          const a0 = (q / 5) * ta;
          const a1 = ((q + 1) / 5) * ta;
          const P = (a, rr) => [side * (cx + rr * Math.cos(a)), 2.0 + rr * Math.sin(a)];
          const poly = [P(a0, r), P(a0, r + 0.3), P(a1, r + 0.3), P(a1, r)];
          b.m = (n++ + (side > 0 ? 0 : 1)) % 2 === 0 ? M.STRIPE : M.CREAM;
          b.extrude(side > 0 ? poly.slice().reverse() : poly, [], 0.32, 0.38, { front: true, sides: true });
        }
      }
    });
  }
  b.m = M.STONE;
  b.box(-2.18, H, -2.18, 2.18, H + 0.22, 2.18, 0b111111);
  b.m = M.CREAM;
  b.prism(circle(1.55, 8, 0, 0, Math.PI / 8), H + 0.22, H + 0.85, { top: true });
  b.m = M.ROOF;
  b.lathe([[1.45, 0], [1.52, 0.3], [1.4, 0.85], [1.08, 1.35], [0.62, 1.75], [0.18, 2.08], [0.0, 2.18]].map(([r, y]) => [r, y + H + 0.85]), 16);
  b.m = M.GOLD;
  const top = H + 0.85 + 2.1;
  b.lathe([[0.1, top], [0.16, top + 0.2], [0.05, top + 0.45], [0.12, top + 0.62], [0.0, top + 1.05]], 8);
  // a lamp hanging inside, well above head height
  b.lathe([[0.0, 2.55], [0.2, 2.62], [0.24, 2.8], [0.12, 2.95], [0.02, 3.0]], 8);
  b.m = M.DARK;
  b.box(-0.015, 2.95, -0.015, 0.015, H, 0.015, 0b110011);
  return b.freeze();
}

function obelisk(h, seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(2048);
  b.m = M.STONE;
  b.box(-0.75, 0, -0.75, 0.75, 0.4, 0.75, 0b110111);
  b.box(-0.6, 0.4, -0.6, 0.6, 1.35, 0.6, 0b110111);
  b.box(-0.7, 1.35, -0.7, 0.7, 1.52, 0.7, 0b111111);
  for (let k = 0; k < 4; k++) {
    b.withTransform(T.rotY((k * Math.PI) / 2), () => {
      b.m = M.GLYPH;
      glyph(b, -0.22, 0.9, 0.6, 0.26, rng);
      glyph(b, 0.22, 0.9, 0.6, 0.26, rng);
    });
  }
  b.m = M.STONE;
  const shaft = h - 2.4;
  b.frustum(0, 1.52, 0, 0.86, 0.5, shaft, false);
  b.m = M.GOLD;
  b.frustum(0, 1.52 + shaft, 0, 0.5, 0.0, 0.85, false);
  return b.freeze();
}

// Wall spout feeding a canal: origin at the wall foot on quay level, +Z out of
// the wall. The stream falls to the water surface WATER_DROP below.
function spout(drop) {
  const b = new GeoBuilder(1024);
  archFrame(b, 1.2, 1.25, 0.8, 0.14, 0.12, 0.35, M.DARK);
  b.m = M.STONE;
  b.box(-0.8, 0.2, 0, 0.8, 0.35, 0.3, 0b110111);
  // the spout itself: a lip projecting from a boss
  b.box(-0.26, 1.02, 0, 0.26, 1.4, 0.24, 0b110111);
  b.box(-0.14, 1.06, 0.24, 0.14, 1.18, 0.62, 0b111111);
  b.m = M.WHITE;
  b.box(-0.09, -drop, 0.56, 0.09, 1.1, 0.66, 0b110111);
  b.lathe([[0.45, -drop + 0.02], [0.3, -drop + 0.1], [0.0, -drop + 0.12]].map(([r, y]) => [r, y]), 10);
  return b.freeze();
}

// A wall fountain: a dark pointed niche, a mask pouring into a half-round basin.
// Origin at the wall foot, +Z out of the wall.
function wallFountain() {
  const b = new GeoBuilder(2048);
  archFrame(b, 1.3, 1.45, 0.8, 0.14, 0.12, 0.5, M.DARK);
  b.m = M.STONE;
  b.box(-0.22, 1.02, 0, 0.22, 1.4, 0.2, 0b110111);
  b.box(-0.08, 1.07, 0.2, 0.08, 1.17, 0.46, 0b111111);
  const half = (r, z0 = 0) => {
    const pts = [];
    for (let s = 0; s <= 12; s++) {
      const a = (s / 12) * Math.PI;
      pts.push([r * Math.cos(a), z0 + r * Math.sin(a)]);
    }
    return pts;
  };
  b.prism(half(0.86), 0, 0.55, { hole: half(0.72, 0.04), top: true });
  b.m = M.WATER;
  b.prism(half(0.73, 0.04), 0.1, 0.46, { top: true, sides: false });
  b.m = M.WHITE;
  b.box(-0.055, 0.46, 0.37, 0.055, 1.1, 0.47, 0b110111);
  b.lathe([[0.22, 0.465], [0.12, 0.52], [0.0, 0.53]].map(([r, y]) => [r, y]), 8);
  return b.freeze();
}

// A long basin with three jets. Local +X along its length.
function longBasin() {
  const b = new GeoBuilder(2048);
  b.m = M.STONE;
  b.prism(rect(-2.7, -1.3, 2.7, 1.3), 0, 0.12, { top: true });
  b.prism(rect(-2.55, -1.15, 2.55, 1.15), 0.12, 0.5, { hole: rect(-2.35, -0.95, 2.35, 0.95), top: true });
  b.m = M.WATER;
  b.prism(rect(-2.36, -0.96, 2.36, 0.96), 0.12, 0.4, { top: true, sides: false });
  for (const x of [-1.6, 0, 1.6]) {
    b.withTransform(T.translate(x, 0, 0), () => {
      b.m = M.STONE;
      b.prism(HEX(0.18), 0.3, 0.48, { top: true });
      b.m = M.WHITE;
      b.lathe([[0.05, 0.48], [0.025, 0.9], [0.0, 1.05]], 6);
    });
  }
  return b.freeze();
}

// Stylised robed figure in low relief on the XY plane, arms raised to the sun.
function reliefFigure(b, x, y0, h, z0, z1, facing = 0, arms = true) {
  const w = 0.2 * h;
  b.extrude([[x - w, y0], [x + w, y0], [x + w * 0.45, y0 + 0.72 * h], [x - w * 0.45, y0 + 0.72 * h]], [], z0, z1, { front: true, sides: true });
  b.extrude(circle(0.11 * h, 8, x + facing * 0.03 * h, y0 + 0.83 * h), [], z0, z1, { front: true, sides: true });
  if (!arms) return;
  for (const sg of facing ? [facing] : [-1, 1]) {
    const sx = x + sg * w * 0.35;
    const sy = y0 + 0.62 * h;
    const ex = sx + sg * 0.28 * h;
    const ey = sy + 0.3 * h;
    const t = 0.045 * h;
    b.extrude([[sx - t, sy - t], [sx + t, sy - t], [ex + t, ey + t], [ex - t, ey + t]].map(([px, py]) => [px, py]), [], z0, z1 - 0.02, { front: true, sides: true });
  }
}

function sunburst(b, cx, cy, r0, r1, rays, z0, z1, half = false) {
  b.extrude(half ? arcPoly(r0, cx, cy) : circle(r0, 16, cx, cy), [], z0, z1 + 0.02, { front: true, sides: true });
  for (let k = 0; k < rays; k++) {
    const a = half ? ((k + 0.5) / rays) * Math.PI : (k / rays) * Math.PI * 2;
    const da = half ? Math.PI / rays / 2.6 : Math.PI / rays / 1.8;
    const p = (ang, r) => [cx + Math.cos(ang) * r, cy + Math.sin(ang) * r];
    b.extrude([p(a - da, r0 + 0.06), p(a + da, r0 + 0.06), p(a, r1)], [], z0, z1, { front: true, sides: true });
  }
}

function arcPoly(r, cx, cy, segs = 14) {
  const pts = [];
  for (let s = 0; s <= segs; s++) {
    const a = (s / segs) * Math.PI;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

// Carved wall reliefs, 4 m across (two bays). Origin at the wall foot on the
// terrace, +Z out of the wall.
function reliefPanel(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(4096);
  const W = 1.8;
  const y0 = 0.6;
  const y1 = 2.75;
  b.m = M.STONE;
  b.box(-W, y0, 0, W, y1, 0.08, 0b110111);
  b.box(-W - 0.08, y0 - 0.1, 0, W + 0.08, y0 + 0.04, 0.18, 0b110111);
  b.box(-W - 0.08, y1 - 0.04, 0, W + 0.08, y1 + 0.1, 0.18, 0b110111);
  for (const sg of [-1, 1]) b.box(sg > 0 ? W - 0.1 : -W - 0.08, y0, 0, sg > 0 ? W + 0.08 : -W + 0.1, y1, 0.16, 0b110011);
  // the sun with the Devotees' triangle
  b.m = M.CREAM;
  sunburst(b, 0, 1.95, 0.36, 0.66, 12, 0.08, 0.15);
  b.m = M.STONE;
  b.extrude([[-0.2, 1.84], [0.2, 1.84], [0, 2.12]], [[[-0.09, 1.9], [0, 2.04], [0.09, 1.9]]], 0.17, 0.2, { front: true, sides: true });
  // devotees bowing towards it from both sides
  for (const sg of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const x = sg * (0.72 + k * 0.36);
      reliefFigure(b, x, 0.82, 0.95 - k * 0.08, 0.08, 0.15, -sg, k === 0 || rng() < 0.5);
    }
  }
  // inscription along the foot
  b.m = M.GLYPH;
  let x = -1.35;
  for (let g = 0; g < 8; g++) {
    glyph(b, x, y0 + 0.14, 0.18, 0.13, rng);
    x += 0.39;
  }
  return b.freeze();
}

function reliefLunette(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(4096);
  const R = 1.85;
  const cy = 0.75;
  b.m = M.STONE;
  b.extrude(arcPoly(R, 0, cy, 20), [], 0, 0.08, { front: true, sides: true });
  const ring = arcPoly(R + 0.12, 0, cy, 20).concat(arcPoly(R - 0.08, 0, cy, 20).reverse());
  b.extrude(ring, [], 0, 0.17, { front: true, sides: true });
  b.box(-R - 0.2, cy - 0.3, 0, R + 0.2, cy, 0.2, 0b110111);
  b.m = M.CREAM;
  sunburst(b, 0, cy, 0.5, 1.6, 11, 0.08, 0.13, true);
  b.m = M.STONE;
  for (const sg of [-1, 1]) {
    reliefFigure(b, sg * 0.95, cy, 0.95, 0.12, 0.2, -sg, true);
    reliefFigure(b, sg * 1.4, cy, 0.62, 0.12, 0.2, -sg, rng() < 0.6);
  }
  b.m = M.GLYPH;
  let x = -1.2;
  for (let g = 0; g < 7; g++) {
    glyph(b, x, cy - 0.15, 0.2, 0.14, rng);
    x += 0.4;
  }
  return b.freeze();
}

// One 2 m bay of a carved frieze running along a facade (y 0.8 - 2.3 of the
// storey). Neighbouring bays join into one band.
function friezeTile(kind, seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(2048);
  b.m = M.STONE;
  b.box(-1, 0.84, 0, 1, 2.16, 0.06, 0b010100);
  b.box(-1.01, 0.72, 0, 1.01, 0.84, 0.14, 0b011100);
  b.box(-1.01, 2.16, 0, 1.01, 2.3, 0.14, 0b011100);
  if (kind === 0) {
    b.m = M.CREAM;
    sunburst(b, 0, 1.5, 0.26, 0.56, 10, 0.06, 0.12);
  } else if (kind === 1) {
    reliefFigure(b, -0.42, 0.86, 1.0, 0.06, 0.12, 1, true);
    reliefFigure(b, 0.42, 0.86, 1.0, 0.06, 0.12, -1, true);
  } else {
    b.m = M.GLYPH;
    for (const gx of [-0.6, -0.2, 0.2, 0.6]) glyph(b, gx, 1.5, 0.07, 0.26, rng);
  }
  return b.freeze();
}

// A small balcony on corbels in front of a tall door-window.
function balcony(balPanel) {
  const b = new GeoBuilder(4096);
  archFrame(b, 1.0, 1.55, 0.85, 0.1, 0.09, 0.1);
  b.m = M.STONE;
  b.box(-0.88, -0.04, 0, 0.88, 0.12, 0.74, 0b111111);
  for (const x of [-0.6, 0.6]) {
    b.box(x - 0.08, -0.26, 0, x + 0.08, -0.04, 0.6, 0b111111);
    b.box(x - 0.08, -0.55, 0, x + 0.08, -0.26, 0.3, 0b111111);
  }
  b.appendTemplate(balPanel, T.chain(T.translate(0, 0.12, 0.64), T.scale(0.82, 0.85, 1)));
  for (const sg of [-1, 1]) b.appendTemplate(balPanel, T.chain(T.translate(sg * 0.78, 0.12, 0.33), T.rotY(Math.PI / 2), T.scale(0.3, 0.85, 1)));
  return b.freeze();
}

function bollard() {
  const b = new GeoBuilder(256);
  b.m = M.STONE;
  b.lathe([[0.17, 0], [0.18, 0.1], [0.13, 0.22], [0.12, 0.55], [0.18, 0.64], [0.16, 0.74], [0.0, 0.78]], 10);
  return b.freeze();
}

// ---------------------------------------------------------------------------
// Lights, standards and garden pieces that frame an entrance or line an axis

const OCT = (r) => circle(r, 8, 0, 0, Math.PI / 8);

// Sway weights for the vertices of the given materials, growing from y0 to y1.
function swayWhere(tpl, mats, y0, y1, max) {
  for (let i = 0; i < tpl.count; i++) {
    if (!mats.includes(tpl.mat[i * 2])) continue;
    const f = Math.max(0, Math.min(1, (tpl.pos[i * 3 + 1] - y0) / (y1 - y0)));
    tpl.mat[i * 2 + 1] = Math.max(1, Math.round(f * max));
  }
  return tpl;
}

// A small gilded lantern with a flame inside, origin at its foot.
function lantern(b, s = 1) {
  b.withTransform(T.scale(s), () => {
    b.m = M.GOLD;
    b.prism(OCT(0.19), 0, 0.07, { top: true });
    for (let k = 0; k < 4; k++) {
      const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
      b.box(Math.cos(a) * 0.15 - 0.022, 0.07, Math.sin(a) * 0.15 - 0.022, Math.cos(a) * 0.15 + 0.022, 0.42, Math.sin(a) * 0.15 + 0.022, 0b110011);
    }
    b.m = M.FLAME;
    b.prism(OCT(0.11), 0.07, 0.4, { top: false });
    b.m = M.GOLD;
    b.lathe([[0.21, 0.42], [0.2, 0.47], [0.0, 0.7]], 8, { smooth: false, phase: Math.PI / 8 });
    b.lathe([[0.035, 0.68], [0.06, 0.74], [0.0, 0.84]], 6);
  });
}

// Lamp standard: a slender octagonal shaft carrying a lantern, 3.4 m.
function lamp() {
  const b = new GeoBuilder(1024);
  b.m = M.STONE;
  b.box(-0.27, 0, -0.27, 0.27, 0.28, 0.27, 0b110111);
  b.frustum(0, 0.28, 0, 0.42, 0.22, 0.16, false);
  b.prism(OCT(0.085), 0.44, 2.4, { top: false });
  b.lathe([[0.085, 2.3], [0.16, 2.44], [0.17, 2.52]], 8, { capTop: true });
  b.withTransform(T.translate(0, 2.52, 0), () => lantern(b));
  return b.freeze();
}

// Brazier: a fluted pedestal with a gilded bowl of fire, 1.9 m.
function brazier() {
  const b = new GeoBuilder(1024);
  b.m = M.STONE;
  b.box(-0.3, 0, -0.3, 0.3, 0.16, 0.3, 0b110111);
  b.lathe([[0.22, 0.16], [0.15, 0.3], [0.12, 0.72], [0.18, 0.84]], 8, { smooth: false, phase: Math.PI / 8 });
  b.m = M.GOLD;
  b.lathe([[0.14, 0.84], [0.36, 0.9], [0.5, 1.06], [0.52, 1.14], [0.46, 1.14]], 12);
  b.m = M.DARK;
  b.lathe([[0.47, 1.1], [0.0, 1.06]], 12);
  b.m = M.FLAME;
  b.lathe([[0.36, 1.08], [0.33, 1.25], [0.2, 1.5], [0.09, 1.72], [0.0, 1.9]], 7, { smooth: false });
  b.lathe([[0.2, 1.12], [0.14, 1.5], [0.05, 1.82], [0.0, 1.95]], 5, { smooth: false, phase: 0.6 });
  return swayWhere(b.freeze(), [M.FLAME], 1.2, 1.95, 90);
}

// Banner standard: a tall pole with a crimson banner hanging from a crossbar.
function banner(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(2048);
  b.m = M.STONE;
  b.box(-0.3, 0, -0.3, 0.3, 0.3, 0.3, 0b110111);
  b.frustum(0, 0.3, 0, 0.44, 0.2, 0.25, false);
  b.m = M.DARK;
  b.prism(circle(0.055, 6), 0.5, 5.3, { top: false });
  b.box(-0.62, 4.72, -0.035, 0.62, 4.8, 0.035, 0b111111);
  b.m = M.GOLD;
  b.lathe([[0.07, 5.28], [0.12, 5.42], [0.04, 5.62], [0.0, 5.85]], 6);
  for (const sg of [-1, 1]) b.withTransform(T.translate(sg * 0.64, 4.76, 0), () => b.lathe([[0.05, -0.05], [0.06, 0.02], [0.0, 0.08]], 6));
  // the banner, in front of the pole, with a swallowtail foot
  const top = 4.7;
  const bot = 2.1;
  const w = 0.55;
  const tail = [[-w, top], [-w, bot], [0, bot + 0.38], [w, bot], [w, top]];
  b.m = M.STRIPE;
  b.extrude(tail, [], 0.07, 0.1, { front: true, back: true, sides: true });
  b.m = M.CREAM;
  for (const sg of [-1, 1]) b.extrude([[sg * w, top], [sg * (w - 0.08), top], [sg * (w - 0.08), bot + 0.06], [sg * w, bot]].map(([x, y]) => [x, y]), [], 0.065, 0.105, { front: true, back: true, sides: false });
  b.box(-w, top - 0.2, 0.065, w, top - 0.12, 0.105, 0b110011);
  // a golden sun, or the Devotees' triangle
  b.m = M.GOLD;
  if (rng() < 0.5) {
    sunburst(b, 0, 3.75, 0.2, 0.36, 10, 0.1, 0.12);
    b.withTransform(T.rotY(Math.PI), () => sunburst(b, 0, 3.75, 0.2, 0.36, 10, -0.07, -0.05));
  } else {
    const tri = [[-0.3, 3.5], [0.3, 3.5], [0, 4.02]];
    const hole = [[-0.14, 3.6], [0, 3.84], [0.14, 3.6]];
    b.extrude(tri, [hole], 0.1, 0.12, { front: true, sides: true });
    b.extrude(tri, [hole], 0.05, 0.07, { front: false, back: true, sides: true });
  }
  return swayWhere(b.freeze(), [M.STRIPE, M.CREAM, M.GOLD], top - 0.1, bot, 150);
}

// Cypress: a tall dark flame of foliage, planted in a square stone curb.
function cypress(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(2048);
  const H = 4.4 + rng() * 1.3;
  const R = 0.5 + rng() * 0.1;
  b.m = M.STONE;
  b.prism(rect(-0.55, -0.55, 0.55, 0.55), 0, 0.3, { hole: rect(-0.42, -0.42, 0.42, 0.42), top: true });
  b.m = M.SOIL;
  b.prism(rect(-0.43, -0.43, 0.43, 0.43), 0, 0.2, { top: true, sides: false });
  b.m = M.TRUNK;
  b.lathe([[0.1, 0.2], [0.08, 0.6]], 6);
  b.m = M.FOLIAGE;
  const prof = [[0.05, 0.45]];
  const rows = 9;
  for (let k = 1; k <= rows; k++) {
    const t = k / rows;
    const env = Math.sin(Math.PI * Math.min(1, 0.18 + t * 0.9)) ** 0.8 * (1 - 0.35 * t);
    prof.push([R * env * (k % 2 ? 1.0 : 0.84), 0.45 + t * (H - 0.45)]);
  }
  prof.push([0, H + 0.25]);
  b.lathe(prof, 9, { smooth: false, phase: rng() * 6 });
  return setSway(b.freeze(), 1.2, H + 0.3, 70);
}

// Armillary sphere on a pedestal: gilded rings round the sun, 3 m.
function armillary() {
  const b = new GeoBuilder(4096);
  b.m = M.STONE;
  b.box(-0.9, 0, -0.9, 0.9, 0.22, 0.9, 0b110111);
  b.lathe([[0.5, 0.22], [0.36, 0.38], [0.24, 0.5], [0.2, 1.05], [0.34, 1.18], [0.42, 1.3]], 8, { smooth: false, phase: Math.PI / 8, capTop: true });
  const cy = 2.15;
  const R = 0.78;
  const ring = (r, t) => b.extrude(circle(r, 28), [circle(r - t, 28)], -0.03, 0.03, { front: true, back: true, sides: true });
  b.m = M.GOLD;
  // struts up to the horizon ring
  for (let k = 0; k < 4; k++) {
    const a = (k / 4) * Math.PI * 2 + Math.PI / 4;
    const x = Math.cos(a);
    const z = Math.sin(a);
    b.quad([x * 0.3, 1.3, z * 0.3], [x * 0.33, 1.3, z * 0.33], [x * (R + 0.02), cy, z * (R + 0.02)], [x * (R - 0.02), cy, z * (R - 0.02)]);
    b.quad([x * (R - 0.02), cy, z * (R - 0.02)], [x * (R + 0.02), cy, z * (R + 0.02)], [x * 0.33, 1.3, z * 0.33], [x * 0.3, 1.3, z * 0.3]);
  }
  b.withTransform(T.chain(T.translate(0, cy, 0), T.rotX(Math.PI / 2)), () => ring(R + 0.06, 0.07));
  const tilt = 0.62;
  b.withTransform(T.chain(T.translate(0, cy, 0), T.rotZ(tilt)), () => {
    ring(R - 0.04, 0.06); // meridian
    b.withTransform(T.rotX(Math.PI / 2), () => ring(R - 0.1, 0.05)); // equator
    b.withTransform(T.chain(T.rotZ(0.41), T.rotX(Math.PI / 2)), () => {
      ring(R - 0.16, 0.12); // the band of the zodiac
    });
    b.box(-0.02, -R - 0.12, -0.02, 0.02, R + 0.12, 0.02, 0b111111);
  });
  b.withTransform(T.translate(0, cy - 0.16, 0), () => b.lathe([[0.0, 0], [0.12, 0.05], [0.16, 0.16], [0.12, 0.27], [0.0, 0.32]], 10));
  return b.freeze();
}

// Stele: an upright slab with a rounded head, carved on both faces.
function stele(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(2048);
  b.m = M.STONE;
  b.box(-0.55, 0, -0.26, 0.55, 0.22, 0.26, 0b110111);
  const W = 0.4;
  const outline = [[-W, 0.2], [W, 0.2], ...arcPoly(W, 0, 1.55, 10).slice(0)];
  b.extrude(outline, [], -0.12, 0.12, { front: true, back: true, sides: true });
  for (const face of [1, -1]) {
    b.withTransform(face > 0 ? T.identity() : T.rotY(Math.PI), () => {
      b.m = M.CREAM;
      sunburst(b, 0, 1.6, 0.13, 0.26, 8, 0.12, 0.14);
      b.m = M.GLYPH;
      for (let r = 0; r < 3; r++) {
        for (const gx of [-0.17, 0.17]) glyph(b, gx, 1.18 - r * 0.28, 0.12, 0.2, rng);
      }
    });
  }
  return b.freeze();
}

// Chhatri: a small open kiosk of four slender columns under a dome, 1.5 m
// square, open on every side so one can stand in it.
function chhatri() {
  const b = new GeoBuilder(4096);
  const c = 0.62;
  const H = 2.35;
  b.m = M.STONE;
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) {
      b.withTransform(T.translate(sx * c, 0, sz * c), () => {
        b.box(-0.14, 0, -0.14, 0.14, 0.2, 0.14, 0b110111);
        b.prism(OCT(0.075), 0.2, H - 0.18, { top: false });
        b.frustum(0, H - 0.2, 0, 0.16, 0.28, 0.2, false);
      });
    }
  }
  // cusped arches between the columns, with a deep eave above
  for (let k = 0; k < 4; k++) {
    b.withTransform(T.chain(T.rotY((k * Math.PI) / 2), T.translate(0, 0, c)), () => {
      // (the arch springs from the panel's foot: its own springers close the
      // outline there)
      const inner = pointedArch(1.02, H - 0.62, 0.72, 5, 0).slice(2);
      const outline = [[0.76, H - 0.62], [0.76, H + 0.18], [-0.76, H + 0.18], [-0.76, H - 0.62], ...inner.slice().reverse()];
      b.m = M.CREAM;
      b.extrude(outline, [], -0.07, 0.07, { front: true, back: true, sides: true });
    });
  }
  b.m = M.STONE;
  b.box(-c - 0.2, H + 0.18, -c - 0.2, c + 0.2, H + 0.28, c + 0.2, 0b111111);
  b.frustum(0, H + 0.28, 0, 2 * c + 0.56, 2 * c + 0.1, 0.16, true);
  b.m = M.ROOF;
  b.lathe([[0.62, 0], [0.66, 0.16], [0.6, 0.45], [0.44, 0.72], [0.22, 0.92], [0.0, 1.0]].map(([r, y]) => [r, y + H + 0.44]), 12);
  b.m = M.GOLD;
  const top = H + 1.42;
  b.lathe([[0.05, top], [0.09, top + 0.1], [0.03, top + 0.24], [0.0, top + 0.44]], 6);
  // a lamp hanging inside
  b.withTransform(T.translate(0, H - 0.72, 0), () => lantern(b, 0.7));
  b.m = M.DARK;
  b.box(-0.012, H - 0.14, -0.012, 0.012, H + 0.18, 0.012, 0b110011);
  return b.freeze();
}

// Wind catcher (badgir) standing on a roof: a tower with slotted vents at the
// top to take in the breeze. Local X along its long side.
function windcatcher(H) {
  const b = new GeoBuilder(2048);
  const hx = 0.85;
  const hz = 0.55;
  b.m = M.STONE;
  b.box(-hx, -0.2, -hz, hx, H, hz, 0b110111);
  b.box(-hx - 0.1, H * 0.55, -hz - 0.1, hx + 0.1, H * 0.55 + 0.12, hz + 0.1, 0b111111);
  b.box(-hx - 0.08, H, -hz - 0.08, hx + 0.08, H + 0.16, hz + 0.08, 0b111111);
  // crenellations along the top
  for (let x = -hx; x <= hx + 1e-6; x += (2 * hx) / 4) {
    for (const z of [-hz, hz]) b.box(x - 0.09, H + 0.16, z - 0.09, x + 0.09, H + 0.46, z + 0.09, 0b110111);
  }
  b.m = M.DARK;
  const slot = (w, y0, h) => pointedArch(w, y0 + h, 0.8, 3, y0);
  for (const face of [0, 1, 2, 3]) {
    b.withTransform(T.rotY((face * Math.PI) / 2), () => {
      const half = face % 2 === 0 ? hz : hx;
      const along = face % 2 === 0 ? hx : hz;
      const n = face % 2 === 0 ? 3 : 2;
      for (let k = 0; k < n; k++) {
        const x = -along + ((k + 0.5) * 2 * along) / n;
        b.extrude(slot(0.26, H * 0.62, H * 0.22).map(([px, py]) => [px + x, py]), [], half, half + 0.012, { front: true, sides: false });
      }
    });
  }
  return b.freeze();
}

// A portal: a lower doorway than the plain door, with striped voussoirs, a
// cream spandrel in a raised frame (an alfiz) and an inscribed band on top,
// all under the coping of a one-storey wall. Origin at the wall foot, +Z out.
function portal(seed) {
  const rng = makeRng(seed);
  const b = new GeoBuilder(4096);
  const w = 1.2;
  const hs = 1.35;
  const k = 0.75;
  const r = k * w;
  const cx = w / 2 - r;
  const band = 0.16;
  const ta = Math.acos(-cx / r);
  const ta2 = Math.acos(-cx / (r + band));
  const W = 1.3;
  const bw = 0.16;
  const top = 2.42;
  // door leaves
  const opening = pointedArch(w, hs, k, 8, 0);
  const oh = pointedArchHeight(w, hs, k);
  b.m = M.DOOR;
  b.extrude(opening, [], 0, 0.03, { front: true, sides: false, uvScale: [-w / 2, 0, 1 / w, 1 / oh] });
  // jambs and voussoirs
  b.m = M.CREAM;
  for (const sg of [-1, 1]) b.box(sg > 0 ? w / 2 : -w / 2 - band, 0, 0, sg > 0 ? w / 2 + band : -w / 2, hs, 0.16, 0b110111);
  const segs = 5;
  let n = 0;
  for (const side of [1, -1]) {
    for (let q = 0; q < segs; q++) {
      const a0 = (q / segs) * ta;
      const a1 = ((q + 1) / segs) * ta;
      const P = (a, rr) => [side * (cx + rr * Math.cos(a)), hs + rr * Math.sin(a)];
      const poly = [P(a0, r), P(a0, r + band), P(a1, r + band), P(a1, r)];
      b.m = (n++ + (side > 0 ? 0 : 1)) % 2 === 0 ? M.STRIPE : M.CREAM;
      b.extrude(side > 0 ? poly.slice().reverse() : poly, [], 0, 0.16, { front: true, sides: true });
    }
  }
  b.m = M.STRIPE;
  b.box(-0.07, oh - 0.04, 0, 0.07, oh + band + 0.05, 0.18, 0b110111);
  // spandrel between the arch and the frame
  const ring = [];
  for (let q = 0; q <= 8; q++) {
    const a = (q / 8) * ta2;
    ring.push([cx + (r + band) * Math.cos(a), hs + (r + band) * Math.sin(a)]);
  }
  const left = ring.slice(0, -1).map(([x, y]) => [-x, y]); // (the apex once)
  const fill = [[W - bw, 0], [W - bw, top], [-W + bw, top], [-W + bw, 0], [-w / 2 - band, 0], ...left, ...ring.slice().reverse(), [w / 2 + band, 0]];
  b.m = M.CREAM;
  b.extrude(fill, [], 0, 0.04, { front: true, sides: false });
  b.m = M.STONE;
  for (const sg of [-1, 1]) sunburst(b, sg * 0.92, 1.95, 0.07, 0.15, 8, 0.04, 0.07);
  // the frame, the inscribed band and a cornice
  for (const sg of [-1, 1]) b.box(sg > 0 ? W - bw : -W, 0, 0, sg > 0 ? W : -W + bw, 2.6, 0.2, 0b110111);
  b.box(-W + bw, top, 0, W - bw, 2.6, 0.1, 0b010100);
  b.box(-W + bw, top - 0.06, 0, W - bw, top, 0.2, 0b011100);
  b.box(-W - 0.07, 2.6, 0, W + 0.07, 2.66, 0.28, 0b111111);
  b.m = M.GLYPH;
  for (let x = -W + bw + 0.2; x < W - bw - 0.1; x += 0.25) glyph(b, x, 2.51, 0.1, 0.13, rng);
  // threshold
  b.m = M.STONE;
  b.box(-0.9, 0, 0, 0.9, 0.1, 0.45, 0b010111);
  return b.freeze();
}

// Wall lantern on a bracket. Origin on the wall face at its foot, +Z out.
function sconce() {
  const b = new GeoBuilder(1024);
  b.m = M.STONE;
  b.box(-0.12, 2.0, 0, 0.12, 2.36, 0.08, 0b110111);
  b.m = M.DARK;
  b.box(-0.025, 2.26, 0.08, 0.025, 2.31, 0.42, 0b111111);
  b.box(-0.02, 2.02, 0.08, 0.02, 2.29, 0.12, 0b110111);
  b.box(-0.01, 2.08, 0.4, 0.01, 2.27, 0.42, 0b110011);
  b.withTransform(T.translate(0, 1.66, 0.41), () => lantern(b, 0.62));
  return b.freeze();
}

export function buildTemplates() {
  const t = {
    windowSingle: windowSingle(),
    windowTwin: windowTwin(),
    windowTall: windowTall(),
    windowSmall: windowSmall(),
    blindArch: blindArch(),
    door: door(),
    balPanel: balustradePanel(),
    balPost: balustradePost(),
    column: column(),
    arcadeArch: arcadeArch(),
    parapet: parapet(),
    cornerPier: cornerPier(),
    pinnacles: [2.6, 3.2, 3.8, 4.4].map((h) => pinnacle(h)),
    fountain: fountain(),
    pools: { 2.3: pool(2.3), 2.4: pool(2.4) },
    agave: [11, 23, 37, 41, 53].map((s) => agave(s)),
    broadleaf: [7, 19, 29, 31].map((s) => broadleaf(s)),
    palm: [3, 13, 17, 43, 61].map((s) => palm(s)),
    urn: [5, 15, 25].map((s) => urn(s)),
    statue: [8, 9, 10].map((s) => statue(s)),
    bench: bench(),
    grandArch: [grandArch(false), grandArch(true)],
    pavilion: pavilion(),
    obelisks: [6, 7, 8, 9, 10, 11].map((h) => obelisk(h, h * 7 + 1)),
    spout: spout(0.8),
    bollard: bollard(),
    wallFountain: wallFountain(),
    longBasin: longBasin(),
    reliefPanel: [101, 202, 303].map((s) => reliefPanel(s)),
    reliefLunette: [111, 222, 333].map((s) => reliefLunette(s)),
    frieze: [0, 1, 2].map((k) => friezeTile(k, 71 + k)),
    lamp: lamp(),
    brazier: brazier(),
    banner: [5, 6].map((s) => banner(s)),
    cypress: [12, 27, 44].map((s) => cypress(s)),
    armillary: armillary(),
    stele: [31, 32, 33].map((s) => stele(s)),
    chhatri: chhatri(),
    windcatcher: [3.2, 4.0].map((h) => windcatcher(h)),
    portal: [91, 92].map((s) => portal(s)),
    sconce: sconce(),
    stripedArch: new Map(),
  };
  t.balcony = balcony(t.balPanel);
  t.getStripedArch = (span) => {
    const key = Math.round(span * 10);
    if (!t.stripedArch.has(key)) t.stripedArch.set(key, stripedArch(key / 10));
    return t.stripedArch.get(key);
  };
  return t;
}
