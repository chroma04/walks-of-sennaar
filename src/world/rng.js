// Deterministic hashing, PRNG and value noise. Everything in the world is a pure
// function of (seed, coordinates) so any block can be regenerated identically.

export function hash2(seed, x, y) {
  let h = (seed | 0) ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

export function hash3(seed, x, y, z) {
  return hash2(hash2(seed, x, y), z, 0x9e3779b9);
}

export function hashFloat(seed, x, y) {
  return hash2(seed, x, y) / 4294967296;
}

// mulberry32
export function makeRng(seed) {
  let a = seed >>> 0;
  const rng = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rng.range = (lo, hi) => lo + (hi - lo) * rng();
  rng.int = (lo, hi) => lo + Math.floor(rng() * (hi - lo + 1)); // inclusive
  rng.pick = (arr) => arr[Math.floor(rng() * arr.length)];
  rng.chance = (p) => rng() < p;
  return rng;
}

const smooth = (t) => t * t * (3 - 2 * t);

// 2D value noise in [-1, 1]. The derivative along an axis is bounded by
// 1.5 * 2 / cellSize per unit, which the level planner relies on.
export function valueNoise(seed, x, y) {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const fx = smooth(x - xi);
  const fy = smooth(y - yi);
  const v00 = hashFloat(seed, xi, yi) * 2 - 1;
  const v10 = hashFloat(seed, xi + 1, yi) * 2 - 1;
  const v01 = hashFloat(seed, xi, yi + 1) * 2 - 1;
  const v11 = hashFloat(seed, xi + 1, yi + 1) * 2 - 1;
  const a = v00 + (v10 - v00) * fx;
  const b = v01 + (v11 - v01) * fx;
  return a + (b - a) * fy;
}
