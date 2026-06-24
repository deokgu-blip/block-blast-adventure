// engine/config.js — DEFAULT TUNABLES (data layer, GLOBAL A1).
// The engine NEVER hardcodes feeder/score/effect numbers; it reads them from here.
// A level json may override any sub-tree (deep-merged at load) — e.g. level.feeder.
// Keep this file purely declarative: no logic, no per-frame allocation.

export const DEFAULT_CONFIG = {
  // ── scoring & combo (GAME_DESIGN §3) ───────────────────────────────────────
  score: {
    // ── matches the real Block Blast scoring (researched 2026-06-18) ──
    perPlacedCell: 1,        // placing: +1 per cell of the placed piece (measured in-game)
    // line-clear BONUS by how many lines clear AT ONCE. index = #lines. DERIVED FROM REAL
    // ADVENTURE-MODE DATA (USER 2026-06-22): 1줄=10, 2줄=30, 3줄=90 (≈ ×3 per extra line).
    // 4–6 are extrapolated ×3 (rare clears; confirm if exact values matter).
    lineClearBonus: [0, 10, 30, 90, 270, 810, 2430],
    boardClearBonus: 360,    // perfect clear (board fully emptied by a clear) → +360
    // NOTE: Adventure mode applies NO combo multiplier to the score (combo is a streak/badge
    // counter only) — see game.js. comboStep kept for any future endless-mode use.
    comboStep: 0.5,
  },

  // ── adaptive feeder (GAME_DESIGN §4) — all weights are data ────────────────
  feeder: {
    // danger D weights:  D = clamp(wf*fill + wg*frag + wn*nearLineDanger - wh*placeableShapeRatio)
    wf: 0.6, wg: 0.25, wn: 0.3, wh: 0.4,
    nearAlmostK: 2,          // a row/col is "near-full" when it has <= k empty cells
    nearDangerScale: 0.35,   // contribution of one near-full line to D

    // EASIER tuning (CHANGE 2 — "game is too hard"): RESCUE triggers EARLIER (lower
    // dangerHi) so the feeder bails the player out before the board truly chokes, and
    // PRESSURE almost never engages (raised pressureTmin + gutted death/weight knobs).
    dangerHi: 0.48,          // EASIER (㉓): rescue triggers even earlier (was 0.58)
    dangerLo: 0.40,          // D <= dangerLo (&& T high) → PRESSURE mode

    // skill / difficulty target T  ∈ [0, Tmax] — GENTLER ramps (CHANGE 2): T climbs
    // far more slowly with stage/score and caps lower, so the game stays easy longer.
    Tmax: 0.42,              // EASIER (㉓): lower difficulty ceiling (was 0.55)
    rampPerStage: 0.013,     // EASIER (㉓): gentler stage ramp (was 0.02)
    rampPerScore: 2.5e-5,    // EASIER (㉓): gentler score ramp (was 4e-5)
    pressureTmin: 0.9,       // (was 0.5) PRESSURE only when T >= this — with Tmax=0.55 this
                             //   makes PRESSURE effectively UNREACHABLE in normal play (rare tension only)

    // weight shaping multipliers (applied to base pool weights)
    rescueWeight: 7.0,       // EASIER (㉓): much stronger bail-out (was 5.0)
    pressUpWeight: 1.3,      // (was 1.8) big/awkward pieces, in PRESSURE — softened (PRESSURE is rare anyway)
    rescueBigPenalty: 0.22,  // EASIER (㉓): big pieces de-weighted harder in RESCUE (was 0.3)
    pressClearPenalty: 0.5,  // line-clearing pieces de-weighted in PRESSURE
    sizeBias: 0.85,          // EASIER (㉓): favour SMALLER (easier-to-fit) pieces in MID (was 1.0)
    // MID-mode line-clear bias (CHANGE 2 — more dopamine): in MID, multiply the weight
    // of any piece that can IMMEDIATELY clear ≥1 line at its best spot, so satisfying
    // clears happen FREQUENTLY (not only in rescue). Kept moderate so it doesn't force
    // a clear every placement (variety preserved).
    // LOWERED (user req 2026-06-18 "여러 줄 동시 클리어가 드물다"): a strong single-clear bias
    // clears lines one-at-a-time before they can pile up, so multi-line setups rarely form.
    // Softening it lets near-full lines ACCUMULATE → the multiClear* weights below then pick
    // sets that wipe several at once (more satisfying multi-clears).
    midClearWeight: 1.85,    // (was 2.2) ×weight for a MID piece that can clear a line right now
                             //   — softened (lines accumulate → more multi-clears) but NOT so low
                             //   that score stages stall/choke (1.5 made them unclearable).

    // joint-survivability guard (DFS depth = trayCount). EASIER (CHANGE 2): both floors
    // raised toward 1.0 so feeds are almost always fully survivable → dead-ends very rare.
    mercy: 1.0,              // EASIER (㉓): ALWAYS try to guarantee a survivable set (was 0.99)
    surviveProbHi: 1.0,      // required survive-prob when D is high → always guarantee
    surviveProbLo: 0.98,     // EASIER (㉓): almost always fully survivable even when safe (was 0.92)
    resampleMax: 16,         // EASIER (㉓): more attempts to find a survivable set (was 12)
    pressureDeathChance: 0.0, // (was 0.08) PRESSURE never deliberately serves a deadly set now

    // ── best-of-N candidate sampling (replaces "first acceptable set") ─────────
    // Each refill samples `sampleCount` candidate sets from the space-aware
    // per-piece weights, scores them, and keeps the best. Perf budget: feedTray
    // runs ONCE per 3-piece refill (never per frame). Each candidate costs one
    // setIsSurvivable DFS + (when scored) one bounded setMaxClear DFS. With the
    // caps below a refill stays well under ~30ms on a mid phone. Keep 16–24.
    sampleCount: 24,         // (was 16) # of candidate sets sampled per refill (bounded
                             // search, 16–24). EASIER (CHANGE 2): the TOP of the range so
                             // best-of-N finds more survivable + better-fitting sets →
                             // longer lifespans / fewer dead-ends. ~18ms max on a dev Mac
                             // (still within the ~30ms per-refill budget on a mid phone).

    // ── space-aware BIG-BOX bias (USER REQ #2) ────────────────────────────────
    // "roominess" R = clamp01(maxEmptyRegion/totalEmpty), i.e. how much of the free
    // space is one big connected blob. R≈1 → wide open; R→0 → chopped islands.
    // We also gate on fill: a board past `roomyFillMax` is never "roomy" however
    // connected its scraps are. Big boxes (square3/rect2x3/rect3x2) get their
    // weight scaled up by up to `bigBoxWeightRoomy×` as roominess rises, and DOWN
    // toward `bigBoxWeightTight×` on a tight board so small pieces that actually
    // fit dominate. This is what fixes the "답답/cramped" feel: SPACE governs size,
    // not just the difficulty target T.
    roomyRegionFrac: 0.55,   // R at/above this counts as "roomy" (full big-box boost)
    roomyFillMax: 0.55,      // fill at/above this is never roomy (hard cap on bigness)
    // CLEARABILITY GUARANTEE (USER REQ 2026-06-18): once the board is at/above this fill,
    // the dealt tray MUST be able to clear ≥1 line (else the player gets stranded). The
    // feeder prefers, and if needed force-resamples, a survivable CLEARING set on such boards.
    clearGuaranteeFill: 0.34, // EASIER (㉓): guarantee a clearing tray at a LOWER fill (was 0.40)
    // diagonal (corner-connected) pieces appear but are RARER — they're awkward to clear
    // lines with, so a full weight inflated variance + destabilized tuning. <1 = rarer.
    diagWeight: 0.32,
    unfitPenalty: 0.006,     // ㉕/㉛: weight ×this for a piece that can't be placed on the CURRENT
                             //   board (any orientation) → unplaceable orientations almost never served
    scoreFitsNow: 3.5,       // ㉛ + USER REQ 2026-06-22 (빈칸 딱 맞는 블록 가중치↑): bonus per tray piece that FITS the board now (was 2.0)
    scoreAllFit: 7.0,        // ㉛ + USER REQ: bigger bonus when ALL tray pieces fit now — snug gap-filling queues (was 4.0)
    bigBoxWeightRoomy: 4.2,  // big-box mult on a fully ROOMY board (USER REQ: 빈칸 많을 때 3×3·2×3 자주, was 3.4)
    bigBoxWeightTight: 0.12, // EASIER (㉓): big boxes even rarer on tight boards (was 0.18)
    // USER REQ 2026-06-22 — single 1×1 (dot) appears MUCH less (trivializes a slot + isn't satisfying).
    dotWeight: 0.07,         // weight ×this for the 'dot' piece (heavy de-weight)
    // USER REQ 2026-06-22 — on a TIGHT board serve at most `bigPieceCap` big ('l') pieces per tray.
    // 2+ big pieces with little room → one misplacement strands the rest = instant game-over
    // ("2스테이지 1개만 잘못 놔도 아웃"). The per-set penalty is SCALED BY TIGHTNESS (1-room):
    // roomy boards pay ~0 (big boxes stay common), tight boards strongly avoid 2+ big pieces.
    bigPieceCap: 1,
    bigPieceOverPenalty: 12.0,
    midSmallBiasRoomy: 0.35, // on roomy boards, damp MID's small-piece preference→0.35×
                             // (so SPACE, not T, drives size; 1 = old T-only behaviour)

    // ── multi-line-clear queue bias (USER REQ #3) ─────────────────────────────
    // setMaxClear(board,set) = bounded DFS over placing ALL pieces (best order/
    // positions) → max TOTAL lines clearable. We reward candidate sets whose
    // combined potential is high, ESPECIALLY when near-full lines already exist.
    // RAISED (user req 2026-06-18 "여러 줄 동시 클리어 더 자주"): strongly prefer candidate
    // sets that can wipe MULTIPLE lines at once, especially when near-full lines exist — so
    // big satisfying clears come up often (paired with the lower midClearWeight that lets
    // lines accumulate).
    multiClearWeight: 4.0,        // USER REQ 2026-06-22 (큐 2~3개로 여러 줄 깨는 조합 자주): score weight per clearable line of the COMBO set (was 2.2)
    multiClearNearLineBoost: 4.6, // ×multiClearWeight when near-full lines exist (was 3.4)
    multiClearCap: 6,             // ignore clear potential beyond this (diminishing)
    // setMaxClear search bounds (perf): cap positions tried per piece + total nodes.
    // These two caps bound the heaviest scenario (open board + a contiguous block of
    // near-full lines, where big boxes chain clears). Measured warm on a dev Mac:
    // that case is ~12ms avg / ~16ms max per refill at these caps — comfortably under
    // the ~30ms budget with headroom for slower mid phones. Most boards are <3ms.
    maxClearPosCap: 32,           // max placements explored per piece (best-first slice)
    maxClearNodeCap: 600,         // hard node budget for the whole DFS (early-out)

    // ── candidate scoring weights (best-of-N) ─────────────────────────────────
    // score = survivableBonus + multiClear*W + bigBoxProfile*W (+ rescue/pressure
    // shaping already baked into the per-piece weights). Survivability stays a HARD
    // requirement whenever wantSurvive (we only fall back to best-effort like before).
    scoreSurvivable: 5.0,    // additive bonus for a fully-survivable candidate
    scoreAnyPlaceable: 1.0,  // additive bonus for "at least one piece fits"
    scoreSizeProfile: 1.6,   // weight on the size-profile↔roominess match term
    scoreRescueClear: 2.2,   // RESCUE: extra reward per immediately-clearable piece

    seed: 0,                 // 0 = auto (Date-based) at load; QA passes an explicit seed
  },

  // ── tray / board defaults (a level may override board dims) ────────────────
  tray: { count: 3 },

  // ── effects director: event → tier/timing table (look-agnostic) ────────────
  // Visuals are API sprite assets (praise banners / confetti / line glow / combo
  // label) — the director only PLACES + TIMES them (GLOBAL C6/C7). These are the
  // tier labels (used for accessibility / fallback) and the timing budget.
  effects: {
    // 5 praise tiers → 5 sprites (praise_{good,great,fantastic,perfect,legendary}).
    praise: { t1: 'Good', t2: 'Great', t3: 'Fantastic', t4: 'Perfect', t5: 'Legendary' },
    flashMs: 220,            // cleared-cell line-glow duration
    popupMs: 800,            // "+score" popup lifetime
    ribbonMs: 1000,          // praise banner lifetime
    confettiMs: 800,         // confetti shard lifetime (spray-up + gravity, cleanup ~0.8s)
    placeConfettiMs: 360,    // PLACE specks lifetime — TINY + SHORT pop on placement (CHANGE 1)
    fragmentMs: 520,         // cleared-cell "shatter remains" fragment lifetime (CHANGE 2)
    bannerMs: 0,             // stage-clear banner persists (host overlay clears it)
    gemFlyMs: 520,           // collected-gem flight cell→counter (DISPLAYED count ticks on arrival)
    gemFlyStaggerMs: 70,     // delay between successive gems so a multi-gem clear cascades
    // FIX C — when a placement consumes the LAST tray piece, the logical tray refills
    // synchronously (QA determinism), but the HOST holds the NEW pieces' VISUAL reveal
    // for this beat so the player first sees the last block land + its line clear, then
    // the fresh queue pops/fades in. ~one clear-anim beat (flash 220 + confetti settle).
    trayRefillRevealMs: 420, // host-only visual delay before the refilled tray appears
  },
};

// Deep-merge a level override into the defaults (returns a new object).
// Arrays and primitives are replaced; plain objects are merged.
export function mergeConfig(base, override) {
  if (!override) return structuredClone(base);
  const out = structuredClone(base);
  for (const k of Object.keys(override)) {
    const ov = override[k];
    if (ov && typeof ov === 'object' && !Array.isArray(ov) &&
        out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
      out[k] = mergeConfig(out[k], ov);
    } else {
      out[k] = structuredClone(ov);
    }
  }
  return out;
}
