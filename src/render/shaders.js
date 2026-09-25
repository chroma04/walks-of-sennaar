// GLSL for the stylised look: two-tone cel lighting with cast shadows, etched
// hatching, a yellow -> orange -> magenta gradient with depth below the traveller,
// and ink outlines in a post pass.

import { MATERIAL_COUNT } from '../config.js';

export const worldVertex = /* glsl */ `
in vec2 aMat;
uniform float uTime;
out vec3 vWorld;
// centroid: with multisampling, edge pixels would otherwise read a position in
// the next cell over, and the water's cell-local foam would leak across
centroid out vec3 vLocal;
out vec3 vNormal;
out vec2 vUv;
flat out int vMat;
out float vViewZ;

void main() {
#ifdef USE_INSTANCING
  mat4 mm = modelMatrix * instanceMatrix;
#else
  mat4 mm = modelMatrix;
#endif
  vec4 wp = mm * vec4(position, 1.0);
  float sw = aMat.y / 255.0;
  if (sw > 0.0) {
    float ph = wp.x * 0.37 + wp.z * 0.29;
    float g = 0.6 + 0.4 * sin(uTime * 0.31 + wp.x * 0.05);
    wp.x += sw * 0.085 * g * sin(uTime * 1.3 + ph);
    wp.z += sw * 0.07 * g * sin(uTime * 1.07 + ph * 1.3 + 1.7);
    wp.y += sw * 0.03 * sin(uTime * 1.7 + ph);
  }
  vWorld = wp.xyz;
  vLocal = position;
  vNormal = normalize(mat3(mm) * normal);
  vUv = uv;
  vMat = int(aMat.x + 0.5);
  vec4 mv = viewMatrix * wp;
  vViewZ = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const worldFragment = /* glsl */ `
precision highp float;
precision highp int;
layout(location = 0) out vec4 outColor;
layout(location = 1) out vec4 outNormal;

uniform vec3 uPalette[${MATERIAL_COUNT * 2}];
uniform vec3 uWallLit;
uniform vec3 uWallShade;
uniform vec3 uSunDir;
uniform sampler2D uShadowMap;
uniform mat4 uShadowMatrix;
uniform vec2 uShadowTexel;
uniform sampler2D uDynShadowMap;
uniform mat4 uDynShadowMatrix;
uniform vec2 uDynShadowTexel;
uniform sampler2D uNpcShadowMap;
uniform float uFocusY;
uniform float uTime;
uniform vec4 uCut;      // player NDC xy, player view depth, radius (NDC y units)
uniform float uCutY;    // player feet height
uniform vec2 uResolution;
uniform vec3 uDepthA;
uniform vec3 uDepthB;
uniform vec3 uFog;
uniform vec2 uFogRange;

in vec3 vWorld;
centroid in vec3 vLocal;
in vec3 vNormal;
in vec2 vUv;
flat in int vMat;
in float vViewZ;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

float shadowTap(sampler2D map, vec2 texel, vec3 c) {
  if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  // bilinear-weighted 2x2 comparisons over a 3x3 footprint
  vec2 f = fract(c.xy / texel - 0.5);
  vec2 b = (floor(c.xy / texel - 0.5) + 0.5) * texel;
  float s[16];
  for (int y = 0; y < 4; y++) {
    for (int x = 0; x < 4; x++) {
      float d = texture(map, b + vec2(float(x) - 1.0, float(y) - 1.0) * texel).r;
      s[y * 4 + x] = c.z - 0.0006 <= d ? 1.0 : 0.0;
    }
  }
  float acc = 0.0;
  for (int y = 0; y < 3; y++) {
    for (int x = 0; x < 3; x++) {
      float a = mix(s[y * 4 + x], s[y * 4 + x + 1], f.x);
      float bb = mix(s[(y + 1) * 4 + x], s[(y + 1) * 4 + x + 1], f.x);
      acc += mix(a, bb, f.y);
    }
  }
  return acc / 9.0;
}

// cheaper 2x2 version for the devotees' map
float shadowTap4(sampler2D map, vec2 texel, vec3 c) {
  if (c.x < 0.0 || c.y < 0.0 || c.x > 1.0 || c.y > 1.0 || c.z > 1.0) return 1.0;
  vec2 f = fract(c.xy / texel - 0.5);
  vec2 b = (floor(c.xy / texel - 0.5) + 0.5) * texel;
  float s00 = c.z - 0.0006 <= texture(map, b).r ? 1.0 : 0.0;
  float s10 = c.z - 0.0006 <= texture(map, b + vec2(texel.x, 0.0)).r ? 1.0 : 0.0;
  float s01 = c.z - 0.0006 <= texture(map, b + vec2(0.0, texel.y)).r ? 1.0 : 0.0;
  float s11 = c.z - 0.0006 <= texture(map, b + texel).r ? 1.0 : 0.0;
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

float hash12(vec2 p) {
  vec3 q = fract(vec3(p.xyx) * 0.1031);
  q += dot(q, q.yzx + 33.33);
  return fract((q.x + q.y) * q.z);
}

// Distance from a point in a cell (0..2 m each way) to the cell sides and
// corners flagged in mask (see waterEdges in the mesher).
float edgeDist(vec2 q, int mask) {
  float d = 9.0;
  if ((mask & 1) != 0) d = min(d, 2.0 - q.x);
  if ((mask & 2) != 0) d = min(d, 2.0 - q.y);
  if ((mask & 4) != 0) d = min(d, q.x);
  if ((mask & 8) != 0) d = min(d, q.y);
  if ((mask & 16) != 0) d = min(d, length(q - vec2(2.0, 2.0)));
  if ((mask & 32) != 0) d = min(d, length(q - vec2(0.0, 2.0)));
  if ((mask & 64) != 0) d = min(d, length(q));
  if ((mask & 128) != 0) d = min(d, length(q - vec2(2.0, 0.0)));
  return d;
}

// Thin bright lines of sunlight focused through the ripples.
float caustics(vec2 p, float t) {
  vec2 a = p * 0.8;
  float u = a.x * 2.1 + sin(a.y * 1.7 + t * 0.7) * 1.3 + sin(a.y * 3.1 - t * 0.4) * 0.4 + t * 0.3;
  float v = a.y * 1.9 + sin(a.x * 1.5 - t * 0.6) * 1.3 + sin(a.x * 2.9 + t * 0.5) * 0.4 - t * 0.25;
  float lu = 1.0 - smoothstep(0.0, 0.16, abs(sin(u)));
  float lv = 1.0 - smoothstep(0.0, 0.16, abs(sin(v)));
  return max(lu, lv) * 0.35 + lu * lv * 0.9;
}

// Small cells of glitter that wink in and out; density in 0..1.
float glitter(vec2 p, float scale, float density, float t, float size) {
  vec2 g = p * scale;
  vec2 c = floor(g);
  float r = hash12(c);
  vec2 jit = vec2(hash12(c + 17.3), hash12(c + 41.9));
  float d = length(fract(g) - 0.2 - 0.6 * jit);
  float tw = 0.35 + 0.65 * max(0.0, sin(t * (1.6 + 2.4 * r) + r * 37.0));
  return step(r, density) * (1.0 - smoothstep(size * tw * 0.7, size * tw, d));
}

float hatchLines(vec3 p, vec3 n, float spacing, float width) {
  vec3 an = abs(n);
  vec2 q = an.y > 0.6 ? p.xz : (an.x > an.z ? vec2(p.z, p.y) : vec2(p.x, p.y));
  float u = (q.x + q.y) / spacing;
  float fw = fwidth(u);
  float d = abs(fract(u) - 0.5);
  float line = 1.0 - smoothstep(width - fw, width + fw, d);
  return line * (1.0 - smoothstep(0.16, 0.34, fw));
}

void main() {
  vec3 N = normalize(vNormal);
  int m = vMat;

  // cut a window through geometry that hides the traveller (but never through
  // the traveller, whose head is nearer the camera than its feet)
#ifndef NO_CUT
  if (uCut.w > 0.0) {
    vec2 ndc = gl_FragCoord.xy / uResolution * 2.0 - 1.0;
    vec2 dd = (ndc - uCut.xy) * vec2(uResolution.x / uResolution.y, 0.75);
    if (vViewZ < uCut.z - 1.0 && vWorld.y > uCutY + 0.7 && length(dd) < uCut.w) discard;
  }
#endif

  float ndl = dot(N, uSunDir);
  vec3 sp = vWorld + N * 0.07 + uSunDir * 0.03;
  vec4 sc = uShadowMatrix * vec4(sp, 1.0);
  float sh = shadowTap(uShadowMap, uShadowTexel, sc.xyz);
  vec4 dc = uDynShadowMatrix * vec4(sp, 1.0);
  sh = min(sh, shadowTap(uDynShadowMap, uDynShadowTexel, dc.xyz));
  sh = min(sh, shadowTap4(uNpcShadowMap, uShadowTexel, sc.xyz));
  sh = smoothstep(0.25, 0.75, sh);
  float light = smoothstep(0.02, 0.16, ndl) * sh;

  vec3 lit = uPalette[m * 2];
  vec3 shade = uPalette[m * 2 + 1];
  bool vertical = N.y < 0.6;
  if (m == 0 && vertical) {
    lit = uWallLit;
    shade = uWallShade;
  }
  // shadowed planes facing different ways read slightly differently
  float facing = dot(normalize(N.xz + 1e-4), normalize(vec2(0.62, 0.78)));
  if (vertical) shade *= mix(0.9, 1.05, facing * 0.5 + 0.5);
  vec3 col = mix(shade, lit, light);

  // what should bloom in the post pass (foam, jets)
  float glow = 0.0;

  // material details
  if (m == 2) {
    // window: glazing bars and a darker interior towards the top
    float bar = step(abs(vUv.x - 0.5), 0.035);
    float tv = abs(fract(vUv.y * 3.2) - 0.5);
    bar = max(bar, step(0.455, tv) * step(vUv.y, 0.75));
    col *= mix(1.0, 0.78, smoothstep(0.1, 1.0, vUv.y));
    col = mix(col, mix(uWallShade, uWallLit, light) * 0.95, bar);
  } else if (m == 3) {
    // door leaves: split, planks, two red diamonds
    float split = step(abs(vUv.x - 0.5), 0.012);
    float plank = step(0.48, abs(fract(vUv.x * 7.0) - 0.5)) * 0.07;
    col *= 1.0 - plank;
    float d1 = abs(vUv.x - 0.32) / 0.075 + abs(vUv.y - 0.5) / 0.055;
    float d2 = abs(vUv.x - 0.68) / 0.075 + abs(vUv.y - 0.5) / 0.055;
    float dia = step(min(d1, d2), 1.0);
    col = mix(col, mix(uPalette[15], uPalette[14], light), dia);
    col = mix(col, vec3(0.2, 0.08, 0.07), split);
  } else if (m == 5) {
    // basin water: caustics and a few glints
    col = mix(shade, lit, 0.3 + 0.7 * sh);
    col += vec3(0.1, 0.12, 0.06) * caustics(vWorld.xz * 2.0, uTime) * sh;
    col = mix(col, vec3(1.0), glitter(vWorld.xz, 5.0, 0.12, uTime, 0.16) * (0.4 + 0.6 * sh));
  } else if (m == 19) {
    // canal water. Broken, glowing foam where it laps against stone, flecks
    // drifting off it, pale shallows over the submerged footings, sunlight
    // caught in caustics, and churning white where a higher reach pours in.
    vec2 q = mod(vLocal.xz, 2.0);
    float dw = edgeDist(q, int(vUv.x * 255.0 + 0.5));
    float dp = edgeDist(q, int(vUv.y * 255.0 + 0.5));
    vec2 wp = vWorld.xz;
    float t = uTime;
    col = mix(shade, lit, 0.22 + 0.78 * sh);
    col *= mix(1.0, 0.86, smoothstep(0.5, 2.2, dw));
    float shallow = 1.0 - smoothstep(0.2, 0.95, dw + 0.08 * sin(wp.x * 2.3 + wp.y * 1.9 + t * 0.8));
    col = mix(col, col * 1.12 + vec3(0.07, 0.09, 0.03), shallow * 0.75);
    col += vec3(0.12, 0.14, 0.06) * caustics(wp, t) * sh * (0.55 + 0.45 * smoothstep(0.3, 1.2, dw));
    // lapping edge: a jagged line that breathes in and out
    float lap = sin(wp.x * 4.3 + t * 1.9) * sin(wp.y * 3.9 - t * 1.5) * 0.055 + sin((wp.x + wp.y) * 9.5 - t * 2.6) * 0.03 + sin((wp.x - wp.y) * 13.0 + t * 3.3) * 0.02;
    float e = dw + lap;
    // (the cell-local distance wraps at cell borders: take the footprint from
    // the unwrapped position instead)
    float fwE = max(length(fwidth(vLocal.xz)), 0.004);
    float foam = 1.0 - smoothstep(0.17, 0.17 + fwE * 1.5, e);
    // a second, broken line just off the first
    float lap2 = sin(wp.x * 5.7 - t * 2.3) * sin(wp.y * 6.1 + t * 1.8);
    foam = max(foam, (1.0 - smoothstep(0.035, 0.035 + fwE, abs(e - 0.3))) * step(0.25, lap2));
    // flecks thin out away from the stone
    float near = 1.0 - smoothstep(0.15, 1.0, dw);
    foam = max(foam, glitter(wp + vec2(t * 0.05, -t * 0.04), 7.0, 0.9 * near, t, 0.2));
    foam = max(foam, glitter(wp, 3.5, 0.3 * near, t * 0.7, 0.14));
    // the churn below a weir
    float churn = 1.0 - smoothstep(0.1, 1.5, dp + 0.3 * sin(wp.x * 3.1 - t * 2.2) * sin(wp.y * 2.7 + t * 1.7));
    float froth = sin(wp.x * 11.0 + t * 3.1 + sin(wp.y * 7.0)) * sin(wp.y * 12.0 - t * 2.9 + sin(wp.x * 6.0)) + 0.5 * sin((wp.x + wp.y) * 9.0 - t * 4.1);
    foam = max(foam, step(1.0 - 1.7 * churn, froth * 0.5 + 0.5) * step(0.05, churn));
    foam = max(foam, glitter(wp + vec2(0.0, t * 0.3), 6.0, churn, t * 1.3, 0.22));
    // glints of sun on the open water
    float glint = glitter(wp - vec2(t * 0.03, 0.0), 4.0, 0.08 * sh, t * 1.4, 0.13);
    col = mix(col, vec3(1.0, 1.0, 0.94), glint * 0.85);
    col = mix(col, mix(uPalette[35], uPalette[34], 0.6 + 0.4 * sh), foam);
    glow = foam;
  } else if (m == 8) {
    // gold: hard specular band
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 H = normalize(uSunDir + V);
    float spec = step(0.9, pow(max(dot(N, H), 0.0), 8.0)) * sh;
    col = mix(col, vec3(1.0, 0.97, 0.82), spec * 0.85);
  } else if (m == 11) {
    col = vec3(1.0, 0.98, 0.93) * (0.94 + 0.06 * sin(uTime * 9.0 + vWorld.y * 6.0));
    glow = 0.7;
  } else if (m == 20) {
    // flame: hot at the core, flickering, lit from within
    float fl = 0.5 + 0.5 * sin(uTime * 11.0 + vWorld.x * 3.1 + vWorld.z * 2.3) * sin(uTime * 7.3 + vWorld.y * 5.0);
    col = mix(shade, lit, 0.15 + 0.35 * fl + 0.45 * max(N.y, 0.0));
    glow = 0.14 + 0.12 * fl;
  } else if (m == 17) {
    // foam: a broken, glittering line where water meets stone
    float f1 = sin(vWorld.x * 11.0 + uTime * 3.1 + sin(vWorld.z * 7.0)) * sin(vWorld.z * 12.0 - uTime * 2.9 + sin(vWorld.x * 6.0));
    float f2 = sin((vWorld.x + vWorld.z) * 9.0 - uTime * 4.1);
    if (f1 + 0.5 * f2 < -0.35) discard;
    col = mix(shade, lit, 0.55 + 0.45 * sh);
    glow = 1.0;
  } else if (m == 18) {
    // falling water: pale streaks sliding down the sheet, in columns across it
    float across = abs(N.x) > abs(N.z) ? vWorld.z : vWorld.x;
    float colm = floor(across * 9.0);
    float rnd = fract(sin(colm * 91.7) * 43758.5453);
    float streak = step(0.25 + 0.5 * rnd, fract(vWorld.y * 0.3 + uTime * (0.9 + rnd) + rnd * 7.0));
    streak *= step(0.3, fract(across * 9.0 + rnd));
    col = mix(mix(shade, lit, 0.35), lit, streak);
    glow = streak * 0.3;
  } else if (m == 1) {
    // roof tiles: stripes running down the slope
    vec3 t = normalize(cross(N, vec3(0.0, 1.0, 0.0)) + 1e-4);
    float u = dot(vLocal, t) / 0.34;
    float stripe = smoothstep(0.42, 0.5, abs(fract(u) - 0.5));
    col *= 1.0 - stripe * 0.13;
  } else if (m == 12) {
    col *= 0.9;
  } else if (m == 6) {
    // lawn: short strokes of grass
    vec2 g = vLocal.xz * vec2(9.0, 3.0);
    vec2 cell = floor(g);
    float rnd = fract(sin(dot(cell, vec2(12.9898, 78.233))) * 43758.5453);
    float blade = step(0.62, rnd) * (1.0 - smoothstep(0.08, 0.22, abs(fract(g.x) - 0.5)));
    col *= 1.0 - blade * 0.16;
  }

  // etched hatching, heavier in shade
  bool wet = m == 5 || m == 17 || m == 18 || m == 19;
  bool flatLit = m == 11 || m == 20 || wet;
  if (!flatLit) {
    float amt = (1.0 - light) * 0.2 + (vertical ? 0.035 : 0.0);
    float h = hatchLines(vLocal, N, 0.1, 0.13);
    col = mix(col, col * vec3(0.8, 0.6, 0.62), h * amt * 3.0);
  }

  // depth gradient: yellow -> orange -> magenta below the traveller
  float df = clamp((uFocusY - vWorld.y - 0.6) / 12.0, 0.0, 1.0);
  float L = luma(col);
  vec3 tA = uDepthA * (0.55 + 0.6 * L);
  vec3 tB = uDepthB * (0.5 + 0.7 * L);
  if (wet) {
    // water keeps its teal far below, only deepening, so the channels still
    // read against the warm stone
    col *= mix(vec3(1.0), vec3(0.78, 0.84, 0.95), smoothstep(0.0, 1.0, df));
    col = mix(col, tB * (0.5 + 0.7 * L), smoothstep(0.4, 1.0, df) * 0.16);
  } else {
    col = mix(col, tA, smoothstep(0.0, 0.55, df) * 0.6);
    col = mix(col, tB, smoothstep(0.3, 1.0, df) * 0.88);
  }

  // far haze
  col = mix(col, uFog, smoothstep(uFogRange.x, uFogRange.y, vViewZ));

  // alpha carries the bloom mask to the post pass (1 = none)
  glow *= 1.0 - smoothstep(uFogRange.x * 0.6, uFogRange.y, vViewZ);
  outColor = vec4(col, 1.0 - clamp(glow, 0.0, 1.0));
  vec3 vn = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  // jets of water are drawn as faceted tubes: no ink creases along them
  if (m == 11) vn = vec3(0.0, 0.0, 1.0);
  // foam reads as part of the water: no ink line between them
  float mid = m == 17 ? 5.0 : float(m);
  outNormal = vec4(vn * 0.5 + 0.5, (mid + 0.5) / 32.0);
}
`;

export const depthVertex = /* glsl */ `
void main() {
#ifdef USE_INSTANCING
  gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
#else
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
#endif
}
`;

export const depthFragment = /* glsl */ `
void main() {
  gl_FragColor = vec4(1.0);
}
`;

export const fullscreenVertex = /* glsl */ `
out vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const compositeFragment = /* glsl */ `
precision highp float;
layout(location = 0) out vec4 outColor;
in vec2 vUv;
uniform sampler2D tColor;
uniform sampler2D tNormal;
uniform sampler2D tDepth;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uLine;
uniform vec3 uInk;
uniform vec3 uSkyTop;
uniform vec3 uSkyBottom;
uniform float uTime;
uniform vec4 uCut;      // as in the world pass
uniform vec2 uResolution;

float viewZ(float d) {
  float z = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - z * (uFar - uNear));
}

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec2 o = uTexel * uLine;
  float dC = texture(tDepth, vUv).r;
  vec3 col = texture(tColor, vUv).rgb;
  if (dC >= 1.0) {
    col = mix(uSkyBottom, uSkyTop, smoothstep(0.0, 1.0, vUv.y));
    // the cut looks into hollow masonry: show a dark section, not the sky
    if (uCut.w > 0.0) {
      vec2 dd = (vUv * 2.0 - 1.0 - uCut.xy) * vec2(uResolution.x / uResolution.y, 0.75);
      if (length(dd) < uCut.w) col = mix(uSkyBottom, uInk, 0.6);
    }
  }

  float zC = viewZ(dC);
  float iC = 1.0 / zC;
  vec4 nC = texture(tNormal, vUv);

  vec2 offs[4] = vec2[4](vec2(o.x, 0.0), vec2(-o.x, 0.0), vec2(0.0, o.y), vec2(0.0, -o.y));
  float iN[4];
  float edge = 0.0;
  for (int k = 0; k < 4; k++) {
    vec2 uv = vUv + offs[k];
    float d = texture(tDepth, uv).r;
    iN[k] = 1.0 / viewZ(d);
    vec4 n = texture(tNormal, uv);
    // crease / material boundaries (skip against the sky)
    if (d < 1.0 && dC < 1.0) {
      vec3 a = nC.xyz * 2.0 - 1.0;
      vec3 b = n.xyz * 2.0 - 1.0;
      float crease = smoothstep(0.22, 0.4, 1.0 - dot(a, b));
      float ids = abs(n.a - nC.a) > 0.01 ? 1.0 : 0.0;
      edge = max(edge, max(crease, ids * 0.9));
    }
    // silhouettes: only draw on the nearer side
    if (iC > iN[k]) {
      float jump = (iC - iN[k]) / iC;
      edge = max(edge, smoothstep(0.012, 0.03, jump));
    }
  }
  // second-derivative test catches depth steps between parallel planes
  float lap = max(abs(iN[0] + iN[1] - 2.0 * iC), abs(iN[2] + iN[3] - 2.0 * iC)) / iC;
  edge = max(edge, smoothstep(0.012, 0.03, lap) * step(dC, 0.99999));

  float fade = 1.0 - smoothstep(90.0, 170.0, zC) * 0.7;
  vec3 ink = mix(uInk, col * 0.35, 0.12);
  col = mix(col, ink, edge * 0.92 * fade);

  // soft bloom round foam and jets (their mask rides in the colour alpha)
  float glow = 0.0;
  for (int k = 0; k < 12; k++) {
    float a = float(k) * 0.5236 + 0.2;
    float rr = (k % 2 == 0 ? 2.5 : 6.0) * uLine;
    glow += 1.0 - texture(tColor, vUv + vec2(cos(a), sin(a)) * rr * uTexel).a;
  }
  glow = glow / 12.0;
  float self = 1.0 - texture(tColor, vUv).a;
  col = mix(col, vec3(1.0, 1.0, 0.95), clamp(glow * 0.9 + self * 0.4, 0.0, 0.9));

  // print grain and a warm vignette
  float g = hash(floor(vUv / uTexel) + fract(uTime) * 17.0) - 0.5;
  col += g * 0.018;
  vec2 q = vUv - 0.5;
  float v = smoothstep(0.35, 0.85, length(q * vec2(1.0, 1.25)));
  col = mix(col, col * vec3(0.94, 0.62, 0.72), v * 0.45);

  outColor = vec4(col, 1.0);
}
`;
