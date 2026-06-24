// engine/colors.js — PER-STAGE COLOR THEMING (USER REQ 2026-06-22, option A).
//
// Each stage uses a LIMITED palette (a deterministic 2–4 color subset of the available palette
// keys), and a given piece SHAPE maps to ONE color within a stage — so every 2×2 in a stage
// shares a color, and the palette + shape→color mapping ROTATE per stage (the 2×2 is yellow in
// one stage, purple in another). Pure deterministic functions (no state) so the feeder (tray
// pieces) and the generator (preset decoration) agree on a stage's colors.

function hash32(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

// The limited color palette for a stage: a deterministic 2–4 key subset of `allKeys`, seeded by
// the stage index (so it's stable + the same on every code path).
export function stagePalette(stageIndex, allKeys) {
  // BLUE-ONLY (USER REQ 2026-06-22): the user reverted the per-stage multicolor — every stage now
  // uses a single BLUE block (the original look — "블록 색감이 안 이쁘네, 원래대로 파란색만").
  // The per-stage theming logic below is kept but GATED OFF behind this early return; delete the
  // return to re-enable multicolor. Falls back to the first key if blue isn't in the palette.
  return [allKeys.includes('b') ? 'b' : allKeys[0]];
  // eslint-disable-next-line no-unreachable
  const keys = allKeys.slice();
  let seed = hash32('pal:' + stageIndex);
  const next = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; };
  for (let i = keys.length - 1; i > 0; i--) { const j = next() % (i + 1); const t = keys[i]; keys[i] = keys[j]; keys[j] = t; }
  const count = Math.min(keys.length, 2 + (next() % 3)); // 2..4 colors this stage
  return keys.slice(0, count);
}

// The color key for a given piece SHAPE in a given stage — consistent within the stage (same
// shape ⇒ same color), drawn from that stage's limited palette.
export function shapeColorKey(shapeId, stageIndex, allKeys) {
  const pal = stagePalette(stageIndex, allKeys);
  return pal[hash32('shape:' + shapeId) % pal.length];
}
