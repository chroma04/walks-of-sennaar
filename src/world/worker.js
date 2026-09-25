import { Generator, transferables } from './generator.js';

let gen = null;

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'init') {
    gen = new Generator(msg.seed);
    return;
  }
  if (msg.type === 'gen') {
    const res = gen.generate(msg.bx, msg.bz);
    // structure arrays are shared with the cache: copy before transferring
    res.walk.kind = res.walk.kind.slice();
    res.walk.base = res.walk.base.slice();
    res.walk.stairOf = res.walk.stairOf.slice();
    res.walk.deck = res.walk.deck.slice();
    res.walk.dblock = res.walk.dblock.slice();
    self.postMessage({ type: 'block', id: msg.id, res }, transferables(res));
  }
};
