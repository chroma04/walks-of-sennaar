// Headless crowd check: loads the blocks around the spawn, lets the devotees
// live for a while and reports how much they walk, whether anyone ends up off
// the ground, and what the crowd costs per frame.   node tools/crowdsim.mjs [seed] [seconds]
import { Generator } from '../src/world/generator.js';
import { World } from '../src/world/World.js';
import { Player, RADIUS } from '../src/player/Player.js';
import { Crowd } from '../src/npc/Crowd.js';
globalThis.navigator ??= { hardwareConcurrency: 1 };
const seed = +(process.argv[2] ?? 8);
const secs = +(process.argv[3] ?? 90);
const gen = new Generator(seed);
console.warn = () => {};
const scene = { add() {}, remove() {} };
const world = new World({ scene, material: null, seed });
world.workers = [];
const crowd = new Crowd({ scene, material: null, world });
for (let bz = -1; bz <= 1; bz++) for (let bx = -1; bx <= 1; bx++) world.addBlock(gen.generate(bx, bz));
const player = new Player(null);
player.place(world.spawnPoint(RADIUS));
console.log('agents', crowd.agents.length, Object.entries(crowd.agents.reduce((m, a) => ((m[a.mode] = (m[a.mode] || 0) + 1), m), {})));
let t0 = performance.now();
const dist = new Map(crowd.agents.map((a) => [a, 0]));
let maxFrame = 0;
for (let f = 0; f < 60 * secs; f++) {
  const prev = crowd.agents.map((a) => [a.x, a.z]);
  const s = performance.now();
  crowd.update(1 / 60, player);
  if (f > 60) maxFrame = Math.max(maxFrame, performance.now() - s); // after warm-up
  crowd.agents.forEach((a, k) => dist.set(a, dist.get(a) + Math.hypot(a.x - prev[k][0], a.z - prev[k][1])));
  if (f % (60 * 15) === 0) {
    const st = {}; for (const a of crowd.agents) st[a.mode + ':' + a.state] = (st[a.mode + ':' + a.state] || 0) + 1;
    console.log('t', f / 60, JSON.stringify(st));
  }
}
const ms = performance.now() - t0;
let bad = 0;
for (const a of crowd.agents) {
  if (a.mode === 'follow') continue;
  const h = world.standAt(a.x, a.z, 0.2, null, a.y);
  if (Number.isNaN(h) || Math.abs(h - a.y) > 0.3) { bad++; if (bad < 5) console.log('off ground', a.mode, a.x.toFixed(2), a.y.toFixed(2), a.z.toFixed(2), h); }
}
const byMode = {};
for (const [a, d] of dist) { byMode[a.mode] = byMode[a.mode] || []; byMode[a.mode].push(d); }
for (const [m, ds] of Object.entries(byMode)) console.log(m, 'mean metres walked', (ds.reduce((x, y) => x + y, 0) / ds.length).toFixed(1), 'still at 0:', ds.filter((d) => d < 0.1).length, '/', ds.length);
console.log('sim ms per frame', (ms / (60 * secs)).toFixed(2), 'worst', maxFrame.toFixed(1), 'off ground', bad);
process.exit(bad ? 1 : 0);
