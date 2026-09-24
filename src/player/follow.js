// Turns a planned path into a desired velocity each frame, and re-plans when
// the traveller has been blocked for a moment.

import { findPath } from './pathfind.js';

export class PathFollower {
  constructor(world, radius) {
    this.world = world;
    this.radius = radius;
    this.path = null;
    this.goal = null;
    this.run = false;
    this.stuck = 0;
    this.replans = 0;
  }

  set(goal, run, player) {
    this.goal = goal;
    this.run = run;
    this.replans = 0;
    return this.plan(player);
  }

  plan(player) {
    const res = findPath(this.world, { x: player.pos.x, y: player.y, z: player.pos.z }, this.goal, this.radius);
    this.path = res && res.points.length ? res.points : null;
    this.stuck = 0;
    return this.path;
  }

  clear() {
    this.path = null;
    this.goal = null;
  }

  get end() {
    return this.path ? this.path[this.path.length - 1] : null;
  }

  // Returns the desired velocity (m/s) as [vx, vz], or null when done.
  update(dt, player, walk, run, runHeld = false) {
    const path = this.path;
    if (!path) return null;
    let wp = path[0];
    while (wp && Math.hypot(wp.x - player.pos.x, wp.z - player.pos.z) < (path.length > 1 ? 0.35 : 0.12)) {
      path.shift();
      wp = path[0];
    }
    if (!wp) {
      this.path = null;
      return null;
    }
    if (player.speed < 0.15) this.stuck += dt;
    else this.stuck = Math.max(0, this.stuck - dt);
    if (this.stuck > 0.5) {
      if (this.replans++ >= 3 || !this.plan(player)) {
        this.path = null;
        return null;
      }
      return this.update(0, player, walk, run, runHeld);
    }
    const dx = wp.x - player.pos.x;
    const dz = wp.z - player.pos.z;
    const d = Math.hypot(dx, dz);
    const sp = (this.run || runHeld ? run : walk) * (path.length === 1 ? Math.min(1, d / 0.6 + 0.25) : 1);
    return [(dx / d) * sp, (dz / d) * sp];
  }
}
