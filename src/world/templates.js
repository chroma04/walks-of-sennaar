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

function bollard() {
  const b = new GeoBuilder(256);
  b.m = M.STONE;
  b.lathe([[0.17, 0], [0.18, 0.1], [0.13, 0.22], [0.12, 0.55], [0.18, 0.64], [0.16, 0.74], [0.0, 0.78]], 10);
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
    stripedArch: new Map(),
  };
  t.getStripedArch = (span) => {
    const key = Math.round(span * 10);
    if (!t.stripedArch.has(key)) t.stripedArch.set(key, stripedArch(key / 10));
    return t.stripedArch.get(key);
  };
  return t;
}
