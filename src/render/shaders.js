// GLSL for the stylised look: two-tone cel lighting with cast shadows, etched
// hatching, a yellow -> orange -> magenta gradient with depth below the traveller,
// and ink outlines in a post pass.

import { MATERIAL_COUNT } from '../config.js';

export const worldVertex = /* glsl */ `
in vec2 aMat;
uniform float uTime;
out vec3 vWorld;
out vec3 vLocal;
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
in vec3 vLocal;
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
    col = mix(col, mix(uPalette[15], uPalette[14], 1.0 - light), dia);
    col = mix(col, vec3(0.2, 0.08, 0.07), split);
  } else if (m == 5) {
    // water: drifting sparkle
    float n1 = sin(vWorld.x * 3.1 + uTime * 1.4) * sin(vWorld.z * 3.7 - uTime * 1.1);
    float n2 = sin((vWorld.x - vWorld.z) * 5.3 + uTime * 2.1) * 0.6;
    float sparkle = smoothstep(1.05, 1.35, n1 + n2);
    col = mix(shade, lit, 0.35 + 0.65 * sh);
    col = mix(col, vec3(1.0), sparkle * 0.9);
  } else if (m == 8) {
    // gold: hard specular band
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 H = normalize(uSunDir + V);
    float spec = step(0.9, pow(max(dot(N, H), 0.0), 8.0)) * sh;
    col = mix(col, vec3(1.0, 0.97, 0.82), spec * 0.85);
  } else if (m == 11) {
    col = vec3(1.0, 0.98, 0.93) * (0.94 + 0.06 * sin(uTime * 9.0 + vWorld.y * 6.0));
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
  bool flatLit = m == 11 || m == 5;
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
  col = mix(col, tA, smoothstep(0.0, 0.55, df) * 0.6);
  col = mix(col, tB, smoothstep(0.3, 1.0, df) * 0.88);

  // far haze
  col = mix(col, uFog, smoothstep(uFogRange.x, uFogRange.y, vViewZ));

  outColor = vec4(col, 1.0);
  vec3 vn = normalize((viewMatrix * vec4(N, 0.0)).xyz);
  outNormal = vec4(vn * 0.5 + 0.5, (float(m) + 0.5) / 32.0);
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

  // print grain and a warm vignette
  float g = hash(floor(vUv / uTexel) + fract(uTime) * 17.0) - 0.5;
  col += g * 0.018;
  vec2 q = vUv - 0.5;
  float v = smoothstep(0.35, 0.85, length(q * vec2(1.0, 1.25)));
  col = mix(col, col * vec3(0.94, 0.62, 0.72), v * 0.45);

  outColor = vec4(col, 1.0);
}
`;
