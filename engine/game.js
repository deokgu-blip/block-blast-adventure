// engine/game.js — MISSION · SCORE · COMBO · WIN/LOSS · EVENT EMIT (logic layer).
//
// The Game owns the Board + tray + feeder and exposes a small imperative API
// (placeAt / canPlaceAt / state). It is rendering-agnostic: it EMITS named events
// (onPlace, onLineClear, onPraise, onCombo, onMissionProgress, onDanger, onRescue,
// onStageClear, onGameOver) that the effects director + renderer subscribe to
// (GLOBAL A6 3-layer split; GAME_DESIGN §6).
//
// Deterministic: all randomness is in the seeded feeder RNG. No Date.now() here.

import { Board } from './board.js';
import { feedTray, computeMetrics, dangerScore } from './feeder.js';
import { mergeConfig, DEFAULT_CONFIG } from './config.js';
import { PIECE_BY_ID } from './pieces.js';
import { shapeColorKey } from './colors.js';
import { readPresetCell, collectTargets, comboGoals } from './schema.js';

export class Game {
  // level = normalized level (from schema.validateLevel), rng = seeded RNG.
  constructor(level, rng) {
    this.level = level;
    this.rng = rng;
    this.cfg = mergeConfig(DEFAULT_CONFIG, { feeder: level.feeder || {} });
    this.palette = level.palette;
    this.trayCount = this.cfg.tray.count;

    // onboarding tutorial (GAME_DESIGN §10): when enabled, the deterministic
    // fixedQueue replaces the adaptive feeder and the tutorial controller (not the
    // mission counter) decides stage-clear. All tutorial DATA lives in the level
    // json (steps/queue/preset) — the engine only consumes it (GLOBAL A1).
    this.tutorial = level.tutorial && level.tutorial.enabled ? level.tutorial : null;
    this._queuePtr = 0; // next index into tutorial.fixedQueue

    this.board = new Board(level.board.cols, level.board.rows);
    this._applyPreset(level);

    this.score = 0;
    this.combo = 0;
    this.noClearStreak = 0;     // consecutive no-clear placements; combo breaks at 3 (combo grace)
    this.moves = 0;             // pieces placed (a "move" per piece)
    this.tray = [];             // [{id,cells,color} | null]  (null = consumed)
    this.over = false;
    this.cleared = false;       // mission complete
    this.lastDanger = false;    // for onDanger edge detection

    // mission progress counters
    this.mission = level.mission;
    this.progress = this._initProgress();

    // listeners: event name -> [fn]
    this._listeners = Object.create(null);

    // first tray
    this._refillTray(/*initial*/ true);
    this._checkGameOver();
  }

  // ── event bus ──────────────────────────────────────────────────────────────
  on(evt, fn) { (this._listeners[evt] ||= []).push(fn); return this; }
  emit(evt, payload) { const ls = this._listeners[evt]; if (ls) for (const fn of ls) fn(payload); }

  // ── setup helpers ────────────────────────────────────────────────────────────
  _applyPreset(level) {
    // preset cells (read through the SSOT helper so legacy [x,y,color] arrays and
    // {x,y,color,gem?} objects behave identically). A preset cell with a `gem`
    // fills the block AND embeds the gem in the SAME cell (board.items), so the
    // gem rides inside the block and is collected when its row/col clears (§11.3).
    for (const raw of level.preset) {
      const c = readPresetCell(raw);
      if (!c) continue;
      const i = this.board.idx(c.x, c.y);
      this.board.cells[i] = c.color;
      if (c.gem != null) this.board.items.set(i, c.gem);
    }
    // legacy floating items[] (gem markers on EMPTY cells) still supported.
    for (const [x, y, item] of level.items) this.board.items.set(this.board.idx(x, y), item);
  }

  _initProgress() {
    const t = this.mission.target || {};
    switch (this.mission.type) {
      case 'collect': {
        // multi-gem collect (GAME_DESIGN §11.2): target may be a single
        // { item|gem, count } or an ARRAY of them. Normalize to a list of
        // { gem, got, need } so the HUD can show one icon+counter per gem.
        const targets = collectTargets(t).map((e) => ({ gem: e.gem, got: 0, need: e.count }));
        const need = targets.reduce((s, e) => s + e.need, 0);
        // `item` kept for back-compat (HUD single-icon path) = first gem.
        return { type: 'collect', targets, item: targets[0] ? targets[0].gem : undefined, got: 0, need };
      }
      // score: prefer target.score (§11), fall back to legacy target.count.
      case 'score':      return { type: 'score', got: 0, need: (t.score ?? t.count) };
      // combo (GAME_DESIGN §12.2): score AND gem goals at once, cleared ONLY when ALL
      // sub-goals are met. We carry a `score` sub-goal ({got,need}|null) and `targets[]`
      // (one {gem,got,need} per gem, just like collect) so the HUD can show the score
      // track AND the gem chip(s) together. `got/need` rolls up ALL sub-goals so the
      // footer progress bar (got/need) and old single-counter paths still work.
      case 'combo': {
        const cg = comboGoals(this.mission);
        const score = (cg.score != null) ? { got: 0, need: cg.score } : null;
        const targets = cg.collect.map((e) => ({ gem: e.gem, got: 0, need: e.count }));
        const need = (score ? score.need : 0) + targets.reduce((s, e) => s + e.need, 0);
        return { type: 'combo', score, targets, item: targets[0] ? targets[0].gem : undefined, got: 0, need };
      }
      case 'lines':      return { type: 'lines', got: 0, need: t.count };
      case 'clearCells': return { type: 'clearCells', got: 0, need: t.count };
      case 'survive':    return { type: 'survive', got: 0, need: t.moves ?? this.mission.moves };
      // tutorial: progress is tracked by the controller via steps, not a counter.
      // `need` is the step count; the controller calls markTutorialClear() at the end.
      case 'tutorial':   return { type: 'tutorial', got: 0, need: this.tutorial ? this.tutorial.steps.length : 1 };
      default:           return { type: this.mission.type, got: 0, need: 1 };
    }
  }

  // ── tray feeding ─────────────────────────────────────────────────────────────
  _refillTray() {
    // tutorial: deterministic — pull the next pieces from the fixedQueue instead
    // of running the adaptive feeder (GAME_DESIGN §10.2). Look-agnostic logic only.
    if (this.tutorial) return this._refillTrayFromQueue();

    // GEM-IN-QUEUE: tell the feeder how many MORE gems (per type) the mission still needs,
    // so it delivers gem-bearing pieces via the queue (collect/combo only). null otherwise.
    let gemDemand = null, gemProgress = 0, gemNeedTotal = 0;
    const pr = this.progress;
    if (pr && (pr.type === 'collect' || pr.type === 'combo') && pr.targets) {
      gemDemand = {};
      // Keep gems flowing GENEROUSLY (user req): don't deliver EXACTLY `need` gems — keep a
      // surplus in supply (remaining + SLACK) so gems keep appearing right up until the goal
      // is actually met, instead of vanishing as the remaining count drops to 0/1. The
      // feeder's per-refill embed cap still throttles flooding, so this just sustains supply.
      const GEM_SLACK = 3;
      let got = 0, need = 0;
      for (const t of pr.targets) { const r = Math.max(0, t.need - t.got); if (r > 0) gemDemand[t.gem] = r + GEM_SLACK; got += t.got; need += t.need; }
      // how far through the gem goal (0..1) → the feeder ramps the gem-block RATE within the
      // stage (USER REQ 2026-06-22): early few gem-blocks, late FREQUENTLY all 3.
      gemProgress = need > 0 ? Math.min(1, got / need) : 0;
      gemNeedTotal = need;    // the stage's TOTAL gem goal → feeder scales the gem-block rate by it
    }
    const res = feedTray(this.board, {
      rng: this.rng, cfg: this.cfg.feeder, score: this.score, combo: this.combo,
      stageIndex: this.level.index, palette: this.palette, trayCount: this.trayCount,
      gemDemand, gemProgress, gemNeedTotal,
    });
    this.tray = res.pieces.slice();
    this.lastFeed = res;       // telemetry for debug API / events
    // danger edge → onDanger (look layer pulses the board edge)
    if (res.D >= this.cfg.feeder.dangerHi && !this.lastDanger) {
      this.lastDanger = true;
      this.emit('onDanger', { D: res.D, mode: res.mode });
    } else if (res.D < this.cfg.feeder.dangerHi) {
      this.lastDanger = false;
    }
    return res;
  }

  // Deterministic tutorial feed: fill the tray (left→right) from the fixedQueue,
  // advancing a queue pointer. Colors follow the stage palette via shapeColorKey (same as the
  // feeder), so the tutorial queue matches the stage's theme — and STAGE 1 stays SINGLE-COLOR
  // (user req 2026-06-22): stagePalette(1) returns one key, so every tutorial piece is blue.
  _refillTrayFromQueue() {
    const q = this.tutorial.fixedQueue;
    const paletteKeys = Object.keys(this.palette);
    const tray = [];
    for (let s = 0; s < this.trayCount; s++) {
      const id = q[this._queuePtr % q.length];
      this._queuePtr++;
      const p = PIECE_BY_ID[id];
      tray.push(p ? { id: p.id, sizeTag: p.sizeTag, cells: p.cells, color: shapeColorKey(p.id, this.level.index, paletteKeys) } : null);
    }
    this.tray = tray;
    this.lastFeed = { mode: 'tutorial', D: 0, T: 0, survivable: true, anyPlaceable: true, resamples: 0 };
    return this.lastFeed;
  }

  trayEmpty() { return this.tray.every((p) => p == null); }

  // ── placement API (logical; QA + input both call this) ───────────────────────
  // Returns { ok, reason? , cleared?, score?, combo?, tier? }.
  canPlaceAt(trayIndex, x, y) {
    const piece = this.tray[trayIndex];
    if (!piece) return false;
    return this.board.canPlace(piece, x, y);
  }

  placeAt(trayIndex, x, y) {
    if (this.over || this.cleared) return { ok: false, reason: 'finished' };
    const piece = this.tray[trayIndex];
    if (!piece) return { ok: false, reason: 'empty-slot' };
    if (!this.board.canPlace(piece, x, y)) return { ok: false, reason: 'invalid' };

    // place
    const filled = this.board.place(piece, x, y, piece.color);
    // 따봉 INTENT (USER REQ 2026-06-22, ORIGINAL trigger restored): the feeder marks each dealt piece
    // with the GAP it was served for (piece.fitSpot = the best-clear origin on the spawn board).
    // Placing the piece AT that exact origin = "이 공간 때문에 나온 블록을 그 자리에 배치" → reward.
    const goodPlace = !!(piece.fitSpot && piece.fitSpot.x === x && piece.fitSpot.y === y);
    this.tray[trayIndex] = null;
    this.moves++;
    const placedCells = piece.cells.length;
    this.score += placedCells * this.cfg.score.perPlacedCell;

    // detect + clear lines simultaneously
    const lines = this.board.fullLines();
    const lineCount = lines.rows.length + lines.cols.length;
    let clearedInfo = null, tier = 0;

    if (lineCount > 0) {
      this.combo++;
      this.noClearStreak = 0;   // a clear keeps the combo alive (resets the no-clear grace window)
      const sc = this.cfg.score;
      // ADVENTURE-MODE SCORING (USER REQ 2026-06-22, confirmed from in-game data): there is NO
      // combo score multiplier — the clear score is JUST the line-clear bonus for #lines cleared
      // AT ONCE (1줄10·2줄30·3줄90·4줄270·5줄810·6줄2430), plus 1 per placed cell (added above).
      // this.combo is still tracked, but only for the combo BADGE feedback — it does not score.
      const comboMult = 1;   // no combo score bonus in Adventure mode
      const lineBonus = sc.lineClearBonus[Math.min(lineCount, sc.lineClearBonus.length - 1)];
      // capture the per-cell COLOR (palette key) BEFORE clearing so the look layer
      // can spray confetti shards tinted by each cleared block's color (§6). The
      // cells go to 0 in clearLines(), so this must happen first (look-agnostic data).
      const cellColors = this._cellColorsFor(lines);
      clearedInfo = this.board.clearLines(lines);
      let clearScore = lineBonus * comboMult;   // = lineBonus (no combo multiplier in Adventure)
      // perfect clear: emptying the whole board awards a big bonus (real BB = 360).
      if (this.board.filledCount() === 0) clearScore += sc.boardClearBonus;
      this.score += clearScore;

      tier = this._praiseTier(lineCount, this.combo, clearedInfo.cleared.length);

      // EPICENTER of the just-placed piece (board cell-center coords) — the FX layer ripples
      // the rainbow wave OUTWARD from here (user req 2026-06-18: "블록 놓은 곳 기준으로 퍼져나감").
      let osx = 0, osy = 0; for (const [dx, dy] of piece.cells) { osx += x + dx + 0.5; osy += y + dy + 0.5; }
      const origin = { x: osx / piece.cells.length, y: osy / piece.cells.length };

      // events for the look layer
      this.emit('onLineClear', {
        lines: lineCount, rows: lines.rows, cols: lines.cols, origin,
        cells: clearedInfo.cleared, cellColors, clearScore, combo: this.combo, comboMult,
        // gems collected by THIS clear (cell index + gem id), so the FX layer can fly
        // each one from its board cell up to the mission counter. Empty when none.
        // This is look-agnostic DATA: the LOGICAL mission count still updates below in
        // _applyClearToMission (the source of truth for winning); the FX flight only
        // drives the DISPLAYED count via opts.onGemArrive (index.html). (§11.3)
        gems: clearedInfo.items.map((it) => ({ cell: it.cell, gem: it.item })),
      });
      // PRAISE BANNER gating (task B): a 1-line clear shows NO praise TEXT (just the
      // particle / line burst). Only a 2+ line clear is "big enough" to deserve the
      // banner — so onPraise fires ONLY when lineCount >= 2. (The combo badge via
      // onCombo is a SEPARATE cue and is intentionally left on its own >=2 gate below.)
      if (lineCount >= 2) this.emit('onPraise', { tier, label: this._praiseLabel(tier) });
      if (this.combo >= 2) this.emit('onCombo', { combo: this.combo });

      // rescue detection: we were in danger and a clear saved us
      if (this.lastFeed && this.lastFeed.mode === 'rescue') {
        this.emit('onRescue', { combo: this.combo, lines: lineCount });
      }

      // mission progress from clears (collect / lines / clearCells / score handled below)
      this._applyClearToMission(clearedInfo, lineCount);
    } else {
      // COMBO RESET (USER REQ 2026-06-26: "콤보 리셋 버그 고쳐"): a non-clearing placement breaks the
      // combo immediately (combo = consecutive clears, classic block-puzzle behaviour).
      // NOTE: this REVERSES the earlier 2026-06-22 "3-move grace" (which let combos build over a few
      // moves). Combo is feedback-only (no score multiplier in Adventure), so this changes the combo
      // BADGE/praise cadence, not balance. To restore the grace, gate this on `noClearStreak >= 3`.
      this.noClearStreak++;
      this.combo = 0;
      this.emit('onPlace', { cells: filled, color: piece.color });
    }

    // 따봉 REWARD: placed the queue's gap-piece at its intended spot. Emitted AFTER the clear branch
    // so the FX clear-removal doesn't kill it; it pops on the placed block (which may also be
    // clearing/vanishing), arcs down, ~0.8s, then fades.
    if (goodPlace) this.emit('onGoodPlace', { cells: filled, color: piece.color });

    // score / survive missions tick on every placement
    this._applyMoveToMission();

    // refill tray when all three consumed. This stays SYNCHRONOUS + LOGICAL (no
    // timers here — QA determinism depends on game.tray already holding the new
    // pieces). We report `refilled` so the HOST can VISUALLY delay the new tray's
    // appearance by a clear-anim beat (FIX C); the logical state is unchanged.
    let refilled = false;
    if (this.trayEmpty()) { this._refillTray(); refilled = true; }

    // win / lose checks
    this._checkMissionClear();
    if (!this.cleared) this._checkGameOver();

    return {
      ok: true, cleared: clearedInfo ? clearedInfo.cleared.length : 0,
      lines: lineCount, score: this.score, combo: this.combo, tier,
      refilled, // true iff this placement consumed the last tray piece → tray refilled
      mission: { ...this.progress }, over: this.over, stageClear: this.cleared,
    };
  }

  // Map each soon-to-be-cleared cell index → its palette KEY (block color), read
  // from the board before clearLines() zeroes it. Used by the FX confetti so each
  // shard matches the block it came from (look-agnostic: returns keys, not pixels).
  _cellColorsFor(lines) {
    const out = {};
    for (const y of lines.rows) for (let x = 0; x < this.board.cols; x++) { const i = this.board.idx(x, y); out[i] = this.board.cells[i]; }
    for (const x of lines.cols) for (let y = 0; y < this.board.rows; y++) { const i = this.board.idx(x, y); out[i] = this.board.cells[i]; }
    return out;
  }

  // ── praise tier (§6) — 5 tiers mapping to the 5 praise sprites ────────────────
  // tier1 good · 2 great · 3 fantastic · 4 perfect · 5 legendary, from lines+combo.
  // The "intensity" = max(lines, combo): a single line / combo-1 reads as Good and
  // it climbs as the player chains clears or wipes multiple lines at once.
  _praiseTier(lines, combo, clearedCells) {
    const n = Math.max(lines, combo);
    if (n >= 5) return 5;   // legendary
    if (n >= 4) return 4;   // perfect
    if (n >= 3) return 3;   // fantastic
    if (n >= 2) return 2;   // great
    return 1;               // good
  }
  _praiseLabel(tier) {
    const p = this.cfg.effects.praise;
    return p['t' + Math.max(1, Math.min(5, tier))] || p.t1;
  }

  // ── mission accounting ────────────────────────────────────────────────────────
  // Tally gems from a clear into a list of {gem,got,need} targets. Returns the list
  // of {gem,n} actually collected this clear (for the gem-fly FX), or [] if none.
  // Shared by `collect` and `combo` so the gem-in-block accounting never drifts.
  _tallyGems(targets, clearedInfo) {
    const collected = [];
    for (const tgt of targets) {
      const got = clearedInfo.items.filter((it) => it.item === tgt.gem).length;
      if (got > 0) {
        tgt.got = Math.min(tgt.need, tgt.got + got);
        collected.push({ gem: tgt.gem, n: got });
      }
    }
    return collected;
  }

  _applyClearToMission(clearedInfo, lineCount) {
    const pr = this.progress;
    let changed = false;
    if (pr.type === 'collect') {
      // tally collected gems per-target (multi-gem), then roll up the total. Items
      // collected here come from board.items, which holds BOTH embedded preset gems
      // and legacy floating markers (board.clearLines collected them on the clear).
      const collected = this._tallyGems(pr.targets, clearedInfo);
      if (collected.length > 0) {
        changed = true;
        pr.got = pr.targets.reduce((s, e) => s + e.got, 0);
        // expose which gems were collected this clear (FX: gems fly to the counter).
        this._lastCollected = collected;
      }
    } else if (pr.type === 'combo') {
      // combo (GAME_DESIGN §12.2): the collect part advances on clears (same as
      // `collect`); the score part advances on every placement in _applyMoveToMission.
      const collected = this._tallyGems(pr.targets, clearedInfo);
      if (collected.length > 0) {
        changed = true;
        this._lastCollected = collected;
      }
      // roll up score-sub-goal-progress + gem-progress so the footer bar tracks the whole.
      pr.got = (pr.score ? pr.score.got : 0) + pr.targets.reduce((s, e) => s + e.got, 0);
    } else if (pr.type === 'lines') {
      pr.got = Math.min(pr.need, pr.got + lineCount); changed = true;
    } else if (pr.type === 'clearCells') {
      // count cleared cells that were preset "special" (have an item OR were preset)
      const special = clearedInfo.items.length || clearedInfo.cleared.length;
      pr.got = Math.min(pr.need, pr.got + (clearedInfo.items.length || 0)); changed = special > 0;
      // (clearCells uses items[] as the special-block markers in this POC)
    }
    if (changed) this.emit('onMissionProgress', { ...pr });
  }

  _applyMoveToMission() {
    const pr = this.progress;
    if (pr.type === 'score') {
      const v = Math.min(pr.need, this.score);
      if (v !== pr.got) { pr.got = v; this.emit('onMissionProgress', { ...pr }); }
    } else if (pr.type === 'combo') {
      // combo (GAME_DESIGN §12.2): the SCORE sub-goal ticks on every placement; the
      // gem sub-goals already ticked on clears. Roll up the total (score + gems).
      if (pr.score) {
        const v = Math.min(pr.score.need, this.score);
        if (v !== pr.score.got) {
          pr.score.got = v;
          pr.got = pr.score.got + pr.targets.reduce((s, e) => s + e.got, 0);
          this.emit('onMissionProgress', { ...pr });
        }
      }
    } else if (pr.type === 'survive') {
      pr.got = Math.min(pr.need, this.moves);
      this.emit('onMissionProgress', { ...pr });
    }
  }

  _checkMissionClear() {
    if (this.cleared) return;
    // tutorial clears only when the controller completes the last step (see
    // markTutorialClear); never auto-clear from a counter (GAME_DESIGN §10.3).
    if (this.progress.type === 'tutorial') return;
    let done;
    if (this.progress.type === 'combo') {
      // combo (GAME_DESIGN §12.2): cleared ONLY when EVERY sub-goal is met — the score
      // sub-goal AND each gem target. (got/need rolls these up, but we check each goal
      // explicitly so a partial-but-equal rollup can never falsely clear.)
      const pr = this.progress;
      const scoreDone = !pr.score || pr.score.got >= pr.score.need;
      const gemsDone = pr.targets.every((t) => t.got >= t.need);
      done = scoreDone && gemsDone;
    } else {
      done = this.progress.got >= this.progress.need;
    }
    if (done) {
      this.cleared = true;
      this.emit('onStageClear', { score: this.score, moves: this.moves, mission: { ...this.progress } });
    }
  }

  // Called by the tutorial controller when the LAST step completes → stage clear.
  // (Tutorial is failure-proof, so this is the only victory path for an onboarding.)
  markTutorialClear() {
    if (this.cleared) return;
    this.cleared = true;
    this.progress.got = this.progress.need;
    this.emit('onStageClear', { score: this.score, moves: this.moves, mission: { ...this.progress } });
  }

  // Advance the tutorial step counter (for HUD progress + state snapshots). The
  // controller owns step logic; this just records how far we are.
  setTutorialStep(stepIndex) {
    if (this.progress.type !== 'tutorial') return;
    this.progress.got = Math.min(this.progress.need, stepIndex);
    this.emit('onMissionProgress', { ...this.progress });
  }

  _checkGameOver() {
    if (this.cleared || this.over) return;
    if (this.tutorial) return; // onboarding is failure-proof (GAME_DESIGN §10.2)
    // game over when NO remaining tray piece can be placed anywhere
    const remaining = this.tray.filter((p) => p != null);
    if (remaining.length === 0) return; // tray will be refilled
    const anyPlaceable = remaining.some((p) => this.board.hasAnyFit(p));
    if (!anyPlaceable) {
      this.over = true;
      // include the board occupancy so the FX layer can FILL the empty cells bottom→top (⑩).
      this.emit('onGameOver', { score: this.score, moves: this.moves,
        cells: this.board.cells.slice(), cols: this.board.cols, rows: this.board.rows });
    }
  }

  // ── state snapshot for debug API / renderer ───────────────────────────────────
  state() {
    const m = computeMetrics(this.board, this.cfg.feeder);
    return {
      cols: this.board.cols, rows: this.board.rows,
      cells: this.board.cells.slice(),
      items: [...this.board.items.entries()].map(([cell, item]) => ({ cell, item })),
      palette: this.palette,
      tray: this.tray.map((p) => p ? { id: p.id, cells: p.cells, color: p.color } : null),
      score: this.score, combo: this.combo, moves: this.moves,
      // deep-copy mission so the multi-gem `targets[]` (collect + combo) AND the combo
      // `score` sub-goal survive the snapshot (the HUD renders the score track AND one
      // icon+counter per gem target — GAME_DESIGN §12.2).
      mission: {
        ...this.progress,
        targets: this.progress.targets ? this.progress.targets.map((t) => ({ ...t })) : undefined,
        score: this.progress.score ? { ...this.progress.score } : this.progress.score,
      },
      tutorial: this.tutorial ? { enabled: true, steps: this.tutorial.steps.length } : null,
      over: this.over, stageClear: this.cleared,
      danger: dangerScore(m, this.cfg.feeder),
      metrics: m,
      lastFeed: this.lastFeed ? {
        mode: this.lastFeed.mode, D: this.lastFeed.D, T: this.lastFeed.T,
        survivable: this.lastFeed.survivable, resamples: this.lastFeed.resamples,
      } : null,
    };
  }
}
