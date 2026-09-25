// Generated soundscape: wind over the terraces, a slow distant choir (the
// Devotees sing), trickling fountains and soft footsteps. Pure Web Audio.

const SCALE = [0, 1, 4, 5, 7, 8, 10]; // phrygian dominant on D
const CHORDS = [
  [0, 4, 7],
  [1, 5, 8],
  [0, 5, 8],
  [-2, 1, 5],
  [0, 4, 7, 11],
  [-3, 0, 4],
];

function noiseBuffer(ctx, seconds, brown = false) {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < len; i++) {
    const w = Math.random() * 2 - 1;
    if (brown) {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  // brown noise wanders off: lean it back to where it started so the loop
  // does not click at the seam
  const end = brown ? d[len - 1] : 0;
  for (let i = 0; end && i < len; i++) d[i] -= (end * i) / (len - 1);
  return buf;
}

export class Ambience {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.started = false;
  }

  start() {
    if (this.started) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.started = true;
    const ctx = (this.ctx = new AC());
    const master = (this.master = ctx.createGain());
    master.gain.value = 0;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    master.gain.setTargetAtTime(this.muted ? 0 : 0.8, ctx.currentTime, 2);

    // reverb-ish space: a feedback delay network
    const verbIn = (this.verb = ctx.createGain());
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.5;
    for (const t of [0.137, 0.211, 0.293]) {
      const dl = ctx.createDelay(1);
      dl.delayTime.value = t;
      const fb = ctx.createGain();
      fb.gain.value = 0.55;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 2200;
      verbIn.connect(dl);
      dl.connect(lp).connect(fb).connect(dl);
      lp.connect(verbOut);
    }
    verbOut.connect(master);

    // wind
    const wind = ctx.createBufferSource();
    wind.buffer = noiseBuffer(ctx, 4, true);
    wind.loop = true;
    const wf = ctx.createBiquadFilter();
    wf.type = 'bandpass';
    wf.frequency.value = 420;
    wf.Q.value = 0.5;
    const wg = (this.windGain = ctx.createGain());
    wg.gain.value = 0.18;
    wind.connect(wf).connect(wg).connect(master);
    wind.start();
    this.windFilter = wf;

    // fountains
    const water = ctx.createBufferSource();
    water.buffer = noiseBuffer(ctx, 3);
    water.loop = true;
    const hp = ctx.createBiquadFilter();
    hp.type = 'bandpass';
    hp.frequency.value = 2600;
    hp.Q.value = 0.7;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    water.connect(hp).connect(this.waterGain).connect(master);
    this.waterGain.connect(verbIn);
    water.start();

    // choir
    this.choirBus = ctx.createGain();
    this.choirBus.gain.value = 0.11;
    this.choirBus.connect(master);
    this.choirBus.connect(verbIn);
    this.voices = [];
    this.nextChord = ctx.currentTime + 1.5;
    this.chordIndex = 0;

    // drone
    const drone = ctx.createOscillator();
    drone.type = 'sine';
    drone.frequency.value = 73.42;
    const dg = ctx.createGain();
    dg.gain.value = 0.05;
    drone.connect(dg).connect(master);
    drone.start();

    this.stepBuf = noiseBuffer(ctx, 0.2);
  }

  setMuted(m) {
    this.muted = m;
    if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.4);
  }

  voice(freq, t, dur) {
    const ctx = this.ctx;
    const out = ctx.createGain();
    out.gain.value = 0;
    out.gain.setValueAtTime(0, t);
    out.gain.linearRampToValueAtTime(0.5, t + 3.5);
    out.gain.setValueAtTime(0.5, t + dur - 4);
    out.gain.linearRampToValueAtTime(0, t + dur);
    const vowels = [
      [730, 1090],
      [570, 840],
      [300, 870],
      [520, 1190],
    ];
    const [f1, f2] = vowels[Math.floor(Math.random() * vowels.length)];
    const b1 = ctx.createBiquadFilter();
    b1.type = 'bandpass';
    b1.frequency.value = f1;
    b1.Q.value = 6;
    const b2 = ctx.createBiquadFilter();
    b2.type = 'bandpass';
    b2.frequency.value = f2;
    b2.Q.value = 8;
    const mix = ctx.createGain();
    mix.gain.value = 1;
    const oscs = [];
    for (const det of [-7, 6]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      const vib = ctx.createOscillator();
      vib.frequency.value = 4.5 + Math.random();
      const vg = ctx.createGain();
      vg.gain.value = 5;
      vib.connect(vg).connect(o.detune);
      o.connect(mix);
      o.start(t);
      vib.start(t);
      o.stop(t + dur + 0.1);
      vib.stop(t + dur + 0.1);
      oscs.push(o);
    }
    mix.connect(b1).connect(out);
    mix.connect(b2).connect(out);
    out.connect(this.choirBus);
    setTimeout(() => out.disconnect(), (dur + 1) * 1000);
  }

  update(dt, { nearestFountain }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime;
    if (t > this.nextChord) {
      const chord = CHORDS[this.chordIndex++ % CHORDS.length];
      const dur = 11 + Math.random() * 5;
      const root = 146.83; // D3
      chord.forEach((deg, k) => {
        const oct = Math.floor(deg / 7);
        const semis = SCALE[((deg % 7) + 7) % 7] + oct * 12;
        const f = root * Math.pow(2, semis / 12) * (k === 0 ? 0.5 : 1);
        this.voice(f, t + k * 0.6, dur);
      });
      this.nextChord = t + dur - 3.5;
      if (Math.random() < 0.3) this.nextChord += 5 + Math.random() * 6;
    }
    const wantWater = nearestFountain < 16 ? 0.16 * Math.pow(1 - nearestFountain / 16, 1.6) : 0;
    this.waterGain.gain.setTargetAtTime(wantWater, t, 0.3);
    this.windFilter.frequency.setTargetAtTime(380 + 160 * Math.sin(t * 0.07) + 90 * Math.sin(t * 0.23), t, 0.5);
    this.windGain.gain.setTargetAtTime(0.14 + 0.06 * Math.sin(t * 0.11), t, 0.5);
  }

  step(speed) {
    const ctx = this.ctx;
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.stepBuf;
    src.playbackRate.value = 0.7 + Math.random() * 0.3;
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 900 + Math.random() * 400;
    f.Q.value = 1.2;
    const g = ctx.createGain();
    const v = Math.min(0.28, 0.1 + speed * 0.035);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(f).connect(g).connect(this.master);
    src.start(t);
    src.stop(t + 0.12);
  }
}
