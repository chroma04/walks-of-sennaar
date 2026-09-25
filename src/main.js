import * as THREE from 'three';
import './style.css';
import { Renderer, LAYER_OVERLAY } from './render/Renderer.js';
import { World } from './world/World.js';
import { Player, RADIUS } from './player/Player.js';
import { CameraRig } from './player/CameraRig.js';
import { Input } from './player/Input.js';
import { findPath } from './player/pathfind.js';
import { PathFollower } from './player/follow.js';
import { Ambience } from './audio/Ambience.js';
import { Crowd } from './npc/Crowd.js';

// World seed: #seed-123 (works everywhere, including sandboxed embeds), or ?seed=123
function readSeed() {
  const m = /^#(?:seed-)?(\d+)$/.exec(location.hash);
  if (m) return parseInt(m[1], 10) >>> 0;
  const q = new URLSearchParams(location.search).get('seed');
  return q !== null && /^\d+$/.test(q) ? parseInt(q, 10) >>> 0 : 8;
}
const seed = readSeed();
const WALK = 2.2;
const RUN = 4.6;

const canvas = document.getElementById('view');
const renderer = new Renderer(canvas);
const scene = new THREE.Scene();
const rig = new CameraRig();
const input = new Input(canvas);
const audio = new Ambience();
const player = new Player(renderer.playerMaterial);
scene.add(player.group);
player.onStep = (speed) => audio.step(speed);

const world = new World({
  scene,
  material: renderer.worldMaterial,
  seed,
  onChange: () => renderer.markStaticDirty(),
});
const follower = new PathFollower(world, RADIUS);
const crowd = new Crowd({ scene, material: renderer.worldMaterial, world });
player.blocked = (x0, z0, x1, z1, y) => crowd.blocks(x0, z0, x1, z1, y);

// target marker shown where a click sends the traveller
const marker = (() => {
  const g = new THREE.RingGeometry(0.28, 0.4, 24).rotateX(-Math.PI / 2);
  const mat = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3,
    transparent: true,
    depthWrite: false,
    uniforms: { uAlpha: { value: 0 } },
    vertexShader: 'void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader:
      'precision highp float; uniform float uAlpha; layout(location=0) out vec4 c; layout(location=1) out vec4 n; void main(){ c = vec4(0.16, 0.05, 0.04, uAlpha); n = vec4(0.5, 1.0, 0.5, 31.5/32.0); }',
  });
  const m = new THREE.Mesh(g, mat);
  m.layers.set(LAYER_OVERLAY);
  m.renderOrder = 10;
  scene.add(m);
  return m;
})();

const ui = {
  title: document.getElementById('title'),
  begin: document.getElementById('begin'),
  status: document.getElementById('status'),
  hud: document.getElementById('hud'),
  hint: document.getElementById('hint'),
  sound: document.getElementById('sound'),
  help: document.getElementById('help'),
  helpPanel: document.getElementById('help-panel'),
  seed: document.getElementById('seed'),
  newWorld: document.getElementById('new-world'),
};
ui.seed.textContent = String(seed);

let state = 'loading'; // loading -> title -> walking
let steer = null;
let hudHidden = false;
let clock = 0;
let pendingTeleport = null;
// adaptive resolution: trade pixels for frame rate on slower devices
const perf = { acc: 0, frames: 0, quality: 1, lastChange: 0 };
const ndc = new THREE.Vector2();
const lead = new THREE.Vector2();
const ray = new THREE.Raycaster();

function onResize() {
  renderer.resize();
  rig.resize(window.innerWidth, window.innerHeight);
}
window.addEventListener('resize', onResize);
document.addEventListener('visibilitychange', () => {
  if (!audio.ctx) return;
  if (document.hidden) audio.ctx.suspend();
  else audio.ctx.resume();
});
onResize();

function begin() {
  if (state !== 'title') return;
  state = 'walking';
  input.enabled = true;
  audio.start();
  ui.title.classList.add('gone');
  ui.hud.classList.remove('gone');
  setTimeout(() => ui.hint.classList.add('faded'), 9000);
}
ui.begin.addEventListener('click', begin);
window.addEventListener('keydown', (e) => {
  if (state === 'title' && (e.code === 'Enter' || e.code === 'Space')) begin();
});

function setMuted(m) {
  audio.setMuted(m);
  ui.sound.classList.toggle('off', m);
  ui.sound.setAttribute('aria-pressed', String(!m));
}
ui.sound.addEventListener('click', () => setMuted(!audio.muted));
ui.help.addEventListener('click', () => ui.helpPanel.classList.toggle('open'));
ui.newWorld.addEventListener('click', () => {
  location.hash = `seed-${Math.floor(Math.random() * 1e6)}`;
});
// a new seed in the address (the link above, typing, back / forward) is a new world
window.addEventListener('hashchange', () => {
  if (readSeed() !== seed) location.reload();
});
input.onKey = (code) => {
  if (state !== 'walking') return;
  if (code === 'KeyM') setMuted(!audio.muted);
  if (code === 'KeyH') {
    hudHidden = !hudHidden;
    ui.hud.classList.toggle('gone', hudHidden);
  }
  if (code === 'Slash' || code === 'F1') ui.helpPanel.classList.toggle('open');
};

function pick(x, y) {
  ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, rig.camera);
  return world.raycast(ray.ray.origin, ray.ray.direction);
}

function showMarker(p) {
  marker.position.set(p.x, p.y + 0.03, p.z);
  marker.material.uniforms.uAlpha.value = 0.85;
}

function spawn() {
  const p = world.spawnPoint(RADIUS);
  if (!p) return false;
  player.place(p);
  rig.snapTo(p);
  return true;
}

function frame(now) {
  requestAnimationFrame(frame);
  const t = now / 1000;
  const dt = Math.min(0.05, Math.max(0.0005, t - (frame.last || t)));
  frame.last = t;
  clock += dt;
  if (state === 'walking' && !document.hidden) {
    perf.acc += dt;
    perf.frames++;
    if (perf.acc > 2) {
      const avg = perf.acc / perf.frames;
      if (t - perf.lastChange > 4) {
        if (avg > 0.028 && perf.quality > 0.5) perf.quality = Math.max(0.5, perf.quality - 0.15);
        else if (avg < 0.018 && perf.quality < 1) perf.quality = Math.min(1, perf.quality + 0.1);
        if (perf.quality !== renderer.quality) {
          renderer.setQuality(perf.quality);
          perf.lastChange = t;
        }
      }
      perf.acc = 0;
      perf.frames = 0;
    }
  }

  if (state === 'loading') {
    world.update(0, 0);
    if (world.isReady(0, 0) && spawn()) {
      state = 'title';
      ui.status.textContent = '';
      ui.begin.disabled = false;
    }
  }

  if (pendingTeleport) {
    const { x, z } = pendingTeleport;
    world.update(x, z);
    for (let r = 0; r < 24 && pendingTeleport; r += 0.5) {
      for (let k = 0; k < 16; k++) {
        const a = (k / 16) * Math.PI * 2;
        const px = x + Math.cos(a) * r;
        const pz = z + Math.sin(a) * r;
        const h = world.standAt(px, pz, RADIUS);
        if (!Number.isNaN(h) && world.onNetwork(px, pz, h)) {
          player.place(new THREE.Vector3(px, h, pz));
          rig.snapTo(player.group.position);
          follower.clear();
          pendingTeleport = null;
          break;
        }
      }
    }
  }

  const inp = input.poll(dt);
  const desired = new THREE.Vector2();
  if (state === 'walking') {
    if (inp.rotateSteps) rig.rotateStep(inp.rotateSteps > 0 ? 1 : -1);
    rig.targetYaw += inp.rotate;
    if (inp.zoom !== 1) rig.zoom(inp.zoom);

    for (const c of inp.clicks) {
      const hit = pick(c.x, c.y);
      if (hit && follower.set(hit, c.run, player)) showMarker(follower.end);
    }
    const { fx, fz, rx, rz } = rig.basis();
    if (Math.hypot(inp.x, inp.y) > 0.05) {
      follower.clear();
      const sp = inp.run ? RUN : WALK;
      desired.set((fx * inp.y + rx * inp.x) * sp, (fz * inp.y + rz * inp.x) * sp);
    } else if (inp.hold) {
      follower.clear();
      const hit = pick(inp.hold.x, inp.hold.y);
      if (hit) steer = hit;
      if (steer) {
        const dx = steer.x - player.pos.x;
        const dz = steer.z - player.pos.z;
        const d = Math.hypot(dx, dz);
        if (d > 0.4) {
          const sp = d > 9 || inp.run ? RUN : WALK;
          desired.set((dx / d) * sp, (dz / d) * sp);
        }
      }
    } else {
      steer = null;
      const v = follower.update(dt, player, WALK, RUN, inp.run);
      if (v) desired.set(v[0], v[1]);
    }
  }

  if (state !== 'loading') player.update(dt, desired, world);
  if (state !== 'loading') crowd.update(dt, player);

  const mu = marker.material.uniforms.uAlpha;
  if (!follower.path) mu.value = Math.max(0, mu.value - dt * 2);

  world.update(player.pos.x, player.pos.z);
  // let the view lead a little in the direction of travel
  lead.x += (player.vel.x * 0.7 - lead.x) * (1 - Math.exp(-dt * 1.5));
  lead.y += (player.vel.y * 0.7 - lead.y) * (1 - Math.exp(-dt * 1.5));
  rig.update(dt, { x: player.pos.x + lead.x, y: player.y, z: player.pos.z + lead.y }, state !== 'walking');

  let nearest = Infinity;
  for (const f of world.fountains) nearest = Math.min(nearest, Math.hypot(f[0] - player.pos.x, f[1] - player.y, f[2] - player.pos.z));
  audio.update(dt, { nearestFountain: nearest });

  renderer.render(scene, rig.camera, {
    time: clock,
    focus: rig.focus,
    focusY: rig.focusY,
    player: new THREE.Vector3(player.pos.x, player.y, player.pos.z),
    cut: state === 'walking',
    shadowHalf: Math.max(46, rig.dist * 1.55),
  });
}
requestAnimationFrame(frame);

// debugging / automation hooks
window.__sennaar = {
  world,
  player,
  crowd,
  rig,
  renderer,
  get state() {
    return state;
  },
  begin,
  findPath,
  pick,
  teleport: (x, z) => {
    pendingTeleport = { x, z };
  },
};
