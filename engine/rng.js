// engine/rng.js — SEEDED RNG (deterministic, GLOBAL L48/§determinism).
// Pure: no Date.now()/Math.random() leaks into game logic. The feeder and any
// stochastic policy take an RNG instance so headless QA is byte-reproducible.
//
// mulberry32 — fast, good distribution, 32-bit state, trivially seedable.

export function makeRng(seed) {
  // Normalize seed to a 32-bit unsigned int (string seeds hashed).
  let a = (typeof seed === 'string' ? hashStr(seed) : (seed >>> 0)) || 0x9e3779b9;
  const next = () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    // float in [0,1)
    float: next,
    // int in [0, n)
    int: (n) => Math.floor(next() * n),
    // pick one element
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    // weighted pick: items=[...], weights=[...] (>=0). Returns index.
    weightedIndex(weights) {
      let sum = 0;
      for (let i = 0; i < weights.length; i++) sum += weights[i];
      if (sum <= 0) return Math.floor(next() * weights.length);
      let r = next() * sum;
      for (let i = 0; i < weights.length; i++) { r -= weights[i]; if (r <= 0) return i; }
      return weights.length - 1;
    },
    // expose state so a run can be snapshotted / forked deterministically
    getState: () => a >>> 0,
    setState: (s) => { a = s >>> 0; },
  };
}

function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
