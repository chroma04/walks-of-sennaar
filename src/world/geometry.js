// Minimal geometry toolkit used by the generator. Everything is appended into a
// single growable buffer set (position / normal / uv / material+sway / index) so a
// whole block becomes one draw call.

import { ShapeUtils, Vector2 } from 'three';

class Grow {
  constructor(Type, cap = 4096) {
    this.Type = Type;
    this.a = new Type(cap);
    this.n = 0;
  }
  ensure(k) {
    if (this.n + k <= this.a.length) return;
    let cap = this.a.length * 2;
    while (cap < this.n + k) cap *= 2;
    const b = new this.Type(cap);
    b.set(this.a.subarray(0, this.n));
    this.a = b;
  }
  view() {
    return this.a.slice(0, this.n);
  }
}

// ---------------------------------------------------------------------------
// Affine transforms: [m00 m01 m02 tx  m10 m11 m12 ty  m20 m21 m22 tz]

export const T = {
  identity: () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0],
  translate: (x, y, z) => [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z],
  scale: (x, y = x, z = x) => [x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0],
  rotY: (a) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0];
  },
  rotX: (a) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0];
  },
  rotZ: (a) => {
    const c = Math.cos(a);
    const s = Math.sin(a);
    return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0];
  },
  // y += k * x  (used for sloped balustrades)
  shearYX: (k) => [1, 0, 0, 0, k, 1, 0, 0, 0, 0, 1, 0],
  mul(a, b) {
    const r = new Array(12);
    for (let i = 0; i < 3; i++) {
      const a0 = a[i * 4];
      const a1 = a[i * 4 + 1];
      const a2 = a[i * 4 + 2];
      r[i * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
      r[i * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
      r[i * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
      r[i * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a[i * 4 + 3];
    }
    return r;
  },
  // Compose left-to-right: chain(A, B, C) = A * B * C (C applied first).
  chain(...ms) {
    let r = ms[0];
    for (let i = 1; i < ms.length; i++) r = T.mul(r, ms[i]);
    return r;
  },
  // Inverse-transpose of the linear part, for normals.
  normalMatrix(m) {
    const a = m[0], b = m[1], c = m[2];
    const d = m[4], e = m[5], f = m[6];
    const g = m[8], h = m[9], i = m[10];
    // cofactor matrix == det * inverse-transpose
    return [e * i - f * h, f * g - d * i, d * h - e * g, c * h - b * i, a * i - c * g, b * g - a * h, b * f - c * e, c * d - a * f, a * e - b * d];
  },
};

// ---------------------------------------------------------------------------

export class GeoBuilder {
  constructor(cap = 8192) {
    this.pos = new Grow(Float32Array, cap * 3);
    this.nor = new Grow(Float32Array, cap * 3);
    this.uv = new Grow(Float32Array, cap * 2);
    this.mat = new Grow(Uint8Array, cap * 2);
    this.idx = new Grow(Uint32Array, cap * 3);
    this.vcount = 0;
    this.m = 0; // current material
    this.sway = 0; // current sway weight 0..255
    this.setTransform(T.identity());
  }

  setTransform(t) {
    this.t = t;
    this.nt = T.normalMatrix(t);
    // Reflection flips winding.
    const det = t[0] * (t[5] * t[10] - t[6] * t[9]) - t[1] * (t[4] * t[10] - t[6] * t[8]) + t[2] * (t[4] * t[9] - t[5] * t[8]);
    this.flip = det < 0;
    return this;
  }

  withTransform(t, fn) {
    const prev = this.t;
    this.setTransform(T.mul(prev, t));
    fn();
    this.setTransform(prev);
  }

  vert(x, y, z, nx, ny, nz, u = 0, v = 0) {
    const t = this.t;
    const n = this.nt;
    this.pos.ensure(3);
    this.nor.ensure(3);
    this.uv.ensure(2);
    this.mat.ensure(2);
    const p = this.pos.a;
    let k = this.pos.n;
    p[k] = t[0] * x + t[1] * y + t[2] * z + t[3];
    p[k + 1] = t[4] * x + t[5] * y + t[6] * z + t[7];
    p[k + 2] = t[8] * x + t[9] * y + t[10] * z + t[11];
    this.pos.n += 3;
    let tx = n[0] * nx + n[1] * ny + n[2] * nz;
    let ty = n[3] * nx + n[4] * ny + n[5] * nz;
    let tz = n[6] * nx + n[7] * ny + n[8] * nz;
    const l = Math.hypot(tx, ty, tz) || 1;
    const q = this.nor.a;
    k = this.nor.n;
    q[k] = tx / l;
    q[k + 1] = ty / l;
    q[k + 2] = tz / l;
    this.nor.n += 3;
    const w = this.uv.a;
    w[this.uv.n] = u;
    w[this.uv.n + 1] = v;
    this.uv.n += 2;
    const mm = this.mat.a;
    mm[this.mat.n] = this.m;
    mm[this.mat.n + 1] = this.sway;
    this.mat.n += 2;
    return this.vcount++;
  }

  tri(a, b, c) {
    this.idx.ensure(3);
    const I = this.idx.a;
    const k = this.idx.n;
    if (this.flip) {
      I[k] = a;
      I[k + 1] = c;
      I[k + 2] = b;
    } else {
      I[k] = a;
      I[k + 1] = b;
      I[k + 2] = c;
    }
    this.idx.n += 3;
  }

  // Quad from 4 points in CCW order as seen from the front; flat normal.
  quad(p0, p1, p2, p3, uvs = null) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p3[0] - p0[0], vy = p3[1] - p0[1], vz = p3[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l;
    ny /= l;
    nz /= l;
    const a = this.vert(p0[0], p0[1], p0[2], nx, ny, nz, uvs ? uvs[0] : 0, uvs ? uvs[1] : 0);
    const b = this.vert(p1[0], p1[1], p1[2], nx, ny, nz, uvs ? uvs[2] : 1, uvs ? uvs[3] : 0);
    const c = this.vert(p2[0], p2[1], p2[2], nx, ny, nz, uvs ? uvs[4] : 1, uvs ? uvs[5] : 1);
    const d = this.vert(p3[0], p3[1], p3[2], nx, ny, nz, uvs ? uvs[6] : 0, uvs ? uvs[7] : 1);
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  triangle(p0, p1, p2) {
    const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2];
    const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    const a = this.vert(p0[0], p0[1], p0[2], nx / l, ny / l, nz / l);
    const b = this.vert(p1[0], p1[1], p1[2], nx / l, ny / l, nz / l);
    const c = this.vert(p2[0], p2[1], p2[2], nx / l, ny / l, nz / l);
    this.tri(a, b, c);
  }

  // Axis-aligned box given min/max corners. faces bitmask: +x 1, -x 2, +y 4, -y 8, +z 16, -z 32
  box(x0, y0, z0, x1, y1, z1, faces = 0b110111) {
    if (faces & 4) this.quad([x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]);
    if (faces & 8) this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]);
    if (faces & 1) this.quad([x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]);
    if (faces & 2) this.quad([x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]);
    if (faces & 16) this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]);
    if (faces & 32) this.quad([x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]);
  }

  // Box centred on (cx, cz) with bottom at y0.
  cbox(cx, y0, cz, sx, sy, sz, faces) {
    this.box(cx - sx / 2, y0, cz - sz / 2, cx + sx / 2, y0 + sy, cz + sz / 2, faces);
  }

  // Truncated pyramid (square frustum), centred, bottom size a, top size b.
  frustum(cx, y0, cz, a, b, h, top = true) {
    const A = a / 2;
    const B = b / 2;
    const y1 = y0 + h;
    const P = [
      [cx - A, y0, cz + A], [cx + A, y0, cz + A], [cx + A, y0, cz - A], [cx - A, y0, cz - A],
    ];
    const Q = [
      [cx - B, y1, cz + B], [cx + B, y1, cz + B], [cx + B, y1, cz - B], [cx - B, y1, cz - B],
    ];
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      if (B < 1e-4) this.triangle(P[i], P[j], Q[i]);
      else this.quad(P[i], P[j], Q[j], Q[i]);
    }
    if (top && B > 1e-4) this.quad(Q[0], Q[1], Q[2], Q[3]);
  }

  // Extrude a 2D outline (in XY) along +Z from z0 to z1. outer: CCW, holes: CW
  // (orientation is normalised here). Options select which caps are emitted.
  extrude(outer, holes = [], z0 = 0, z1 = 0.1, opts = {}) {
    const { front = true, back = false, sides = true, uvScale = null, smoothSides = false } = opts;
    const o = ensureOrientation(outer, true);
    const hs = holes.map((h) => ensureOrientation(h, false));
    if (front || back) {
      const contour = o.map((p) => new Vector2(p[0], p[1]));
      const hv = hs.map((h) => h.map((p) => new Vector2(p[0], p[1])));
      const faces = ShapeUtils.triangulateShape(contour, hv);
      const all = o.concat(...hs);
      const uvOf = (p) => (uvScale ? [(p[0] - uvScale[0]) * uvScale[2], (p[1] - uvScale[1]) * uvScale[3]] : [0, 0]);
      for (const cap of [front && 'f', back && 'b']) {
        if (!cap) continue;
        const z = cap === 'f' ? z1 : z0;
        const nz = cap === 'f' ? 1 : -1;
        const base = all.map((p) => {
          const uv = uvOf(p);
          return this.vert(p[0], p[1], z, 0, 0, nz, uv[0], uv[1]);
        });
        for (const f of faces) {
          const a = all[f[0]], b = all[f[1]], c = all[f[2]];
          const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
          const ccw = area > 0;
          if (ccw === (cap === 'f')) this.tri(base[f[0]], base[f[1]], base[f[2]]);
          else this.tri(base[f[0]], base[f[2]], base[f[1]]);
        }
      }
    }
    if (sides) {
      for (const ring of [o, ...hs]) this.extrudeRing(ring, z0, z1, smoothSides);
    }
  }

  extrudeRing(ring, z0, z1, smooth = false) {
    const n = ring.length;
    for (let i = 0; i < n; i++) {
      const a = ring[i];
      const b = ring[(i + 1) % n];
      const dx = b[0] - a[0];
      const dy = b[1] - a[1];
      const l = Math.hypot(dx, dy);
      if (l < 1e-6) continue;
      if (!smooth) {
        this.quad([a[0], a[1], z0], [b[0], b[1], z0], [b[0], b[1], z1], [a[0], a[1], z1]);
      } else {
        const na = ringNormal(ring, i);
        const nb = ringNormal(ring, (i + 1) % n);
        const v0 = this.vert(a[0], a[1], z0, na[0], na[1], 0);
        const v1 = this.vert(b[0], b[1], z0, nb[0], nb[1], 0);
        const v2 = this.vert(b[0], b[1], z1, nb[0], nb[1], 0);
        const v3 = this.vert(a[0], a[1], z1, na[0], na[1], 0);
        this.tri(v0, v1, v2);
        this.tri(v0, v2, v3);
      }
    }
  }

  // Surface of revolution around Y. profile: [[r, y], ...] bottom to top.
  lathe(profile, segs = 12, opts = {}) {
    const { phase = 0, smooth = true, capTop = false } = opts;
    const rows = [];
    for (let k = 0; k < profile.length; k++) {
      const [r, y] = profile[k];
      // profile normal from neighbours
      const pa = profile[Math.max(0, k - 1)];
      const pb = profile[Math.min(profile.length - 1, k + 1)];
      let tr = pb[0] - pa[0];
      let ty = pb[1] - pa[1];
      const l = Math.hypot(tr, ty) || 1;
      tr /= l;
      ty /= l;
      // normal = (ty, -tr) in (r, y)
      const nr = ty;
      const ny = -tr;
      const row = [];
      for (let s = 0; s <= segs; s++) {
        const a = phase + (s / segs) * Math.PI * 2;
        const c = Math.cos(a);
        const sn = Math.sin(a);
        row.push(smooth ? this.vert(r * c, y, r * sn, nr * c, ny, nr * sn) : [r * c, y, r * sn]);
      }
      rows.push(row);
    }
    for (let k = 0; k < rows.length - 1; k++) {
      for (let s = 0; s < segs; s++) {
        if (smooth) {
          const a = rows[k][s], b = rows[k][s + 1], c = rows[k + 1][s + 1], d = rows[k + 1][s];
          this.tri(a, c, b);
          this.tri(a, d, c);
        } else {
          const a = rows[k][s], b = rows[k][s + 1], c = rows[k + 1][s + 1], d = rows[k + 1][s];
          this.quad(a, d, c, b);
        }
      }
    }
    if (capTop) {
      const [r, y] = profile[profile.length - 1];
      if (r > 1e-4) {
        const pts = [];
        for (let s = 0; s < segs; s++) {
          const a = phase + (s / segs) * Math.PI * 2;
          pts.push([r * Math.cos(a), r * Math.sin(a)]);
        }
        const c = this.vert(0, y, 0, 0, 1, 0);
        const vs = pts.map((p) => this.vert(p[0], y, p[1], 0, 1, 0));
        for (let s = 0; s < segs; s++) this.tri(c, vs[(s + 1) % segs], vs[s]);
      }
    }
  }

  // Vertical prism from a polygon in XZ (CCW seen from above), with optional hole.
  prism(poly, y0, y1, opts = {}) {
    const { top = true, sides = true, hole = null } = opts;
    // Map XZ outline into the XY extrusion frame: x -> x, y -> -z, extrude along +Z -> +Y
    const toXY = (p) => [p[0], -p[1]];
    const o = poly.map(toXY);
    const hs = hole ? [hole.map(toXY)] : [];
    this.withTransform(T.chain(T.translate(0, y0, 0), T.rotX(-Math.PI / 2)), () => {
      this.extrude(o, hs, 0, y1 - y0, { front: top, back: false, sides });
    });
  }

  // Double-sided thin surface: shared vertices with smooth normals oriented
  // towards +Y, emitted once per side.
  leaf(verts, tris) {
    const nrm = verts.map(() => [0, 0, 0]);
    for (const [a, b, c] of tris) {
      const p = verts[a], q = verts[b], r = verts[c];
      const ux = q[0] - p[0], uy = q[1] - p[1], uz = q[2] - p[2];
      const vx = r[0] - p[0], vy = r[1] - p[1], vz = r[2] - p[2];
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      if (ny < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      for (const k of [a, b, c]) {
        nrm[k][0] += nx;
        nrm[k][1] += ny;
        nrm[k][2] += nz;
      }
    }
    for (const side of [1, -1]) {
      const base = verts.map((v, k) => {
        const n = nrm[k];
        const l = Math.hypot(n[0], n[1], n[2]) || 1;
        return this.vert(v[0], v[1], v[2], (side * n[0]) / l, (side * n[1]) / l, (side * n[2]) / l);
      });
      for (const [a, b, c] of tris) {
        const p = verts[a], q = verts[b], r = verts[c];
        const ny = (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]);
        const up = ny >= 0;
        if (up === (side > 0)) this.tri(base[a], base[b], base[c]);
        else this.tri(base[a], base[c], base[b]);
      }
    }
  }

  appendTemplate(tpl, t = null, matMap = null) {
    const prev = this.t;
    const tt = t ? T.mul(prev, t) : prev;
    this.setTransform(tt);
    const base = this.vcount;
    const p = tpl.pos, n = tpl.nor, uv = tpl.uv, m = tpl.mat;
    const savedM = this.m;
    const savedS = this.sway;
    for (let i = 0; i < tpl.count; i++) {
      this.m = matMap ? matMap(m[i * 2]) : m[i * 2];
      this.sway = m[i * 2 + 1] || savedS;
      this.vert(p[i * 3], p[i * 3 + 1], p[i * 3 + 2], n[i * 3], n[i * 3 + 1], n[i * 3 + 2], uv[i * 2], uv[i * 2 + 1]);
    }
    const I = tpl.idx;
    for (let i = 0; i < I.length; i += 3) this.tri(base + I[i], base + I[i + 1], base + I[i + 2]);
    this.m = savedM;
    this.sway = savedS;
    this.setTransform(prev);
  }

  freeze() {
    return {
      pos: this.pos.view(),
      nor: this.nor.view(),
      uv: this.uv.view(),
      mat: this.mat.view(),
      idx: this.idx.view(),
      count: this.vcount,
    };
  }
}

function signedArea(poly) {
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % poly.length];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function ensureOrientation(poly, ccw) {
  const isCcw = signedArea(poly) > 0;
  return isCcw === ccw ? poly : poly.slice().reverse();
}

function ringNormal(ring, i) {
  const n = ring.length;
  const a = ring[(i - 1 + n) % n];
  const b = ring[(i + 1) % n];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = Math.hypot(dx, dy) || 1;
  return [dy / l, -dx / l];
}

// ---------------------------------------------------------------------------
// 2D outline helpers (XY plane, y up)

// Pointed (gothic) arch outline, width w, springing at hs. k = radius / width.
export function pointedArch(w, hs, k = 0.85, segs = 5, y0 = 0) {
  const r = k * w;
  const cxR = w / 2 - r; // centre of right-hand arc
  const cosA = (r - w / 2) / r;
  const ta = Math.acos(Math.max(-1, Math.min(1, cosA)));
  const pts = [[-w / 2, y0], [w / 2, y0]];
  for (let s = 0; s <= segs; s++) {
    const t = (s / segs) * ta;
    pts.push([cxR + r * Math.cos(t), hs + r * Math.sin(t)]);
  }
  for (let s = segs - 1; s >= 0; s--) {
    const t = (s / segs) * ta;
    pts.push([-(cxR + r * Math.cos(t)), hs + r * Math.sin(t)]);
  }
  return dedupe(pts);
}

export function pointedArchHeight(w, hs, k = 0.85) {
  const r = k * w;
  const c = r - w / 2;
  return hs + Math.sqrt(r * r - c * c);
}

export function roundArch(w, hs, segs = 8, y0 = 0) {
  const r = w / 2;
  const pts = [[-r, y0], [r, y0]];
  for (let s = 0; s <= segs; s++) {
    const t = (s / segs) * Math.PI;
    pts.push([r * Math.cos(t), hs + r * Math.sin(t)]);
  }
  return dedupe(pts);
}

export function circle(r, segs = 12, cx = 0, cy = 0, phase = 0) {
  const pts = [];
  for (let s = 0; s < segs; s++) {
    const a = phase + (s / segs) * Math.PI * 2;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

export function rect(x0, y0, x1, y1) {
  return [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
}

// Quatrefoil outline (four lobes) centred at origin.
export function quatrefoil(R, segsPerLobe = 7) {
  // four semicircular lobes of radius r centred at distance c on the axes
  const r = R * 0.5;
  const c = R * 0.5;
  const pts = [];
  for (let k = 0; k < 4; k++) {
    const base = (k * Math.PI) / 2;
    const cx = c * Math.cos(base);
    const cy = c * Math.sin(base);
    for (let s = 0; s <= segsPerLobe; s++) {
      const a = base - Math.PI / 2 + (s / segsPerLobe) * Math.PI;
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
    }
  }
  return dedupe(pts);
}

function dedupe(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-5) out.push(p);
  }
  const f = out[0];
  const l = out[out.length - 1];
  if (out.length > 2 && Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-5) out.pop();
  return out;
}

export function offsetPoly(poly, d) {
  // naive vertex offset along averaged normals (fine for convex-ish outlines)
  const n = poly.length;
  const o = ensureOrientation(poly, true);
  return o.map((p, i) => {
    const a = o[(i - 1 + n) % n];
    const b = o[(i + 1) % n];
    const e1 = norm2([p[0] - a[0], p[1] - a[1]]);
    const e2 = norm2([b[0] - p[0], b[1] - p[1]]);
    const n1 = [e1[1], -e1[0]];
    const n2 = [e2[1], -e2[0]];
    const m = norm2([n1[0] + n2[0], n1[1] + n2[1]]);
    const cosH = m[0] * n1[0] + m[1] * n1[1];
    const s = d / Math.max(0.35, cosH);
    return [p[0] + m[0] * s, p[1] + m[1] * s];
  });
}

function norm2(v) {
  const l = Math.hypot(v[0], v[1]) || 1;
  return [v[0] / l, v[1] / l];
}
