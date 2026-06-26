// engine/feeder.js — ADAPTIVE "near-death save" BLOCK FEEDER (GAME_DESIGN §4).
//
// PURE FUNCTION of (board, score, combo, stageIndex, rng, config) — no Date.now()
// or Math.random(); all randomness flows through the passed seeded RNG so QA is
// reproducible. Produces a set of `trayCount` pieces whose difficulty is shaped by
// the danger D, difficulty-target T, and — NEW — a board ROOMINESS signal that
// governs piece SIZE (big boxes when there's space, fitting pieces when tight),
// with a joint-survivability DFS guard.
//
// Selection is "best-of-N": each refill samples `cfg.sampleCount` candidate sets
// (weighted by the space-aware per-piece weights), scores each by
// {survivability, multi-line-clear potential, size↔roominess match}, and keeps the
// best. This replaces the old "first acceptable set" loop and is what fixes the
// "cramped/답답" feel — SPACE, not just T, drives size, and sets that can chain
// several line-clears are favoured when near-full lines exist (USER REQ #2/#3).
//
// PERF: feedTray runs ONCE per 3-piece refill (never per frame). Each candidate
// costs one setIsSurvivable DFS + (when scored) one BOUNDED setMaxClear DFS
// (positions/nodes capped via cfg). With sampleCount≈18 a refill stays well under
// ~30ms on a mid phone. All bounds live in config.feeder (data-driven, GLOBAL A1).
//
// 3-layer split (GLOBAL A6): this is pure LOGIC. It emits no visuals; the caller
// (game.js) fires onDanger/onRescue events for the look layer.

import { PIECES, pieceArea, isBigBox, pieceBounds } from './pieces.js';
import { shapeColorKey } from './colors.js';

// ── metrics (§4.1) ──────────────────────────────────────────────────────────
// Computed once per feed from the board; returned for telemetry / events.
export function computeMetrics(board, cfg) {
  const total = board.size;
  const fill = board.filledCount() / total;

  // near-full rows/cols: <= nearAlmostK empty cells
  const k = cfg.nearAlmostK;
  let nearLines = 0;
  for (let y = 0; y < board.rows; y++) {
    let empty = 0;
    for (let x = 0; x < board.cols; x++) if (board.cells[board.idx(x, y)] === 0) empty++;
    if (empty > 0 && empty <= k) nearLines++;
  }
  for (let x = 0; x < board.cols; x++) {
    let empty = 0;
    for (let y = 0; y < board.rows; y++) if (board.cells[board.idx(x, y)] === 0) empty++;
    if (empty > 0 && empty <= k) nearLines++;
  }

  // fragmentation: 1 - (largestEmptyRegion / totalEmpty). High when empty space is
  // chopped into small islands (hard to place big pieces).
  const emptyTotal = total - board.filledCount();
  const maxRegion = emptyTotal > 0 ? board.maxEmptyRegion() : 0;
  const frag = emptyTotal > 0 ? (1 - maxRegion / emptyTotal) : 0;

  // roominess R ∈ [0,1]: how much of the free space is ONE connected blob (= the
  // inverse of fragmentation), used by the space-aware big-box bias. R is the raw
  // signal; feedTray combines it with `fill` (a board past roomyFillMax is never
  // roomy, however connected its scraps are).
  const roominess = emptyTotal > 0 ? (maxRegion / emptyTotal) : 0;

  // placeableShapeRatio: fraction of the whole piece library that fits anywhere now.
  // (A roomy board → high ratio → low danger. A choked board → low ratio.)
  let placeable = 0;
  for (const p of PIECES) if (board.hasAnyFit(p)) placeable++;
  const placeableShapeRatio = placeable / PIECES.length;

  return { fill, nearLines, frag, roominess, placeableShapeRatio, maxRegion, emptyTotal };
}

// danger D ∈ [0,1]
export function dangerScore(m, cfg) {
  const nearTerm = Math.min(1, m.nearLines * cfg.nearDangerScale);
  const D = cfg.wf * m.fill
          + cfg.wg * m.frag
          + cfg.wn * nearTerm
          - cfg.wh * m.placeableShapeRatio;
  return clamp01(D);
}

// difficulty target T ∈ [0, Tmax]
export function difficultyTarget(score, stageIndex, cfg) {
  const T = cfg.rampPerStage * stageIndex + cfg.rampPerScore * score;
  return Math.min(cfg.Tmax, Math.max(0, T));
}

// Roominess factor ∈ [0,1] for the size bias: 1 = wide open (big boxes common),
// 0 = tight (small fitting pieces). Combines the connected-blob ratio with a hard
// fill cap so a high-fill board is never "roomy" even if its scraps are connected.
function roominessFactor(metrics, cfg) {
  const byRegion = clamp01(metrics.roominess / Math.max(1e-6, cfg.roomyRegionFrac));
  const byFill = clamp01((cfg.roomyFillMax - metrics.fill) / Math.max(1e-6, cfg.roomyFillMax));
  return clamp01(Math.min(byRegion, byFill));
}

// ── candidate evaluation ─────────────────────────────────────────────────────
// Does placing `piece` at its BEST spot clear >= 1 line right now? (rescue test)
function bestImmediateClear(board, piece) {
  let best = 0;
  for (let oy = 0; oy < board.rows; oy++) {
    for (let ox = 0; ox < board.cols; ox++) {
      if (!board.canPlace(piece, ox, oy)) continue;
      // simulate fill, count full lines, undo
      const filled = [];
      for (const [dx, dy] of piece.cells) { const i = board.idx(ox + dx, oy + dy); board.cells[i] = 'sim'; filled.push(i); }
      const lines = board.fullLines();
      const n = lines.rows.length + lines.cols.length;
      for (const i of filled) board.cells[i] = 0;
      if (n > best) best = n;
    }
  }
  return best; // number of lines the best placement of this piece clears
}

// Origin {x,y} of the placement that clears the MOST lines right now (or null if none clears any).
// Marks the GAP the queue intends a dealt piece for (USER REQ 2026-06-22 따봉, ORIGINAL trigger):
// placing the piece AT this origin = "이 공간 때문에 나온 블록을 그 자리에 배치" → fires the reward.
function bestClearSpot(board, piece) {
  let best = 0, bx = -1, by = -1;
  for (let oy = 0; oy < board.rows; oy++) {
    for (let ox = 0; ox < board.cols; ox++) {
      if (!board.canPlace(piece, ox, oy)) continue;
      const filled = [];
      for (const [dx, dy] of piece.cells) { const i = board.idx(ox + dx, oy + dy); board.cells[i] = 'sim'; filled.push(i); }
      const lines = board.fullLines();
      const n = lines.rows.length + lines.cols.length;
      for (const i of filled) board.cells[i] = 0;
      if (n > best) { best = n; bx = ox; by = oy; }
    }
  }
  return best > 0 ? { x: bx, y: by, lines: best } : null;
}

// ── weight shaping per mode (§4.2) + space-aware big-box bias (USER REQ #2) ──
// `room` ∈ [0,1] is the roominess factor (1 roomy → big boxes; 0 tight → smaller).
function buildWeights(board, mode, T, room, cfg) {
  const weights = new Array(PIECES.length);
  // big-box multiplier interpolates tight→roomy (lerp on `room`).
  const bigBoxMul = lerp(cfg.bigBoxWeightTight, cfg.bigBoxWeightRoomy, room);
  for (let i = 0; i < PIECES.length; i++) {
    const p = PIECES[i];
    const area = pieceArea(p);                     // REAL cell count (USER REQ #1)
    const big = (p.sizeTag === 'l');               // any large piece
    const bigBox = isBigBox(p);                    // the satisfying 3×3 / 2×3 / 3×2
    const fits = board.hasAnyFit(p);
    let w;

    if (mode === 'rescue') {
      // favour pieces that fit AND immediately clear a line; de-weight big/awkward.
      const fit = fits ? 1 : 0.02;                 // near-zero (not zero) for unfittable
      const clears = fits ? bestImmediateClear(board, p) : 0;
      w = fit;
      if (clears >= 1) w *= cfg.rescueWeight;
      if (big) w *= cfg.rescueBigPenalty;
      // small pieces are always safe rescue filler
      if (p.sizeTag === 'xs' || p.sizeTag === 's') w *= 1.4;
    } else if (mode === 'pressure') {
      // favour big/awkward, de-weight pieces that immediately gift a clear.
      const clears = fits ? bestImmediateClear(board, p) : 0;
      w = 1;
      if (big) w *= cfg.pressUpWeight;
      if (clears >= 1) w *= cfg.pressClearPenalty;
      // bias toward larger area as pressure rises (real area, max 9 for the 3×3)
      w *= 0.6 + 0.4 * (area / 9);
      // space-aware: even under pressure, lean into the big BOXES when roomy.
      if (bigBox) w *= bigBoxMul;
    } else {
      // mid: SPACE governs size (USER REQ #2). The old "small when T low" preference
      // is DAMPED toward midSmallBiasRoomy× as the board opens up, and the big BOXES
      // are scaled up by the roominess-driven multiplier. This is the "답답" fix:
      // a roomy board now serves big boxes commonly instead of small filler.
      const ease = 1 - T;                          // 1 (easy) .. 0 (hard)
      const smallStrength = cfg.sizeBias * lerp(1, cfg.midSmallBiasRoomy, room);
      const smallPref = 1 + ease * smallStrength * (1 - area / 9);
      w = smallPref;
      if (bigBox) w *= bigBoxMul;                  // big boxes common when roomy
      // EASIER + more dopamine (CHANGE 2): in MID, boost any piece that can clear a
      // line RIGHT NOW so satisfying clears are FREQUENT (not only during rescue).
      // Moderate (cfg.midClearWeight) so it doesn't force a clear every placement.
      if (fits && cfg.midClearWeight > 1 && bestImmediateClear(board, p) >= 1) w *= cfg.midClearWeight;
    }
    // diagonal staircases appear, but RARER (they're awkward for line clears — full weight
    // inflated variance). USER REQ: present in the queue, just not common.
    if (p.id === 'diag_a' || p.id === 'diag_b') w *= (cfg.diagWeight ?? 0.32);
    // ② the single 1×1 'dot' is RARE (USER REQ 2026-06-22: "1개짜리 블록 등장빈도 많이 낮춰") —
    // it trivializes a slot and isn't satisfying. De-weight hard so it only occasionally appears.
    if (p.id === 'dot') w *= (cfg.dotWeight ?? 0.07);
    // ㉕: a piece that CANNOT be placed ANYWHERE on the CURRENT board (its orientation doesn't
    // fit the empty cells' arrangement) is almost never served — so the queue offers orientations
    // that actually FIT (e.g. the fitting 3+1 L, not a mismatched one). RESCUE already did this;
    // applying it in EVERY mode stops unplaceable pieces appearing early (MID / low-danger). When
    // the board is so full that NOTHING fits, all weights hit the floor → game-over check handles it.
    if (!fits) w *= (cfg.unfitPenalty ?? 0.015);
    weights[i] = Math.max(0.0001, w);
  }
  return weights;
}

// ── joint survivability (§4.2.4): can ALL pieces be placed in SOME order, with
// the board (and clears) evolving? DFS depth = set length, with pruning. ───────
export function setIsSurvivable(board, pieceSet) {
  // PERF (L13): in-place undo via one reusable record per DFS — NO snapshot()/restore()
  // (which allocated a 64-elem Array.slice() + a Map PER node). A small pool of records
  // (one per depth) is reused across all sibling branches at that depth, so the whole
  // DFS allocates only `set.length` records once, not thousands. Behaviour identical.
  const recs = new Array(pieceSet.length);
  for (let d = 0; d < pieceSet.length; d++) recs[d] = board.makeSimRec();
  return dfsSurvive(board, pieceSet, 0, new Array(pieceSet.length).fill(false), recs);
}

function dfsSurvive(board, set, placedCount, used, recs) {
  if (placedCount === set.length) return true;
  const rec = recs[placedCount];
  for (let i = 0; i < set.length; i++) {
    if (used[i]) continue;
    const piece = set[i];
    // try first viable placement(s); any placement that keeps us alive is enough
    for (let oy = 0; oy < board.rows; oy++) {
      for (let ox = 0; ox < board.cols; ox++) {
        if (!board.canPlace(piece, ox, oy)) continue;
        board.simPlaceClear(piece, ox, oy, rec, 'x');
        used[i] = true;
        if (dfsSurvive(board, set, placedCount + 1, used, recs)) {
          used[i] = false; board.simUndo(rec); return true;
        }
        used[i] = false; board.simUndo(rec);
      }
    }
    // if THIS piece cannot be placed anywhere at all → this branch already dead,
    // but a different first piece might open room, so keep trying others.
  }
  return false;
}

// ── multi-line-clear potential (USER REQ #3) ──────────────────────────────────
// setMaxClear(board, set) = bounded DFS over placing ALL pieces in the best order
// and positions, returning the MAX TOTAL number of lines clearable across the
// sequence (clears compound: a clear opens room for the next piece). This lets the
// feeder favour 3-piece sets whose COMBINATION can wipe several lines even when no
// single queued piece can. The search is bounded for the per-refill perf budget:
//   • per piece we only explore up to `maxClearPosCap` placements, BEST-FIRST
//     (placements that clear the most lines now are tried first), and
//   • a global `maxClearNodeCap` node budget early-outs the whole DFS.
// Pure: snapshots/restores the board, never mutates committed state.
export function setMaxClear(board, pieceSet, cfg) {
  // PERF (L13): in-place undo (no per-node snapshot()/restore() = no Array+Map alloc),
  // plus REUSABLE per-depth scratch for the candidate list (ox/oy/n) so the DFS
  // allocates a small fixed pool ONCE instead of a fresh `cand` array + objects per
  // node. Determinism unchanged: same best-first order, same caps, same node budget.
  const depth = pieceSet.length;
  const cap = board.size;            // max candidate placements per piece
  const recs = new Array(depth);
  const candOx = new Array(depth), candOy = new Array(depth), candN = new Array(depth), candOrd = new Array(depth);
  for (let d = 0; d < depth; d++) {
    recs[d] = board.makeSimRec();
    candOx[d] = new Int32Array(cap); candOy[d] = new Int32Array(cap);
    candN[d] = new Int32Array(cap); candOrd[d] = new Int32Array(cap);
  }
  const scratch = { recs, candOx, candOy, candN, candOrd };
  const budget = { nodes: cfg.maxClearNodeCap | 0 };
  const used = new Array(depth).fill(false);
  return dfsMaxClear(board, pieceSet, used, 0, cfg, budget, scratch, 0);
}

function dfsMaxClear(board, set, used, accum, cfg, budget, scratch, depth) {
  let best = accum;
  const rec = scratch.recs[depth];
  const cOx = scratch.candOx[depth], cOy = scratch.candOy[depth], cN = scratch.candN[depth], cOrd = scratch.candOrd[depth];
  for (let i = 0; i < set.length; i++) {
    if (used[i]) continue;
    const piece = set[i], cells = piece.cells, cols = board.cols, C = board.cells;
    // gather candidate placements with the line-count each yields (into reusable
    // typed scratch — no allocation). We tag each with the cells it clears NOW.
    let m = 0;
    for (let oy = 0; oy < board.rows; oy++) {
      for (let ox = 0; ox < board.cols; ox++) {
        // inline canPlace + simulate-fill + count lines + unfill (no array alloc).
        let ok = true;
        for (let q = 0; q < cells.length; q++) {
          const x = ox + cells[q][0], y = oy + cells[q][1];
          if (x < 0 || y < 0 || x >= cols || y >= board.rows || C[y * cols + x] !== 0) { ok = false; break; }
        }
        if (!ok) continue;
        for (let q = 0; q < cells.length; q++) C[(oy + cells[q][1]) * cols + (ox + cells[q][0])] = 'sim';
        // count full lines
        let n = 0;
        for (let y = 0; y < board.rows; y++) { let full = true; const b = y * cols; for (let x = 0; x < cols; x++) if (C[b + x] === 0) { full = false; break; } if (full) n++; }
        for (let x = 0; x < cols; x++) { let full = true; for (let y = 0; y < board.rows; y++) if (C[y * cols + x] === 0) { full = false; break; } if (full) n++; }
        for (let q = 0; q < cells.length; q++) C[(oy + cells[q][1]) * cols + (ox + cells[q][0])] = 0;
        cOx[m] = ox; cOy[m] = oy; cN[m] = n; cOrd[m] = m; m++;
      }
    }
    if (m === 0) continue;                         // this piece can't be placed now
    // best-first order: STABLE descending sort of the index list cOrd by clear-count.
    // MUST match the old `cand.sort((a,b)=>b.n-a.n)` order EXACTLY — V8's sort is
    // stable (equal-n keep scan order), and the `if (n===0) break` prune below means
    // the *order among equal-n candidates decides which single n===0 branch (and which
    // n>0 spots) get explored* → it affects the returned max. A non-stable sort
    // (e.g. selection sort) silently changes the result on ~0.2% of boards (verified),
    // which would drift the feeder. Insertion sort over indices is stable + O(m²) only
    // in the worst case but m is small (≤64) and this runs on already-near-sorted data.
    for (let a = 1; a < m; a++) {
      const key = cOrd[a]; const kn = cN[key]; let j = a - 1;
      while (j >= 0 && cN[cOrd[j]] < kn) { cOrd[j + 1] = cOrd[j]; j--; }
      cOrd[j + 1] = key;
    }
    const limit = Math.min(m, cfg.maxClearPosCap | 0);
    for (let c = 0; c < limit; c++) {
      if (budget.nodes <= 0) return best;          // global early-out (perf bound)
      budget.nodes--;
      const oidx = cOrd[c];
      const ox = cOx[oidx], oy = cOy[oidx], n = cN[oidx];
      board.simPlaceClear(piece, ox, oy, rec, 'x');
      used[i] = true;
      const sub = dfsMaxClear(board, set, used, accum + n, cfg, budget, scratch, depth + 1);
      if (sub > best) best = sub;
      used[i] = false;
      board.simUndo(rec);
      // prune: a clearing placement already explored as best-first; for a piece
      // that clears nothing anywhere, one representative branch is enough to
      // discover deeper clears (avoids exploring N empty positions identically).
      if (n === 0) break;
    }
  }
  return best;
}

// Is at least one piece in the set placeable right now? (soft "mercy" floor)
function setHasAnyPlaceable(board, set) {
  for (const p of set) if (board.hasAnyFit(p)) return true;
  return false;
}

// Average real area of a set (for the size↔roominess profile term).
function setAvgArea(set) {
  let s = 0;
  for (const p of set) s += pieceArea(p);
  return s / set.length;
}

// Count of big-BOX pieces (3×3/2×3/3×2) in a set.
function setBigBoxCount(set) {
  let n = 0;
  for (const p of set) if (isBigBox(p)) n++;
  return n;
}

// ── main entry: produce a tray set (deterministic given rng/state) ───────────
// Returns { pieces:[{...piece, color}], mode, D, T, metrics, resamples, ... }.
export function feedTray(board, ctx) {
  const { rng, cfg, score, combo, stageIndex, palette, trayCount } = ctx;
  const metrics = computeMetrics(board, cfg);
  const D = dangerScore(metrics, cfg);
  const T = difficultyTarget(score, stageIndex, cfg);
  const room = roominessFactor(metrics, cfg);

  // choose mode (§4.2)
  let mode = 'mid';
  if (D >= cfg.dangerHi) mode = 'rescue';
  else if (D <= cfg.dangerLo && T >= cfg.pressureTmin) mode = 'pressure';

  // CLEARABILITY GUARANTEE (USER REQ): a busy board MUST get a tray that can clear ≥1 line,
  // or the player is stranded (the "queue can't clear the center" bug). On such boards a
  // survivable CLEARING set outranks a non-clearing one, and we force-resample if none was
  // sampled. Gated on fill so roomy early boards keep their variety.
  const needClear = metrics.fill >= (cfg.clearGuaranteeFill ?? 0.40);

  // NO-DEAD-END QUEUE (USER REQ 2026-06-22 "큐 등장 로직 개선"): when guaranteedSurvive is set,
  // the feeder ALWAYS demands a fully-survivable tray (and never allows a deadly one), so a long
  // high-goal stage (e.g. collect 100 gems over ~100 placements) can NEVER game-over before the
  // goal. Without it, survivability is probabilistic and ~1%/refill compounds to frequent
  // dead-ends over a long stage. The probabilistic path stays for stages that opt out.
  const guaranteed = !!cfg.guaranteedSurvive;
  // required survive probability scales with danger
  const surviveProb = lerp(cfg.surviveProbLo, cfg.surviveProbHi, D);
  const wantSurvive = guaranteed ? true
    : (mode === 'rescue')
      ? (rng.float() < cfg.mercy ? rng.float() < surviveProb : false)
      : (rng.float() < surviveProb);
  // PRESSURE: occasionally allow a genuinely deadly set (keeps real tension) — never when guaranteed.
  const allowDeath = !guaranteed && (mode === 'pressure') && (rng.float() < cfg.pressureDeathChance);

  // multi-clear reward is boosted when near-full lines already exist (USER REQ #3):
  // those are the boards where a multi-clearing set pays off the most.
  const multiClearW = cfg.multiClearWeight *
    (metrics.nearLines > 0 ? cfg.multiClearNearLineBoost : 1);

  // size-profile target: how big the set "should" feel for this roominess. On a
  // roomy board we want a high average area (big boxes); on a tight board, small.
  // Target avg area ranges ~3 (tight) .. ~7 (roomy) cells.
  const targetAvgArea = lerp(3, 7, room);

  const paletteKeys = Object.keys(palette);
  const weights = buildWeights(board, mode, T, room, cfg);

  // ── best-of-N sampling: draw `sampleCount` candidate sets, score each, keep best.
  // Many of the N samples collide on the same piece-multiset (the library is small),
  // so we MEMOIZE the three expensive evaluations (survivability DFS, setMaxClear
  // DFS, rescue clear-count) per unique signature. This keeps the heaviest case
  // (open board + contiguous near-full lines) well inside the per-refill budget
  // without changing the RNG stream → determinism preserved (PERF note, top of file).
  let best = null, accepted = 0, sampled = 0;
  const evalCache = new Map();   // sig → { survivable, maxClear, rescueClearers }
  const N = Math.max(1, cfg.sampleCount | 0);
  for (let attempt = 0; attempt < N; attempt++) {
    sampled++;
    // sample one candidate set from the space-aware weights (duplicates de-weighted)
    const set = [];
    const wcopy = weights.slice();
    for (let s = 0; s < trayCount; s++) {
      const idx = rng.weightedIndex(wcopy);
      set.push(PIECES[idx]);
      wcopy[idx] *= 0.45;          // reduce exact dupes (not zero — dupes allowed)
    }

    // signature = sorted piece ids (order-independent: setMaxClear/survivability are
    // already order-agnostic, both try every placement order via DFS).
    const sig = set.map((p) => p.id).sort().join('|');
    let ev = evalCache.get(sig);
    if (!ev) {
      const survivable = setIsSurvivable(board, set);
      const maxClear = setMaxClear(board, set, cfg);
      let rescueClearers = 0;
      if (mode === 'rescue') {
        for (const p of set) if (board.hasAnyFit(p) && bestImmediateClear(board, p) >= 1) rescueClearers++;
      }
      ev = { survivable, maxClear, rescueClearers };
      evalCache.set(sig, ev);
    }
    const survivable = ev.survivable;
    const anyPlaceable = setHasAnyPlaceable(board, set);

    // hard acceptance gate (same survivability contract as before)
    let accept;
    if (allowDeath) accept = true;                 // deliberately let a deadly set through
    else if (wantSurvive) accept = survivable;     // must be fully survivable
    else accept = anyPlaceable;                    // soft floor: at least one piece placeable
    if (accept) accepted++;

    // ── score the candidate (higher = better) ────────────────────────────────
    let scoreV = 0;
    if (survivable) scoreV += cfg.scoreSurvivable;
    if (anyPlaceable) scoreV += cfg.scoreAnyPlaceable;

    // ㉛: strongly PREFER queues whose pieces FIT the current board RIGHT NOW (orientation-aware,
    // not just survivable-via-reorder) — reward each fitting piece + a big bonus when ALL fit, so
    // "blocks that drop straight into the empty spaces" appear much more often.
    let fitCount = 0; for (const p of set) if (board.hasAnyFit(p)) fitCount++;
    scoreV += fitCount * (cfg.scoreFitsNow ?? 2.0);
    if (fitCount === set.length) scoreV += (cfg.scoreAllFit ?? 4.0);

    // multi-line-clear potential of the COMBINATION (bounded DFS, memoized).
    scoreV += Math.min(ev.maxClear, cfg.multiClearCap) * multiClearW;

    // size↔roominess profile match: reward sets whose avg area matches the target
    // for this roominess, and explicitly reward big BOXES when the board is roomy.
    const avgArea = setAvgArea(set);
    const profileMatch = 1 - Math.min(1, Math.abs(avgArea - targetAvgArea) / 5);
    scoreV += profileMatch * cfg.scoreSizeProfile;
    scoreV += setBigBoxCount(set) * room * cfg.scoreSizeProfile * 0.6;

    // ① BIG-PIECE CAP on tight boards (USER REQ 2026-06-22): penalize big ('l') pieces beyond
    // cfg.bigPieceCap, SCALED BY TIGHTNESS (1-room). On a TIGHT board 2+ big pieces → one
    // misplacement strands the rest = instant game-over ("1개만 잘못 놔도 아웃"); on a ROOMY board
    // (1-room ≈ 0) the penalty vanishes so 3×3 / 2×3 stay common. Strong enough to outrank the
    // size-profile / multi-clear reward when tight, so the tray serves ≤1 big piece there.
    let bigN = 0; for (const p of set) if (p.sizeTag === 'l') bigN++;
    const overCap = bigN - (cfg.bigPieceCap ?? 1);
    if (overCap > 0) scoreV -= overCap * (cfg.bigPieceOverPenalty ?? 12) * (1 - room);

    // RESCUE: also reward sets full of immediately-clearable fitting pieces.
    if (mode === 'rescue') scoreV += ev.rescueClearers * cfg.scoreRescueClear;

    // ranking: a candidate that passes the hard gate ALWAYS beats one that doesn't
    // (rank tier), then by the soft score. This keeps the survivability guard
    // dominant (never trade safety for a prettier multi-clear) while letting the
    // score pick among the safe candidates (GAME_DESIGN §4 + USER REQ).
    let tier = accept ? 2 : ((survivable ? 1 : 0) + (anyPlaceable ? 1 : 0));
    // on a busy board, a survivable set that CAN clear a line beats one that can't.
    if (needClear && accept && ev.maxClear >= 1) tier = 3;
    const cand = { set, tier, scoreV, survivable, anyPlaceable };
    if (!best || cand.tier > best.tier || (cand.tier === best.tier && cand.scoreV > best.scoreV)) {
      best = cand;
    }
  }

  // ── CLEARABILITY GUARANTEE resample: on a busy board, if the best set STILL can't clear
  //    any line, FORCE a piece that immediately completes a line into the tray and keep the
  //    first survivable+clearing combination. Bounded extra attempts (budget-safe). If the
  //    board has no completable line at all (no clearer fits), we can't guarantee → keep the
  //    best survivable set (a genuinely set-up-first board; the survivability guard holds).
  if (needClear && best && best.set && setMaxClear(board, best.set, cfg) < 1) {
    const clearers = [];
    for (let i = 0; i < PIECES.length; i++) {
      const p = PIECES[i];
      if (board.hasAnyFit(p) && bestImmediateClear(board, p) >= 1) clearers.push(i);
    }
    if (clearers.length) {
      const GN = Math.max(10, N);
      for (let a = 0; a < GN; a++) {
        const set = [PIECES[clearers[rng.int(clearers.length)]]]; // guarantee ≥1 line-completer
        const wcopy = weights.slice();
        for (let s = 1; s < trayCount; s++) { const idx = rng.weightedIndex(wcopy); set.push(PIECES[idx]); wcopy[idx] *= 0.45; }
        if (setIsSurvivable(board, set) && setMaxClear(board, set, cfg) >= 1) {
          best = { set, tier: 3, scoreV: best.scoreV + 1, survivable: true, anyPlaceable: true };
          break;
        }
      }
    }
  }

  const chosen = best.set;
  // assign a palette color per piece deterministically
  const pieces = chosen.map((p) => ({
    id: p.id, sizeTag: p.sizeTag, cells: p.cells,
    // per-stage shape→color (USER REQ 2026-06-22, A): same shape ⇒ same color within a stage,
    // drawn from the stage's limited palette; the mapping rotates per stage.
    color: shapeColorKey(p.id, stageIndex, paletteKeys),
  }));

  // ── THUMBS-UP INTENT (USER REQ 2026-06-22 따봉, ORIGINAL trigger restored) ─────
  // Mark each dealt piece with the GAP the queue intends it for = the origin where it clears the
  // most line(s) on the CURRENT (tray-spawn) board. Placing the piece EXACTLY there later fires the
  // per-cell 따봉 (game.js onGoodPlace). Only pieces with a real clearing spot get a fitSpot.
  for (const p of pieces) {
    const spot = bestClearSpot(board, p);
    if (spot) p.fitSpot = { x: spot.x, y: spot.y };
  }

  // ── GEM-IN-QUEUE delivery (USER REQ 2026-06-18) ───────────────────────────────
  // Keep "enough gems available to finish" — count gems already ON the board per type, and
  // EMBED gems into the dealt pieces until onBoard + embedded ≥ the mission's remaining need
  // (per type). One gem per piece, placed on a (smaller-first) cleared-friendly piece so it
  // is easy to collect. The board.place path drops the gem onto the board when the piece is
  // placed; clearing its line collects it (same path as preset gem-in-block).
  if (ctx.gemDemand) {
    const onBoard = {};
    for (const g of board.items.values()) onBoard[g] = (onBoard[g] || 0) + 1;
    // remaining gems still needed per type (vs what's already on the board).
    const deficit = {};
    for (const [gem, need] of Object.entries(ctx.gemDemand)) { const d = need - (onBoard[gem] || 0); if (d > 0) deficit[gem] = d; }
    // GEM-BLOCK RATE ramps WITHIN the stage (USER REQ 2026-06-22): exactly ONE gem per block, but
    // the NUMBER of this tray's pieces that carry a gem grows as you progress through the gem goal
    // — early ~1 gem-block, late FREQUENTLY all 3. With variation so a plainer tray (fewer, or even
    // no, gem-blocks) still shows up sometimes (가끔 1개/안 박힌 블록도).
    // gem-block count per tray = a TARGET FREQUENCY (cfg.gemRate, fractional, scales with the
    // stage's difficulty/goal) rounded PROBABILISTICALLY each tray (USER REQ 2026-06-22): so a
    // 100-goal stage is FREQUENTLY all 3 (but not ALWAYS — high cfg.gemRate ⇒ mostly 3, sometimes
    // 2) and a small-goal stage is usually 1–2. (No within-stage fade — a too-low rate on a big
    // goal lengthens the stage and dead-ends; the probabilistic rounding alone gives the variety.)
    const target = Math.max(0.5, cfg.gemRate || 2);
    let rate = Math.floor(target) + (rng.float() < (target - Math.floor(target)) ? 1 : 0);
    rate = Math.max(1, Math.min(trayCount, rate));
    // fill smaller pieces first (easier to place + clear → easier to collect).
    const order = pieces.map((_, i) => i).sort((a, b) => pieces[a].cells.length - pieces[b].cells.length);
    let embedded = 0;
    for (const i of order) {
      if (embedded >= rate) break;
      const avail = Object.keys(deficit).filter((g) => deficit[g] > 0);
      if (!avail.length) break;
      const p = pieces[i];
      if (p.gem) continue;                              // one gem per piece (never multiple)
      const gem = avail[embedded % avail.length];       // round-robin the demanded gem types
      p.gem = gem; p.gemAt = p.cells[rng.int(p.cells.length)];
      deficit[gem]--; embedded++;
    }
  }

  return {
    pieces, mode, D, T, metrics, room,
    sampled, accepted,
    resamples: sampled - 1,        // back-compat field (telemetry/state())
    survivable: best.survivable,
    anyPlaceable: best.anyPlaceable,
    bounds: pieces.map(pieceBounds),
  };
}

// ── small math helpers ───────────────────────────────────────────────────────
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
function lerp(a, b, t) { return a + (b - a) * (t < 0 ? 0 : t > 1 ? 1 : t); }
