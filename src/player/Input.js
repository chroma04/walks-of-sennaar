// Keyboard, mouse, touch and gamepad input.
//
// - WASD / arrows move relative to the camera, Shift runs
// - click / tap walks to a spot; double-click / double-tap runs there
// - hold the button (or a finger) to walk towards the pointer
// - Q / E, right-drag or two-finger twist turn the view; wheel / pinch zoom

export class Input {
  constructor(el) {
    this.el = el;
    this.keys = new Set();
    this.pointers = new Map();
    this.clicks = []; // {x, y, run}
    this.hold = null; // {x, y} while steering by holding
    this.rotate = 0; // accumulated yaw delta (radians)
    this.rotateSteps = 0;
    this.zoom = 1;
    this.lastTap = { t: 0, x: 0, y: 0 };
    this.enabled = false;
    this.onKey = null;

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      if (!e.repeat) {
        if (e.code === 'KeyQ') this.rotateSteps -= 1;
        if (e.code === 'KeyE') this.rotateSteps += 1;
        if (this.onKey) this.onKey(e.code);
      }
      if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.pointers.clear();
      this.hold = null;
    });

    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        this.zoom *= Math.exp(Math.sign(e.deltaY) * Math.min(1, Math.abs(e.deltaY) / 100) * 0.12);
      },
      { passive: false },
    );
  }

  down(e) {
    if (!this.enabled) return;
    this.el.setPointerCapture?.(e.pointerId);
    const p = { id: e.pointerId, x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, t: performance.now(), button: e.button, type: e.pointerType, moved: 0 };
    this.pointers.set(e.pointerId, p);
    if (this.pointers.size === 2) {
      this.hold = null;
      const [a, b] = [...this.pointers.values()];
      // a finger that took part in a pinch never becomes a tap or a hold
      a.multi = b.multi = true;
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), a: Math.atan2(b.y - a.y, b.x - a.x) };
    }
  }

  move(e) {
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      if (this.hold) this.hold = { x: e.clientX, y: e.clientY };
      return;
    }
    const dx = e.clientX - p.x;
    p.moved += Math.hypot(e.clientX - p.x, e.clientY - p.y);
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pointers.size >= 2 && this.pinch) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const ang = Math.atan2(b.y - a.y, b.x - a.x);
      if (this.pinch.d > 0) this.zoom *= this.pinch.d / Math.max(20, d);
      let da = ang - this.pinch.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      this.rotate -= da;
      this.pinch = { d, a: ang };
      return;
    }
    if (p.button === 2 || p.button === 1) {
      this.rotate -= dx * 0.006;
      return;
    }
    if (p.button === 0 && this.hold) this.hold = { x: p.x, y: p.y };
  }

  up(e, cancel = false) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (!p || cancel || !this.enabled) {
      this.hold = null;
      return;
    }
    const wasHold = !!this.hold;
    this.hold = null;
    if (p.button !== 0 || wasHold || p.multi) return;
    const dt = performance.now() - p.t;
    if (dt < 350 && p.moved < 12) {
      const now = performance.now();
      const dbl = now - this.lastTap.t < 330 && Math.hypot(p.x - this.lastTap.x, p.y - this.lastTap.y) < 30;
      this.lastTap = { t: now, x: p.x, y: p.y };
      this.clicks.push({ x: p.x, y: p.y, run: dbl });
    }
  }

  // called every frame; promotes long presses into steering
  poll(dt = 1 / 60) {
    const now = performance.now();
    if (this.pointers.size === 1 && !this.hold) {
      const p = [...this.pointers.values()][0];
      if (p.button === 0 && !p.multi && now - p.t > 260 && p.moved < 40) this.hold = { x: p.x, y: p.y };
    }
    // held keys and sticks are rates, tuned at 60 frames per second
    const f = dt * 60;
    const out = {
      x: 0,
      y: 0,
      run: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      rotate: this.rotate,
      rotateSteps: this.rotateSteps,
      zoom: this.zoom,
      clicks: this.clicks,
      hold: this.hold,
    };
    this.rotate = 0;
    this.rotateSteps = 0;
    this.zoom = 1;
    this.clicks = [];
    if (!this.enabled) {
      out.clicks = [];
      out.hold = null;
      return out;
    }
    const k = this.keys;
    if (k.has('KeyW') || k.has('ArrowUp')) out.y += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) out.y -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) out.x += 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) out.x -= 1;
    if (k.has('Equal') || k.has('NumpadAdd')) out.zoom *= 0.98 ** f;
    if (k.has('Minus') || k.has('NumpadSubtract')) out.zoom *= 1.02 ** f;

    // gamepad
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const g of pads) {
      if (!g) continue;
      const dz = (v) => (Math.abs(v) < 0.18 ? 0 : v);
      out.x += dz(g.axes[0] || 0);
      out.y -= dz(g.axes[1] || 0);
      out.rotate += dz(g.axes[2] || 0) * 0.04 * f;
      const zin = (g.buttons[6]?.value || 0) - (g.buttons[7]?.value || 0);
      out.zoom *= (1 + zin * 0.02) ** f;
      if (g.buttons[0]?.pressed || g.buttons[10]?.pressed) out.run = true;
      if (g.buttons[4]?.pressed && !this.lb) out.rotateSteps -= 1;
      if (g.buttons[5]?.pressed && !this.rb) out.rotateSteps += 1;
      this.lb = g.buttons[4]?.pressed;
      this.rb = g.buttons[5]?.pressed;
      break;
    }
    const l = Math.hypot(out.x, out.y);
    if (l > 1) {
      out.x /= l;
      out.y /= l;
    }
    return out;
  }
}
