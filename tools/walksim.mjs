// Headless walking test: repeatedly plans a click-to-walk path to a random
// spot on the network and simulates the traveller following it with the real
// movement and collision code.   node tools/walksim.mjs [seed] [trips]

import * as THREE from 'three';
import { Generator } from '../src/world/generator.js';
import { World } from '../src/world/World.js';
import { Player, RADIUS } from '../src/player/Player.js';
import { PathFollower } from '../src/player/follow.js';
import { BLOCK_SIZE } from '../src/config.js';
import { makeRng } from '../src/world/rng.js';

globalThis.navigator ??= { hardwareConcurrency: 1 };
const seed = +(process.argv[2] ?? 8);
const trips = +(process.argv[3] ?? 20);
const gen = new Generator(seed);
const warn = console.warn;
console.warn = () => {}; // no Worker in Node: the world falls back quietly
const world = new World({ scene: { add() {}, remove() {} }, material: null, seed });
console.warn = warn;
world.workers = [];
const ensure = (x, z) => {
  const bx = Math.floor(x / BLOCK_SIZE);
  const bz = Math.floor(z / BLOCK_SIZE);
  for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) if (!world.isReady(bx + dx, bz + dz)) world.addBlock(gen.generate(bx + dx, bz + dz));
};
ensure(0, 0);
const player = new Player(null);
player.place(world.spawnPoint(RADIUS));
const rng = makeRng(seed);
let ok = 0;
let failed = 0;
let climbed = 0;
let walked = 0;
for (let t = 0; t < trips; t++) {
  ensure(player.pos.x, player.pos.z);
  // random reachable target 10-35 m away
  let goal = null;
  for (let k = 0; k < 200 && !goal; k++) {
    const a = rng() * Math.PI * 2;
    const r = 10 + rng() * 25;
    const x = player.pos.x + Math.cos(a) * r;
    const z = player.pos.z + Math.sin(a) * r;
    const h = world.standAt(x, z, RADIUS);
    if (!Number.isNaN(h) && world.onNetwork(x, z)) goal = { x, y: h, z };
  }
  if (!goal) continue;
  const t0 = performance.now();
  const follower = new PathFollower(world, RADIUS);
  const planned = follower.set(goal, false, player);
  const ms = performance.now() - t0;
  if (!planned) {
    failed++;
    console.log('no path', goal, ms.toFixed(0), 'ms');
    continue;
  }
  const res = { points: planned.slice() };
  const end = planned[planned.length - 1];
  let time = 0;
  let minY = player.y;
  let maxY = player.y;
  const desired = new THREE.Vector2();
  while (follower.path && time < 60) {
    const v = follower.update(1 / 60, player, 2.2, 4.6, false);
    if (!v) break;
    desired.set(v[0], v[1]);
    player.update(1 / 60, desired, world);
    walked += player.speed / 60;
    minY = Math.min(minY, player.y);
    maxY = Math.max(maxY, player.y);
    time += 1 / 60;
  }
  const path = follower.path || [end];
  const miss = Math.hypot(end.x - player.pos.x, end.z - player.pos.z);
  if (maxY - minY > 2.5) climbed++;
  if (miss < 0.6) ok++;
  else {
    console.log(`trip ${t}: stopped ${miss.toFixed(1)} m short after ${time.toFixed(1)} s (path ${res.points.length} pts, ${ms.toFixed(0)} ms)`);
    if (process.env.DEBUG) {
      const wp = path[0];
      const x = player.pos.x, z = player.pos.z, y = player.y;
      console.log('  at', x.toFixed(2), y.toFixed(2), z.toFixed(2), 'next wp', wp && [wp.x.toFixed(2), wp.y.toFixed(2), wp.z.toFixed(2)]);
      const dx = wp.x - x, dz = wp.z - z, d = Math.hypot(dx, dz);
      const nx = x + dx / d * 0.1, nz = z + dz / d * 0.1;
      console.log('  heightAt', world.heightAt(nx, nz), 'stand', world.standAt(nx, nz, RADIUS, y), 'barrierNear', world.nearBarrier(nx, nz, RADIUS), 'obst', world.hitsObstacle(nx, nz, RADIUS, y), 'cross', world.crossesBarrier(x, z, nx, nz));
      const L = world.locate(nx, nz);
      for (let j = L.j - 2; j <= L.j + 2; j++) {
        let row = '';
        for (let i = L.i - 2; i <= L.i + 2; i++) {
          const c = j * 32 + i;
          const w = L.b.walk;
          row += ` [${i},${j}] k${w.kind[c]} b${w.base[c]} e${w.eblock[c].toString(2).padStart(4, '0')}`;
        }
        console.log('  ', row);
      }
      for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2; const hs = world.heightAt(nx + Math.cos(a) * RADIUS, nz + Math.sin(a) * RADIUS); if (Number.isNaN(hs) || Math.abs(hs - world.heightAt(nx, nz)) > 0.55) console.log('   ring fail', k, hs); }
    }
  }
}
console.log(`trips ${trips}: arrived ${ok}, no plan ${failed}, trips with >2.5 m climbs ${climbed}, walked ${walked.toFixed(0)} m`);
