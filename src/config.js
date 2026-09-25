// Shared constants for the generator (worker) and the renderer (main thread).

export const CELL = 2; // metres per layout cell
export const BLOCK = 32; // cells per block side
export const BLOCK_SIZE = CELL * BLOCK; // 64 m
export const LEVEL_H = 3; // metres per terrace level
export const STAIR_CELLS_PER_LEVEL = 2; // run of a stair per level, in cells
export const STEPS_PER_CELL = 6; // 12 risers of 0.25 m per level

// Cell kinds (walk + mesh classification)
export const K_FLOOR = 0;
export const K_STAIR = 1;
export const K_BUILDING = 2;
export const K_LANDING = 3;
export const K_WATER = 4; // canal water: not walkable, rendered as a sunken surface

// Direction vectors: 0 = +x, 1 = +z, 2 = -x, 3 = -z
export const DX = [1, 0, -1, 0];
export const DZ = [0, 1, 0, -1];

// Material ids, written per vertex and resolved to colours in the world shader.
export const M = {
  STONE: 0,
  ROOF: 1,
  WINDOW: 2,
  DOOR: 3,
  FOLIAGE: 4,
  WATER: 5,
  GRASS: 6,
  STRIPE: 7,
  GOLD: 8,
  ROBE: 9,
  MASK: 10,
  WHITE: 11,
  SOIL: 12,
  DARK: 13,
  TRUNK: 14,
  CREAM: 15,
  GLYPH: 16,
  FOAM: 17, // broken white glitter along water edges
  FALL: 18, // falling water sheets over weirs
};
export const MATERIAL_COUNT = 19;

const hex = (h) => [((h >> 16) & 255) / 255, ((h >> 8) & 255) / 255, (h & 255) / 255];

// [lit, shade] per material, display-referred sRGB. STONE uses floor colours for
// up-facing surfaces and the WALL pair below for vertical ones.
export const PALETTE = [
  [hex(0xfbe54f), hex(0xf2a93c)], // STONE (floor)
  [hex(0xdc4a5f), hex(0xa82c4a)], // ROOF
  [hex(0xc97a3e), hex(0x9c4a2f)], // WINDOW
  [hex(0x93aba2), hex(0x5f716c)], // DOOR
  [hex(0x55bf9f), hex(0x2c7465)], // FOLIAGE
  [hex(0x66e6c6), hex(0x2fae98)], // WATER
  [hex(0x5c9f7c), hex(0x3a6c5a)], // GRASS
  [hex(0xc93a53), hex(0x92253e)], // STRIPE
  [hex(0xffd84c), hex(0xd98f2c)], // GOLD
  [hex(0xc3304a), hex(0x861b36)], // ROBE
  [hex(0xf8ead0), hex(0xd6ae86)], // MASK
  [hex(0xffffff), hex(0xe9fff7)], // WHITE
  [hex(0xa2522f), hex(0x7a3526)], // SOIL
  [hex(0x5a2418), hex(0x3e160f)], // DARK
  [hex(0x4b9e84), hex(0x2a6558)], // TRUNK
  [hex(0xfcefb0), hex(0xf0b857)], // CREAM
  [hex(0xb8462c), hex(0x8a2f22)], // GLYPH
  [hex(0xffffff), hex(0xeafff8)], // FOAM
  [hex(0xeafff7), hex(0x8fe3cf)], // FALL
];
export const WALL_LIT = hex(0xf7c850);
export const WALL_SHADE = hex(0xe58a3a);

export const INK = hex(0x2a0d0a);
export const DEPTH_ORANGE = hex(0xee6a3a);
export const DEPTH_MAGENTA = hex(0xd23a62);
export const SKY_TOP = hex(0xf6c65a);
export const SKY_BOTTOM = hex(0xd8406a);

// Sun direction (towards the sun), fixed in world space.
export const SUN_DIR = (() => {
  const az = (-128 * Math.PI) / 180;
  const el = (44 * Math.PI) / 180;
  const v = [Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)];
  return v;
})();
