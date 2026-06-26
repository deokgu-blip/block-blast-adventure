// engine/effects.js — EFFECTS DIRECTOR (GAME_DESIGN §6, GLOBAL C6/C7).
//
// Subscribes to the Game's events and PLAYS API-generated sprite assets. The
// director only does PLACEMENT · TIMING · TWEENS — it never draws procedural
// shapes/particles; every visual is an <img> from assets/effects|sprites. The
// trigger LOGIC (which event, which tier, when) lives in game.js; this file is a
// swappable look layer (assets + timing only) so the same logic can drive a
// different art set by changing FX_ASSETS / the CSS.
//
// Geometry SSOT (CRITICAL): line glow + confetti origins read the SAME cell grid
// the blocks use, via opts.cellRectOf / opts.lineRectOf (which come from the
// renderer's cellSize/cellOrigin). Nothing here invents its own grid, so a new
// visual can never drift from where the blocks actually sit (L12).
//
// Perf (L13/L57): confetti runs on ONE rAF loop over a FIXED-SIZE particle pool —
// no per-frame allocation, elements are recycled, and the loop stops when idle so
// it never leaks. Praise/combo/popup are short-lived DOM that self-remove.

import { gemFileFor } from './renderer.js';

// asset paths are RELATIVE (static-servable + inline-friendly, GLOBAL A3).
const FX = 'assets/effects/';
const BLK_SPRITE = 'assets/sprites/block_b.webp';   // uniform block sprite (㊻ zoom + falling blocks)
const SPR = 'assets/sprites/';

// ── STAGE-CLEAR SEQUENCE timings (small named constants, all ms — task spec) ──
// 1) GRID SWEEP: each board ROW plays a traveling neon glow, alternating direction
//    (row 0 →, row 1 ←, …), rows staggered top→bottom so the whole 8-row sweep takes
//    ROW_STAGGER*(rows-1) + CELL_STEP*(cols-1) + GLOW_LIFE ≈ 1.0–1.4s.
const SC = {
  ROW_STAGGER: 60,     // gap between successive rows starting (downward cascade)
  CELL_STEP: 22,       // gap between successive cells lighting within a row
  GLOW_LIFE: 300,      // how long each cell's neon glow stays lit (fade out)
  // → 8-row sweep total ≈ 7*60 + 7*22 + 300 ≈ 875ms (snappier lead-in).
  // 2) FULL-SCREEN DIMMED "Well Done" layer fades in after the sweep, and the gems +
  //    Well Done text + progress bar + confetti ALL enter at once (each its own anim).
  //    The Next button appears ONE BEAT after every entrance finishes (kept short so it
  //    is not slow to appear — user feedback).
  LAYER_FADE: 250,     // overlay (dim + content) fade-in
  BAR_FILL: 280,       // progress bar empty→full (RAPID, purple)
  BAR_CYCLE: 300,      // at full: color cycle orange→red→blue→green→purple (blinking)
  CHAR_STAGGER: 34,    // per-letter delay in the "Well Done!" pop
  CHAR_POP: 300,       // each letter's small→big pop duration
  GEM_POP: 360,        // decorative center gems pop-in
  NEXT_BEAT: 90,       // Next button appears this long AFTER all entrances finish
};
// "Well Done!" rendered per-letter (small→big pop). Defined once so the DOM build and the
// Next-button timing (which waits for the last letter) stay in sync.
const WELLDONE_TEXT = 'Well Done!';

// praise tier (1..5) → banner sprite (good/great/fantastic/perfect/legendary).
const PRAISE_SPRITE = {
  1: FX + 'praise_good.webp', 2: FX + 'praise_great.webp', 3: FX + 'praise_fantastic.webp',
  4: FX + 'praise_perfect.webp', 5: FX + 'praise_legendary.webp',
};
// confetti shard sprite per palette KEY (matches each cleared block's color).
const SHARD_SPRITE = {
  r: FX + 'fx_shard_r.webp', o: FX + 'fx_shard_o.webp', y: FX + 'fx_shard_y.webp',
  g: FX + 'fx_shard_g.webp', b: FX + 'fx_shard_b.webp', p: FX + 'fx_shard_p.webp',
};
// sparkle / star / diamond accents sprinkled into the confetti spray.
const ACCENT_SPRITE = [FX + 'fx_sparkle.webp', FX + 'fx_star.webp', FX + 'fx_diamond.webp'];
// per-palette GLOW color (rgb triplet) for the contained line-clear fill glow — keyed to
// the cleared block's COLOR so the glow matches the blocks (NOT white). Used as a CSS var
// (--glow) by .fx-lineburst-glow so the soft fill reads as "this blue line burst".
const GLOW_RGB = {
  r: '255,92,92', o: '255,150,52', y: '255,214,61',
  g: '74,200,130', b: '74,150,255', p: '170,110,255',
};
// MULTI-line clear: rainbow candy shard + rainbow mini-block (CHANGE 2 — 2+ lines).
const RAINBOW_SHARD = FX + 'fx_shard_rainbow.webp';
const RAINBOW_BLOCK = SPR + 'block_rainbow.webp';
// THUMBS-UP reward (USER REQ 2026-06-22 따봉): a small block-colored thumbs-up pops on EACH cell
// of a piece dropped in its feeder-intended gap, then fades (~2s). The base sprite is near-WHITE
// so a per-color MULTIPLY tint (pre-rendered + cached, like the rainbow wave) yields a LIGHT
// version of the block color — blue block → light-blue 따봉, orange → light-orange (user req:
// "블록과 색감이 일치 — 파랑→연한 파란 따봉 / 주황→연한 주황 따봉").
const THUMB_SPRITE = FX + 'thumbsup.webp';
const THUMB_TINT = {
  r: '255,150,150', o: '255,190,130', y: '255,232,140', g: '150,225,170',
  b: '150,200,255', p: '205,170,255', c: '150,222,235',
};

export class EffectsDirector {
  // host = the #fx layer (inside #stage); renderer = look layer; cfg = config.effects;
  // opts = {
  //   cellRectOf(cellIndex) -> {x,y,w,h}   // CSS rect of a board cell in #stage
  //   lineRectOf('row'|'col', index) -> {x,y,w,h}  // CSS rect spanning a cleared line
  //   counterPosOf(gemId) -> {x,y}         // center of that gem's HUD chip in #stage coords
  //   onGemArrive(gemId)                   // called when a flying gem reaches the counter
  // }
  constructor(host, renderer, cfg, opts) {
    this.host = host;
    this.renderer = renderer;
    this.cfg = cfg;
    this.cellRectOf = opts.cellRectOf;
    this.lineRectOf = opts.lineRectOf;
    // collect-animation hooks (optional; the FX stays a pure look layer — if these
    // are absent the gems just don't fly and the host updates the count itself).
    this.counterPosOf = opts.counterPosOf || null;
    this.onGemArrive = opts.onGemArrive || null;
    // SCORE-GAIN hooks (score/combo missions only — gated by setScoreMode). scoreBarPosOf
    // returns the score-bar marker CENTER (in #stage coords) the score-fly lands on;
    // onScoreArrive(amount) ticks the host's DEFERRED displayed score up on arrival. Both
    // optional — absent → the score-gain FX silently no-ops (pure look layer, A6).
    this.scoreBarPosOf = opts.scoreBarPosOf || null;
    this.onScoreArrive = opts.onScoreArrive || null;
    this.scoreMode = false;   // only score/combo stages fire the tiered +N → bar fly
    // flying-gem layer (above confetti); short-lived self-removing <img>s (few gems).
    this.gemFlyHost = document.createElement('div');
    this.gemFlyHost.className = 'fx-gemfly-layer';
    this.host.appendChild(this.gemFlyHost);
    // SCORE-GAIN layer (ABOVE the gem-fly / burst layers): hosts the tiered "+N" popups
    // that pop at the gain location then fly into the top score bar. Short-lived self-
    // removing <div>s; cleared on load (clearBanner drops its DOM) and aborted on reload
    // via the SHARED _gemFlightGen generation counter (a stale fly removes silently and
    // never calls a stale onScoreArrive).
    this.scoreGainHost = document.createElement('div');
    this.scoreGainHost.className = 'fx-scoregain-layer';
    this.host.appendChild(this.scoreGainHost);
    this._gemFlightGen = 0; // bumped on each level load so stale flights stop cleanly
    // (NOTE 2026-06-23) the per-cell rainbow snapshot wave was replaced by a SINGLE rainbow
    // SWEEP over the cleared bounding box (_rainbowWaveBurst), so the offscreen spectrum-block
    // sprite cache it used (_buildRwTinted/_rwTinted) is no longer needed and was removed.

    // ── line-clear PREVIEW layer (CHANGE 1) ──────────────────────────────────
    // While a piece is being DRAGGED to a VALID spot that WOULD complete row(s)/
    // col(s), we frame exactly those lines with a THIN ORANGE NEON OUTLINE (a
    // predictive "drop here = these clear" cue), BEFORE release. NOT a fill over
    // the cells (the old white capsule fill obscured the blocks — user disliked it):
    // it's a rounded-rect BORDER with an outer glow, transparent inside, so the
    // blocks stay fully visible and it clearly reads as "this line will clear".
    // Distinct from the post-clear burst (_lineGlow, a sprite fill). The preview
    // elements are <div> frames REUSED from a small keyed map (no DOM leak):
    // showLinePreview reconciles the set of outlined lines, hideLinePreview drops
    // them. Updated only when the ghost cell changes (the caller gates this — see
    // input.js _updateBoardGhost), so no per-pixel work.
    this.previewHost = document.createElement('div');
    this.previewHost.className = 'fx-linepreview-layer';
    this.host.appendChild(this.previewHost);
    this._previewEls = new Map();   // key 'row:y' | 'col:x' -> reused <img> element
    this._previewShown = '';        // signature of the currently-shown line set (skip no-ops)

    // ── confetti pool (fixed size; recycled; no per-frame alloc — L13) ──
    this.poolSize = 64;
    this.pool = [];           // [{el, active, x,y,vx,vy,rot,vr, born, life}]
    this.poolHost = document.createElement('div');
    this.poolHost.className = 'fx-confetti-layer';
    this.host.appendChild(this.poolHost);
    for (let i = 0; i < this.poolSize; i++) {
      const el = document.createElement('img');
      el.className = 'fx-shard';
      el.draggable = false;
      el.style.display = 'none';
      this.poolHost.appendChild(el);
      this.pool.push({ el, active: false });
    }
    this._raf = 0;
    this._active = 0;
    this._loop = this._loop.bind(this);

    // ── fragment / rainbow-block layer (CHANGE 2) — short-lived self-removing <img>s
    // for the "shatter remains" at cleared cells + the multi-line rainbow mini-blocks.
    // Separate from the pooled spray confetti (these HOLD position then fade/fall, a
    // different motion). Few per clear (bounded above), all self-remove (no leak).
    this.fragmentHost = document.createElement('div');
    this.fragmentHost.className = 'fx-fragment-layer';
    this.host.appendChild(this.fragmentHost);

    // ── THUMBS-UP layer (USER REQ 2026-06-22 따봉) — short-lived self-removing <img>s, one per
    // placed cell of a gap-correct drop. Above the fragment layer so the reward reads on top of
    // the blocks. The per-color LIGHT tints are pre-rendered ONCE to data URLs (multiply blend,
    // like _buildRwTinted) so each pop is a plain <img> (no per-frame blend) — smooth on phones.
    this.thumbHost = document.createElement('div');
    this.thumbHost.className = 'fx-thumb-layer';
    this.host.appendChild(this.thumbHost);
    this._thumbTinted = null;
    this._buildThumbTinted();

    // board dims (cols×rows) for the grid sweep, kept in sync by the host on layout.
    this.cols = 8; this.rows = 8;

    // duration (ms) of the LAST line-clear's fx — set by _lineClear (the 2+ line rainbow
    // wave-burst returns its total; 1-line clears → 0). The host reads this in onStageClear
    // to make the result dim WAIT for the wave-burst to finish (task D). Starts 0.
    this._lastClearFxMs = 0;

    // ── STAGE-CLEAR SEQUENCE layer (replaces the old popup card) ──────────────
    // A self-contained overlay built ON the board: (1) a row-by-row alternating neon
    // grid sweep, then (2) a "Well Done" layer (Lv badges + a RAPID progress bar that
    // flashes at full, confetti raining from the top, the "Well Done!" banner revealed
    // left→right, decorative center gems) with (3) a "Next Stage" button that appears
    // ONLY after the text reveal. Advancement stays BUTTON-ONLY (the host wires the
    // button to gotoStage). All timers are tracked so the level-load teardown (see
    // clearBanner) kills the whole sequence with no lingering glow/confetti/timers.
    this.scHost = document.createElement('div');
    this.scHost.className = 'fx-stageclear-layer';
    this.scHost.style.display = 'none';
    this.host.appendChild(this.scHost);
    this._scTimers = [];     // setTimeout ids for the running sequence (cleared on teardown)
    this._scRaf = 0;         // confetti-rain rAF (separate from the burst-confetti pool)
    this._scActive = false;  // a sequence is currently playing
    this._scRainPool = [];   // fixed-size raining-confetti pool (bounded, recycled)
    this._scBtnHome = null;  // the Next button's at-rest home parent (#next-wrap) to restore on teardown

    // preload sprites so the first clear isn't blank (decode once, reuse). Includes
    // the stage-clear SEQUENCE assets (Well Done banner + decorative gems) so the
    // layer renders fully on the very first clear (GLOBAL C6).
    // DEFERRED to idle / post-first-paint (USER REPORT 2026-06-23 tutorial lock): these ~30
    // src-assigns each resolve a base64 data URI in the reels build, and running them
    // synchronously inside loadLevel saturated the main thread during the user's FIRST grab —
    // iOS WKWebView then dropped that drag's touch move/up events → the piece lifted but
    // could not be moved or released. The first clear is seconds away, so idle warms the
    // cache in time; any effect firing sooner still resolves its <img> on demand.
    const _preload = () => {
      for (const src of [...Object.values(PRAISE_SPRITE), ...Object.values(SHARD_SPRITE),
        ...ACCENT_SPRITE, FX + 'fx_lineglow.webp', FX + 'combo_label.webp',
        FX + 'banner_welldone.webp', RAINBOW_SHARD, RAINBOW_BLOCK, THUMB_SPRITE,
        SPR + 'gem_diamond.webp', SPR + 'gem_star6.webp', SPR + 'gem_starburst.webp']) {
        const im = new Image(); im.src = src;
      }
    };
    const _ric = (typeof requestIdleCallback === 'function') ? requestIdleCallback : (f) => setTimeout(f, 600);
    _ric(_preload);
  }

  // host keeps the sweep grid in sync with the live board dimensions (SSOT geom).
  setDims(cols, rows) { this.cols = cols; this.rows = rows; }

  // gate the tiered score-gain → score-bar fly to score/combo missions ONLY (collect
  // missions keep the gold "+score" popup via _popup). Set by the host on each load
  // from the mission type, so the director never fires the score FX on a collect stage.
  setScoreMode(on) { this.scoreMode = !!on; }

  // PURE description of the grid-sweep schedule (no DOM, no timers) — the single source
  // of truth for the boustrophedon order, used by playStageClear AND by QA to assert the
  // row-alternating direction deterministically. Returns one entry per row:
  //   { y, dir: 'ltr'|'rtl', firstX, lastX, order:[x,…] }
  // row 0 → ltr, row 1 → rtl, row 2 → ltr, … (each row reverses the previous).
  sweepSchedule() {
    const out = [];
    for (let y = 0; y < this.rows; y++) {
      const ltr = (y % 2 === 0);
      const order = [];
      for (let cx = 0; cx < this.cols; cx++) order.push(ltr ? cx : (this.cols - 1 - cx));
      out.push({ y, dir: ltr ? 'ltr' : 'rtl', firstX: order[0], lastX: order[order.length - 1], order });
    }
    return out;
  }

  // wire to a game instance
  attach(game) {
    game.on('onPlace', (e) => this._place(e));
    game.on('onGoodPlace', (e) => this._goodPlace(e));
    game.on('onLineClear', (e) => this._lineClear(e));
    game.on('onPraise', (e) => this._praise(e));
    game.on('onCombo', (e) => this._combo(e));
    game.on('onMissionProgress', (e) => this._missionProgress(e));
    game.on('onDanger', (e) => this._danger(e));
    game.on('onRescue', (e) => this._rescue(e));
    game.on('onStageClear', (e) => this._stageClear(e));
    game.on('onGameOver', (e) => this._gameOver(e));
  }

  // ── event handlers ───────────────────────────────────────────────────────────
  _place(e) {
    // light landing pulse on the placed cells (uses the renderer's well flash).
    this.renderer.flashCells(e.cells, this.cfg.flashMs * 0.5);
    this.renderer.draw(this.renderer._lastState);
    // PLACE CONFETTI (CHANGE 1, per fx_place_confetti.png): a few TINY, SHORT-LIVED
    // specks pop out from the placed block's edges — small, low velocity, quick fade.
    // Subtle juice on every (non-clearing) placement; allocation-light (same pool).
    this._placeConfetti(e.cells, e.color);
    // SCORE-GAIN (score/combo stages only): a placement scores 1 pt per filled cell
    // (game.js scoring SSOT). Fire the SMALLEST tier ('place') at the placed cells'
    // centroid → it pops, then flies into the top score bar (which ticks up on arrival).
    if (this.scoreMode) {
      const c = this._centroid(e.cells);
      if (c) this._scoreGain(e.cells.length, c.x, c.y, 0); // lineCount 0 → 'place' tier
    }
  }

  // tiny, short confetti popping from the EDGES of the just-placed block (CHANGE 1).
  // Spawns a few small specks per placed cell (only from BORDER cells of the piece so
  // a big block doesn't over-spawn) — low velocity, short life, slight gravity. Mixes
  // the piece's own color shard with a sparkle accent. Reuses the SAME bounded pool as
  // the clear confetti (no extra allocation; pool exhaustion → skipped, no growth).
  _placeConfetti(cells, colorKey) {
    if (!cells || !cells.length) return;
    const now = performance.now();
    const life = (this.cfg.placeConfettiMs || 300);   // SHORT (vs clear's ~800ms)
    const src = SHARD_SPRITE.b; void colorKey;        // ⑲ uniform-blue blocks → blue specks
    const cols = this.cols || 8, rows = this.rows || 8;
    const set = new Set(cells);
    // OUTER border segments of the placed shape: a cell side whose neighbor is NOT part
    // of the piece (= the piece's OUTLINE). Specks spawn ON that side and fly OUTWARD
    // (perpendicular to it), so the effect emanates from the block's border outward —
    // never from inside the block.
    const DIRS = [[-1, 0], [1, 0], [0, -1], [0, 1]]; // L, R, U, D
    const segs = [];
    for (const c of cells) {
      const x = c % cols, y = (c / cols) | 0;
      for (const [dx, dy] of DIRS) {
        const nx = x + dx, ny = y + dy;
        const insideShape = nx >= 0 && ny >= 0 && nx < cols && ny < rows && set.has(ny * cols + nx);
        if (!insideShape) segs.push({ c, dx, dy }); // outer-facing edge
      }
    }
    if (!segs.length) return;
    const MAX_SPECKS = 12;                              // bounded + subtle
    for (let s = 0; s < MAX_SPECKS; s++) {
      const seg = segs[(Math.random() * segs.length) | 0];
      const r = this.cellRectOf(seg.c);
      if (!r) continue;
      // a random point ALONG that outer edge (the border line facing outside).
      let ex, ey;
      if (seg.dx === -1) { ex = r.x;          ey = r.y + Math.random() * r.h; }      // left edge
      else if (seg.dx === 1) { ex = r.x + r.w; ey = r.y + Math.random() * r.h; }     // right edge
      else if (seg.dy === -1) { ex = r.x + Math.random() * r.w; ey = r.y; }          // top edge
      else { ex = r.x + Math.random() * r.w; ey = r.y + r.h; }                       // bottom edge
      const use = (Math.random() < 0.3) ? ACCENT_SPRITE[(now | 0) % ACCENT_SPRITE.length] : src;
      this._spawnShard(ex, ey, use, r.w * 0.16, now, life, {
        dir: { x: seg.dx, y: seg.dy },  // OUTWARD from the border (perpendicular to the edge)
        speed: 1.85,                    // shorter throw — specks stay closer to the block
        gravity: 0.04,                  // ~no gravity → spreads out + fades in place
      });
    }
    if (!this._raf) this._raf = requestAnimationFrame(this._loop);
  }

  // ── THUMBS-UP reward (USER REQ 2026-06-22 따봉) ──────────────────────────────
  // Fired when the player drops the queue's gap-piece in its intended gap (game.js onGoodPlace).
  // For EACH placed cell, pop a SMALL block-colored thumbs-up that scales up from tiny, holds,
  // then fades — total ~2s (CSS .fx-thumb / @keyframes thumbPop). Per-cell mapping (a 2×2 block
  // ⇒ 4 thumbs), tinted to a LIGHT version of the placed block's color. Self-removing (no leak).
  _goodPlace(e) {
    if (!e || !e.cells || !e.cells.length || !this.cellRectOf) return;
    const src = this._thumbTintedSrc(e.color || 'b');
    for (const cell of e.cells) {
      const r = this.cellRectOf(cell);
      if (!r) continue;
      const sz = r.w * 0.66;                       // small icon (~2/3 of a cell), centered
      const el = document.createElement('img');
      el.className = 'fx-thumb';
      el.src = src; el.draggable = false;
      el.dataset.cell = cell;                       // so a later line-clear can REMOVE this 따봉
      el.style.width = sz + 'px'; el.style.height = sz + 'px';
      el.style.left = (r.x + (r.w - sz) / 2) + 'px';
      el.style.top = (r.y + (r.h - sz) / 2) + 'px';
      this.thumbHost.appendChild(el);
      const ee = el; setTimeout(() => ee.remove(), 950);   // SHORT (~0.8s anim, goes with the clearing block)
    }
  }

  // Remove any active 따봉 sitting on these (just-cleared) cells, so the reward NEVER lingers on an
  // emptied cell (USER REQ 2026-06-22: "블록이 제거되면 따봉도 없어져야 해"). Called from _lineClear.
  _removeThumbsAt(cells) {
    if (!cells || !cells.length || !this.thumbHost) return;
    const gone = new Set(cells.map((c) => String(c)));
    for (const el of Array.from(this.thumbHost.children)) {
      if (gone.has(el.dataset && el.dataset.cell)) el.remove();
    }
  }

  // Pre-render the near-white thumbs-up sprite into per-palette-key LIGHT tints ONCE (cached as
  // data URLs). multiply(thumb, lightColor) → a pastel thumb of that hue; destination-in restores
  // the sprite's alpha (clip to shape). Same offscreen-canvas pattern as _buildRwTinted, so the
  // live pop is opacity/scale-only (no per-frame blend). Same-origin sprite → toDataURL ok.
  _buildThumbTinted() {
    if (this._thumbTinted || this._thumbTintBuilding) return;
    this._thumbTintBuilding = true;
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth || 96, h = img.naturalHeight || 96, out = {};
        for (const key of Object.keys(THUMB_TINT)) {
          const c = document.createElement('canvas'); c.width = w; c.height = h;
          const x = c.getContext('2d');
          x.drawImage(img, 0, 0, w, h);
          x.globalCompositeOperation = 'multiply'; x.fillStyle = `rgb(${THUMB_TINT[key]})`; x.fillRect(0, 0, w, h);
          x.globalCompositeOperation = 'destination-in'; x.drawImage(img, 0, 0, w, h);
          x.globalCompositeOperation = 'source-over';
          out[key] = c.toDataURL('image/png');
        }
        this._thumbTinted = out;
      } catch (e) { this._thumbTinted = null; }
      this._thumbTintBuilding = false;
    };
    img.onerror = () => { this._thumbTintBuilding = false; };
    img.src = THUMB_SPRITE;
  }

  // tinted data URL for a palette key (falls back to the untinted white thumb until the cache builds).
  _thumbTintedSrc(key) {
    if (this._thumbTinted && this._thumbTinted[key]) return this._thumbTinted[key];
    return THUMB_SPRITE;
  }

  _lineClear(e) {
    // The line-clear burst is keyed to the cleared LINES and must be CONTAINED to —
    // and FILL — each cleared row/col (user 2026-06-18: "조각 효과는 깨진 칸에서만, 라인
    // 전체를 채우되 라인 밖으로 새지 마"). For EVERY cleared row/col we build ONE per-line
    // container <div> sized to that line's rect with overflow:hidden, then spawn ALL of
    // that line's visuals INSIDE it — so CLIPPING makes spilling outside the line
    // physically impossible (the containment guarantee, not just careful velocities):
    //   • a soft GLOW rect tinted to the cleared block COLOR (NOT white) that fills the
    //     whole line rect and fades fast, and
    //   • MANY small block-colored cube fragments + sparkles distributed across the FULL
    //     line length (pop in place — small→bigger→fade, no fall/drift), so the whole
    //     line reads as bursting rather than a center dot.
    // Each container self-removes after the animation (no leak). The old radially-
    // spreading _confetti (which escaped the line) is GONE — replaced by this.
    // a cleared block must take its 따봉 with it (USER REQ 2026-06-22) — drop any thumbs on these cells.
    this._removeThumbsAt(e.cells);
    const rows = e.rows || [], cols = e.cols || [];
    const lineCount = rows.length + cols.length;
    const multi = lineCount >= 2;          // 2+ lines → RAINBOW WAVE-BURST (the centerpiece, task C)
    const colors = e.cellColors || {};
    // track the WINNING/last clear's fx duration so the host (index.html onStageClear)
    // can WAIT for the rainbow wave-burst to FULLY play before the result dim masks it
    // (task D). A 1-line clear's contained burst is short → 0 (no extra wait needed).
    this._lastClearFxMs = 0;
    if (multi) {
      // ── 2+ LINES: rainbow wave-burst over ALL cleared cells (centerpiece, task C). The
      // per-line contained bursts are REPLACED by this; we still shake by lineCount. ──
      this._shakeBoard(lineCount);
      this._lastClearFxMs = this._rainbowWaveBurst(e.cells, colors, rows, cols, e.origin);
    } else if (lineCount > 0) {
      // ── 1 LINE: keep the existing CONTAINED per-line burst (particles, NO rainbow wave).
      this._shakeBoard(lineCount);
      for (const y of rows) this._lineBurst('row', y, e.cells, colors, false);
      for (const x of cols) this._lineBurst('col', x, e.cells, colors, false);
      // report the 1-line burst's duration too (㉔) so a WINNING 1-line clear is PRESERVED +
      // waited-for by onStageClear (else the result sequence wiped the burst before it painted).
      this._lastClearFxMs = (this.cfg.fragmentMs || 300) + 360;
    } else {
      // (defensive) no row/col index → fall back to per-cell fragments in place.
      this._fragments(e.cells, colors);
    }
    // SCORE READOUT at the cleared centroid. On a SCORE/COMBO stage this is the TIERED
    // "+N" score-gain popup (sized/colored by how many lines cleared) that pops then flies
    // into the top score bar (which ticks up on arrival). On a COLLECT stage (scoreMode
    // off) we keep the original gold "+score" text popup (the score isn't the goal there).
    const c = this._centroid(e.cells);
    if (c) {
      if (this.scoreMode) this._scoreGain(e.clearScore, c.x, c.y, lineCount);
      else this._popup(`+${e.clearScore}`, c.x, c.y);
    }
    // collected gems fly from their board cell up to the mission counter; the
    // DISPLAYED count decrements when each arrives (host's onGemArrive). The
    // LOGICAL count is already updated in game.js — this is the satisfying juice.
    if (e.gems && e.gems.length) this._collectGems(e.gems);
  }

  // ── PER-LINE CONTAINED BURST — the cleared-line read, clipped to the line rect ──
  // Builds ONE container positioned at lineRectOf(kind,index) with overflow:hidden, so
  // EVERYTHING spawned inside is CLIPPED to the line (no sideways spill is possible —
  // the containment guarantee). Inside it: a color-tinted glow that fills the line +
  // fades, then per cleared cell 1–2 small cube fragments (pop in place) and a sparkle
  // or two, distributed across the FULL line. On a 2+ line clear the glow/sparkles take
  // a rainbow tint but stay inside the line. The container self-removes (no leak).
  _lineBurst(kind, index, cells, cellColors, multi) {
    if (!this.lineRectOf) return;
    const lr = this.lineRectOf(kind, index);
    if (!lr) return;
    const cols = this.cols || 8;

    // the cleared cells that belong to THIS line, with their color keys (for tint).
    const lineCells = [];
    let domKey = null, domCount = 0;
    const tally = {};
    for (const cell of cells) {
      const cx = cell % cols, cy = (cell / cols) | 0;
      const onLine = (kind === 'row') ? (cy === index) : (cx === index);
      if (!onLine) continue;
      const k = cellColors[cell] || 'b';
      lineCells.push({ cell, key: k });
      tally[k] = (tally[k] || 0) + 1;
      if (tally[k] > domCount) { domCount = tally[k]; domKey = k; }
    }
    if (!lineCells.length) return;
    const glowKey = domKey || 'b';        // line glow tinted to the dominant block color

    // CONTAINER at the line rect, CLIPPING everything inside it (overflow:hidden).
    const box = document.createElement('div');
    box.className = 'fx-lineburst' + (multi ? ' fx-lineburst-multi' : '');
    box.style.left = lr.x + 'px'; box.style.top = lr.y + 'px';
    box.style.width = lr.w + 'px'; box.style.height = lr.h + 'px';
    // expose the block hue to CSS so the glow is BLOCK-COLORED (not white).
    box.style.setProperty('--glow', GLOW_RGB[glowKey] || GLOW_RGB.b);
    this.fragmentHost.appendChild(box);

    // (a) the soft GLOW that FILLS the whole line and fades fast (a child so it is
    //     clipped too — it can never paint outside the line rect).
    const glow = document.createElement('div');
    glow.className = 'fx-lineburst-glow';
    box.appendChild(glow);

    // (b) FILL the line: per cleared cell, 1–2 small cube fragments + occasional sparkle,
    //     positioned at the cell's offset WITHIN this line (so they span the full line).
    //     Coordinates are LOCAL to the box; the fragment size ≈ 1/4 of a cell (existing
    //     small size). Pop in place via CSS (.fx-fragment / fragRemain) — no fall/drift.
    const cellPx = (kind === 'row') ? (lr.w / cols) : (lr.h / (this.rows || 8));
    const fragSz = cellPx * 0.28;            // ≈ a quarter of one block (unchanged feel)
    const fragLife = (this.cfg.fragmentMs || 300);
    const burstAxis = (kind === 'row') ? 'x' : 'y';   // fragments BLAST along the line
    // helper: a burst vector ALONG the line axis (±) + a little perpendicular spread.
    const burstVec = (reach, spread) => {
      const mag = cellPx * reach, dir = (Math.random() < 0.5) ? -1 : 1;
      const perp = (Math.random() - 0.5) * cellPx * spread;
      return (burstAxis === 'x')
        ? { x: dir * mag, y: perp }
        : { x: perp, y: dir * mag };
    };
    for (const { cell, key } of lineCells) {
      const cx = cell % cols, cy = (cell / cols) | 0;
      // local center of this cell inside the line box.
      const lcx = (kind === 'row') ? (cx + 0.5) * cellPx : lr.w / 2;
      const lcy = (kind === 'col') ? (cy + 0.5) * cellPx : lr.h / 2;
      const src = SHARD_SPRITE.b; // ⑩ uniform-blue blocks
      const n = 2 + ((Math.random() < 0.5) ? 1 : 0);   // 2–3 fragments per cell (denser → punchier)
      for (let f = 0; f < n; f++) {
        const sz = fragSz * (0.9 + Math.random() * 0.45);
        const frag = document.createElement('img');
        frag.className = 'fx-fragment fx-frag-burst';   // blasts along the line (clipped → contained)
        frag.src = multi ? RAINBOW_SHARD : src;
        frag.draggable = false;
        frag.style.width = sz + 'px'; frag.style.height = sz + 'px';
        frag.style.left = (lcx - sz / 2) + 'px';
        frag.style.top = (lcy - sz / 2) + 'px';
        const v = burstVec(0.55 + Math.random() * 0.95, 0.55);
        frag.style.setProperty('--fbx', v.x + 'px');
        frag.style.setProperty('--fby', v.y + 'px');
        frag.style.setProperty('--fr', ((Math.random() - 0.5) * 90) + 'deg');
        frag.style.animationDuration = (fragLife + Math.random() * 110) + 'ms';
        box.appendChild(frag);
      }
      // a bright sparkle on MOST cells (star/diamond accent), also blasting a little.
      if (Math.random() < 0.7) {
        const acc = ACCENT_SPRITE[(Math.random() * ACCENT_SPRITE.length) | 0];
        const asz = fragSz * (0.85 + Math.random() * 0.6);
        const spark = document.createElement('img');
        spark.className = 'fx-fragment fx-spark fx-frag-burst';
        spark.src = acc; spark.draggable = false;
        spark.style.width = asz + 'px'; spark.style.height = asz + 'px';
        spark.style.left = (lcx - asz / 2) + 'px';
        spark.style.top = (lcy - asz / 2) + 'px';
        const v = burstVec(0.4 + Math.random() * 0.6, 0.5);
        spark.style.setProperty('--fbx', v.x + 'px');
        spark.style.setProperty('--fby', v.y + 'px');
        spark.style.animationDuration = (fragLife + 100 + Math.random() * 120) + 'ms';
        box.appendChild(spark);
      }
    }

    // self-remove the whole container after the longest child animation (no leak).
    setTimeout(() => box.remove(), fragLife + 340);
  }

  // (REMOVED 2026-06-23) _buildRwTinted / _rwTintedSrc — these pre-rendered the per-cell rainbow
  // snapshot sprites the OLD wave morphed each cleared block into. The new single rainbow SWEEP
  // (_rainbowWaveBurst) uses a CSS linear-gradient overlay instead of per-cell recolored sprites,
  // so that offscreen-canvas cache (and its load-time build) is no longer needed.

  // ── RAINBOW SWEEP (CHANGE 2026-06-23, task C) — the 2+ line clear centerpiece ──
  // REPLACES the old per-cell snapshot wave (one fx-rw-cell <div> + <img> PER cleared cell,
  // which a 6-line clear blew up to ~130+ live #fx els on iPhone → frame drops, ⑫). The user
  // asked for "전체 무지개 스윕 하나" (one overall rainbow sweep). So instead of N morphing
  // block snapshots we render exactly ONE rainbow-gradient overlay sized to the cleared
  // cells' BOUNDING BOX, clipped to that box, and SWEEP it across with a transform-only
  // travel + opacity fade (compositor fast path — NO filter, NO mix-blend-mode, NO per-frame
  // background recompute). It reads as "the cleared lines flash rainbow and sweep across,"
  // from the placement origin outward. Plus a HARD-CAPPED particle spray (≤16 frags/shards
  // total, NOT per-cell) for juice. Whole effect = a handful of #fx elements, not ~70–130.
  // Returns the TOTAL fx duration (ms) so the host waits for it before the result dim (task D).
  _rainbowWaveBurst(cells, cellColors, rows, cols, origin) {
    if (!cells || !cells.length || !this.cellRectOf) return 0;
    const boardCols = this.cols || 8;
    const gen = this._gemFlightGen; // a level LOAD bumps this → the delayed burst aborts
    // BOUNDING BOX of the cleared region (in #stage CSS coords) + region centroid (particle
    // origin). We don't keep per-cell DOM anymore — just the rect to lay the sweep over.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let cx0 = 0, cy0 = 0, n = 0, cellPx = 0;
    for (const cell of cells) {
      const r = this.cellRectOf(cell);
      if (!r) continue;
      if (r.x < minX) minX = r.x; if (r.y < minY) minY = r.y;
      if (r.x + r.w > maxX) maxX = r.x + r.w; if (r.y + r.h > maxY) maxY = r.y + r.h;
      cx0 += r.x + r.w / 2; cy0 += r.y + r.h / 2; n++;
      cellPx = r.w;
    }
    if (!n) return 0;
    const ccx = cx0 / n, ccy = cy0 / n;                 // cleared-region centroid (particle origin)
    const bw = maxX - minX, bh = maxY - minY;           // bounding-box size

    // SWEEP DIRECTION (user req 2026-06-18: "블록 놓은 곳 기준으로 퍼져나감"): travel away from
    // the PLACED piece's epicenter. We convert the grid-coord origin to a CSS point inside the
    // box, then sweep along whichever box axis is longer (so the rainbow visibly travels the
    // length of the cleared cross). Falls back to left→right if origin is missing.
    let originCssX = ccx, originCssY = ccy;
    if (origin && isFinite(origin.x) && isFinite(origin.y) && cellPx) {
      // origin is in GRID cell units; map to CSS via the top-left cell's rect.
      const oRect = this.cellRectOf((Math.max(0, Math.min(boardCols - 1, origin.x | 0)))
        + (Math.max(0, origin.y | 0)) * boardCols);
      if (oRect) { originCssX = oRect.x + (origin.x - (origin.x | 0)) * cellPx; originCssY = oRect.y + (origin.y - (origin.y | 0)) * cellPx; }
    }
    const horizontal = bw >= bh;                        // sweep along the longer box axis

    // TIMING — a single quick rainbow swoosh + flash, then fade. Snappy so it never delays the
    // result screen but reads clearly as "rainbow swept the cleared lines."
    const SWEEP_MS = 360;   // the rainbow gradient travels across the box (transform-only)
    const FADE_MS = 130;    // the box flashes bright then fades after the sweep passes
    const totalMs = SWEEP_MS + FADE_MS;

    // ONE host container = the cleared bounding box, overflow:hidden → the sweep is CLIPPED to
    // exactly the cleared region (can't bleed onto live blocks). Self-removes (no leak).
    const wrap = document.createElement('div');
    wrap.className = 'fx-rainbowsweep';
    wrap.style.left = minX + 'px'; wrap.style.top = minY + 'px';
    wrap.style.width = bw + 'px'; wrap.style.height = bh + 'px';
    this.fragmentHost.appendChild(wrap);

    // THE SWEEP: ONE inner element with a pre-baked rainbow linear-gradient, sized ~2× the box
    // along the travel axis and TRANSLATED across it (transform only). The gradient itself is a
    // static CSS background painted ONCE (no per-frame background-position recompute → no paint
    // churn); only `transform` + `opacity` animate, both on the compositor. The travel start/end
    // are set from the origin side so the rainbow enters from the placed piece and exits the far
    // edge. A second, very short bright FLASH overlay (white→transparent) sells the "pop."
    const sweep = document.createElement('div');
    sweep.className = 'fx-rs-grad' + (horizontal ? ' fx-rs-h' : ' fx-rs-v');
    // travel: gradient is 2× the box on the sweep axis → translate from -50% to +50% of the box.
    // pick the SIGN so it moves AWAY from the origin (origin near the low edge → sweep toward high).
    const lowEdge = horizontal ? minX : minY;
    const highEdge = horizontal ? maxX : maxY;
    const originPos = horizontal ? originCssX : originCssY;
    const nearLow = Math.abs(originPos - lowEdge) <= Math.abs(highEdge - originPos);
    const travel = (horizontal ? bw : bh);              // px the gradient slides
    const sign = nearLow ? 1 : -1;                      // origin at low edge → slide toward high
    sweep.style.setProperty('--rs-from', (sign * -travel) + 'px');
    sweep.style.setProperty('--rs-to', (sign * travel) + 'px');
    // duration/timing/fill set here; the keyframe NAME (rsSweepH / rsSweepV) comes from the
    // .fx-rs-h / .fx-rs-v class so the sweep translates along the correct axis.
    sweep.style.animationDuration = SWEEP_MS + 'ms';
    sweep.style.animationTimingFunction = 'cubic-bezier(.22,.7,.3,1)';
    sweep.style.animationFillMode = 'forwards';
    wrap.appendChild(sweep);

    // FLASH overlay — a single soft white pulse over the whole box that fades right as the sweep
    // finishes (opacity only). Gives the "lines flash" beat without any per-cell DOM.
    const flash = document.createElement('div');
    flash.className = 'fx-rs-flash';
    flash.style.animation = `rsFlash ${totalMs}ms ease-out forwards`;
    wrap.appendChild(flash);

    // ── HARD-CAPPED PARTICLE SPRAY (juice) — ≤ PARTICLE_CAP total fragments/sparkles, NOT per
    //    cell. We spray from a handful of points sampled across the cleared box so the burst
    //    reads as the WHOLE region popping, but the element count is a fixed small budget no
    //    matter how big the clear (a 6-line clear sprays the same handful as a 2-line clear).
    const fragLife = (this.cfg.fragmentMs || 300);
    const shardSz = (cellPx || 36) * 0.4;
    const PARTICLE_CAP = 16;            // total animated fragment/sparkle <img>s for the whole burst
    const SHARD_CAP = 10;              // total pooled rainbow shards (recycled pool, no new DOM)
    // sample spray points evenly along the box (origin-side first so they fire with the sweep).
    const sprayPts = [];
    const np = Math.min(PARTICLE_CAP, Math.max(6, Math.round((bw + bh) / (cellPx || 36))));
    for (let i = 0; i < np; i++) {
      const t = np === 1 ? 0.5 : i / (np - 1);
      // distribute along the sweep axis, jittered on the cross axis, inside the box.
      const ax = horizontal ? (minX + t * bw) : (minX + (0.3 + Math.random() * 0.4) * bw);
      const ay = horizontal ? (minY + (0.3 + Math.random() * 0.4) * bh) : (minY + t * bh);
      sprayPts.push({ x: ax, y: ay, delay: (sign > 0 ? t : 1 - t) * SWEEP_MS * 0.7 });
    }
    let fragBudget = PARTICLE_CAP, shardBudget = SHARD_CAP;
    const palKeys = ['r', 'o', 'y', 'g', 'b', 'p'];
    for (const pt of sprayPts) {
      const fcx = pt.x, fcy = pt.y, rw = cellPx || 36;
      const key = palKeys[(Math.random() * palKeys.length) | 0];
      setTimeout(() => {
        if (gen !== this._gemFlightGen) return;
        const baseSz = rw * 0.32;
        // 1 cube fragment per spray point (capped) — rainbow-tinted shard.
        if (fragBudget > 0) {
          fragBudget--;
          const ang = Math.random() * Math.PI * 2;
          const reach = rw * (0.7 + Math.random() * 1.0);
          const sz = baseSz * (0.9 + Math.random() * 0.6);
          const frag = document.createElement('img');
          frag.className = 'fx-fragment fx-frag-burst';
          frag.src = (Math.random() < 0.5) ? (SHARD_SPRITE[key] || SHARD_SPRITE.b) : RAINBOW_SHARD;
          frag.draggable = false;
          frag.style.width = sz + 'px'; frag.style.height = sz + 'px';
          frag.style.left = (fcx - sz / 2) + 'px'; frag.style.top = (fcy - sz / 2) + 'px';
          frag.style.setProperty('--fbx', (Math.cos(ang) * reach) + 'px');
          frag.style.setProperty('--fby', (Math.sin(ang) * reach) + 'px');
          frag.style.setProperty('--fr', ((Math.random() - 0.5) * 160) + 'deg');
          frag.style.animationDuration = (fragLife + 80 + Math.random() * 160) + 'ms';
          this.fragmentHost.appendChild(frag);
          const ff = frag; setTimeout(() => ff.remove(), fragLife + 340);
        }
        // an occasional sparkle accent (also counted against the cap).
        if (fragBudget > 0 && Math.random() < 0.45) {
          fragBudget--;
          const acc = ACCENT_SPRITE[(Math.random() * ACCENT_SPRITE.length) | 0];
          const asz = baseSz * (0.95 + Math.random() * 0.6), ang = Math.random() * Math.PI * 2;
          const reach = rw * (0.5 + Math.random() * 0.7);
          const spark = document.createElement('img');
          spark.className = 'fx-fragment fx-spark fx-frag-burst';
          spark.src = acc; spark.draggable = false;
          spark.style.width = asz + 'px'; spark.style.height = asz + 'px';
          spark.style.left = (fcx - asz / 2) + 'px'; spark.style.top = (fcy - asz / 2) + 'px';
          spark.style.setProperty('--fbx', (Math.cos(ang) * reach) + 'px');
          spark.style.setProperty('--fby', (Math.sin(ang) * reach) + 'px');
          spark.style.animationDuration = (fragLife + 120 + Math.random() * 140) + 'ms';
          this.fragmentHost.appendChild(spark);
          const ss = spark; setTimeout(() => ss.remove(), fragLife + 360);
        }
        // a pooled rainbow shard (recycled — adds NO new DOM beyond the fixed pool).
        if (shardBudget > 0) {
          shardBudget--;
          const now = performance.now();
          this._spawnShard(fcx + (Math.random() - 0.5) * rw, fcy + (Math.random() - 0.5) * rw,
            RAINBOW_SHARD, shardSz, now, 580 + Math.random() * 220, { radial: true, speed: 3.4, gravity: 0.34 });
          if (!this._raf) this._raf = requestAnimationFrame(this._loop);
        }
      }, pt.delay);
    }

    setTimeout(() => wrap.remove(), totalMs + 120);
    void ccx; void ccy; void rows; void cols;

    return totalMs;
  }

  // ── BOARD SHAKE on clear (juice) — a short translate jitter on the board canvas, scaled
  // by how many lines cleared (1 = subtle, 4+ = punchy). Pure CSS animation, restarted by
  // a reflow so consecutive clears re-trigger it. The HUD/tray stay put (only the board
  // shakes) so it reads as impact, not chaos.
  _shakeBoard(lineCount) {
    const el = this.renderer && this.renderer.boardCanvas;
    if (!el) return;
    const lvl = Math.max(1, Math.min(4, lineCount));
    for (let i = 1; i <= 4; i++) el.classList.remove('fx-shake-' + i);
    void el.offsetWidth;                 // reflow → restart the animation cleanly
    el.classList.add('fx-shake-' + lvl);
    clearTimeout(this._shakeT);
    this._shakeT = setTimeout(() => el.classList.remove('fx-shake-' + lvl), 400);
  }

  // ── FRAGMENTS-IN-PLACE (CHANGE 2, refined) — quick "pop" at each cleared cell ──
  // For each cleared cell a small colored fragment appears RIGHT WHERE the block was,
  // starts small, grows a touch BIGGER, and fades — all in place (NO falling, no drift).
  // Fast + snappy; the biggest it reaches is ~1/4 of one block. Self-removing <img>s on a
  // bounded layer (capped so a 5-line clear ≈ 64 cells stays cheap).
  _fragments(cells, cellColors) {
    if (!cells || !cells.length) return;
    const life = (this.cfg.fragmentMs || 300);        // FAST & snappy (no hold/fall)
    const CAP = 40;                                   // bound the count (multi-line safe)
    const step = Math.max(1, Math.ceil(cells.length / CAP));
    for (let ci = 0; ci < cells.length; ci += step) {
      const cell = cells[ci];
      const r = this.cellRectOf(cell);
      if (!r) continue;
      const key = cellColors[cell];
      const src = SHARD_SPRITE.b; // ⑩ uniform-blue blocks
      // base size = the BIGGEST it grows to ≈ a quarter of one block; the CSS anim scales
      // it up from small → this size while fading, so it never exceeds ~1/4 block.
      const sz = r.w * 0.28;
      const el = document.createElement('img');
      el.className = 'fx-fragment'; el.src = src; el.draggable = false;
      el.style.width = sz + 'px'; el.style.height = sz + 'px';
      // dead-center on the cleared cell — stays put (no jitter, no fall).
      el.style.left = (r.x + (r.w - sz) / 2) + 'px';
      el.style.top = (r.y + (r.h - sz) / 2) + 'px';
      el.style.animationDuration = life + 'ms';
      this.fragmentHost.appendChild(el);
      setTimeout(() => el.remove(), life + 40);
    }
  }

  // (CHANGE 2026-06-18) the old _rainbowBurst (rainbow shards + mini-blocks sprayed
  // RADIALLY OUTWARD from the cleared centroid on a 2+ line clear) is REMOVED — it
  // escaped the cleared lines (user: "라인 밖으로 새면 안 됨"). Multi-line clears keep
  // their rainbow FLAVOR, but CONTAINED: _lineBurst tints each cleared line's fragments
  // + glow with the rainbow shard/sparkles inside the clipped per-line container, so a
  // 2+ line clear reads as rainbow WITHOUT any outward burst beyond the lines.

  // ── flying collect: each gem hops from its cell to its counter chip ────────────
  // Spawns one <img> per collected gem at the cell center and tweens it (ease-in-out
  // + a slight arc + scale pop) to counterPosOf(gem); on arrival fires onGemArrive so
  // the host decrements the DISPLAYED remaining. Staggered so multiple gems read as a
  // cascade. Self-removing DOM (a handful of gems → cheap, no pool needed). The flight
  // never touches mission/win logic — it is a pure look layer (assets + timing, A6).
  _collectGems(gems) {
    if (!this.counterPosOf) return; // no target → host updates the count itself
    const base = this.cfg.gemFlyMs || 520;       // ~450–600ms per spec
    const stagger = this.cfg.gemFlyStaggerMs || 70;
    const gen = this._gemFlightGen; // capture: if the level reloads, this flight aborts
    gems.forEach((gemInfo, k) => {
      const from = this.cellRectOf(gemInfo.cell);
      if (!from) { // can't locate the cell → still notify so the count never sticks
        setTimeout(() => { if (gen === this._gemFlightGen && this.onGemArrive) this.onGemArrive(gemInfo.gem); }, base + k * stagger);
        return;
      }
      const sx = from.x + from.w / 2, sy = from.y + from.h / 2;
      const size = from.w * 0.92;
      const el = document.createElement('img');
      el.className = 'fx-gemfly';
      el.src = gemFileFor(gemInfo.gem);
      el.draggable = false;
      el.style.width = size + 'px'; el.style.height = size + 'px';
      el.style.transform = `translate(${sx - size / 2}px,${sy - size / 2}px) scale(.9)`;
      el.style.opacity = '0';
      this.gemFlyHost.appendChild(el);
      const dur = base;
      const delay = k * stagger;
      // resolve the target lazily at flight-start so HUD layout is current.
      const start = () => {
        if (gen !== this._gemFlightGen) { el.remove(); return; } // level reloaded → abort
        const to = this.counterPosOf(gemInfo.gem) || { x: sx, y: sy - 120 };
        const t0 = performance.now();
        // a small upward arc: lift control point above the straight line.
        const cxp = (sx + to.x) / 2, cyp = Math.min(sy, to.y) - Math.abs(to.y - sy) * 0.25 - 40;
        const step = (now) => {
          if (gen !== this._gemFlightGen) { el.remove(); return; } // level reloaded → abort
          let t = (now - t0) / dur;
          if (t >= 1) t = 1;
          const e2 = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOut
          const mt = 1 - e2;
          // quadratic bezier sx→(cxp,cyp)→to
          const x = mt * mt * sx + 2 * mt * e2 * cxp + e2 * e2 * to.x;
          const y = mt * mt * sy + 2 * mt * e2 * cyp + e2 * e2 * to.y;
          const sc = 0.9 + 0.25 * Math.sin(Math.min(1, t) * Math.PI); // pop then settle
          el.style.transform = `translate(${x - size / 2}px,${y - size / 2}px) scale(${sc})`;
          el.style.opacity = t < 0.12 ? String(t / 0.12) : (t > 0.9 ? String((1 - t) / 0.1) : '1');
          if (t < 1) requestAnimationFrame(step);
          else {
            el.remove();
            if (this.onGemArrive) this.onGemArrive(gemInfo.gem); // decrement DISPLAYED count
          }
        };
        requestAnimationFrame(step);
      };
      if (delay > 0) setTimeout(start, delay); else start();
    });
  }

  // ── SCORE-GAIN: tiered "+N" popup → POP at the gain spot → FLY into the top score bar ──
  // Score/combo stages only (gated by scoreMode). The popup's INTENSITY differs by the
  // magnitude of the gain (lineCount): a plain placement vs a 1/2/3/4+-line clear each
  // gets a visibly different tier (size + glow + pop), so the player reads "how big" at a
  // glance. After a short hold the element FLIES to scoreBarPosOf() (the score-bar marker),
  // shrinking + fading; ON ARRIVAL it calls onScoreArrive(amount) so the host's DEFERRED
  // displayed score ticks up SYNCED to the landing (the bar rises as the points "arrive",
  // not instantly). Reuses the gem-flight generation counter (_gemFlightGen): a stale fly
  // from a previous stage removes itself WITHOUT calling onScoreArrive (no cross-stage tick).
  // Allocation-light (a couple of <div>s per move, self-removing) and target-resolved at
  // flight time so it tracks the live HUD layout (rAF tween, like _collectGems).
  _scoreGain(amount, x, y, lineCount) {
    if (!this.scoreMode || amount <= 0) return;
    // tier by how many lines cleared (0 = a plain placement). Progressively bigger/flashier.
    const tier = lineCount <= 0 ? 'place'
      : lineCount === 1 ? 't1'
      : lineCount === 2 ? 't2'
      : lineCount === 3 ? 't3'
      : 't4';
    const gen = this._gemFlightGen; // capture: a level reload aborts this fly (no stale tick)

    // 3+ line clears COUNT UP from +1 to the value (a fast, satisfying tick) + read BIG via
    // the t3/t4 tiers; smaller gains just show the final value.
    const countUp = lineCount >= 3;
    const el = document.createElement('div');
    el.className = 'fx-scoregain fx-sg-' + tier + (countUp ? ' fx-sg-countup' : '');
    el.textContent = '+' + (countUp ? 1 : amount);
    // POP-in centered at the gain spot (CSS translate(-50%,-50%) keeps it centered there).
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    this.scoreGainHost.appendChild(el);

    // hold a touch longer on the bigger tiers so a huge clear lingers before flying.
    const hold = (tier === 'place') ? 200
      : (tier === 't1') ? 240
      : (tier === 't2') ? 280
      : (tier === 't3') ? 320 : 360;
    const flyDur = (tier === 'place') ? 360
      : (tier === 't4') ? 460 : 420;

    // a flying fly that, on landing, ticks the host's displayed score up (clamped there).
    const arrive = () => {
      if (gen !== this._gemFlightGen) { el.remove(); return; } // reloaded → drop, no stale tick
      el.remove();
      if (this.onScoreArrive) this.onScoreArrive(amount);
    };

    const fly = () => {
      if (gen !== this._gemFlightGen) { el.remove(); return; } // reloaded during the hold → abort
      // resolve the target at flight-start so the HUD layout is current. If there's no
      // score marker (non-score HUD), fly straight UP a bit as a fallback — but STILL call
      // onScoreArrive so the displayed score can never get stuck below the logical score.
      const to = this.scoreBarPosOf ? this.scoreBarPosOf() : null;
      const tx = to ? to.x : x;
      const ty = to ? to.y : (y - 140);
      const t0 = performance.now();
      el.classList.add('fx-sg-flying'); // CSS drops the glow/animation; JS drives the move
      const step = (now) => {
        if (gen !== this._gemFlightGen) { el.remove(); return; } // reloaded mid-flight → abort
        let t = (now - t0) / flyDur;
        if (t >= 1) t = 1;
        const e2 = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; // easeInOut
        const cx = x + (tx - x) * e2;
        const cy = y + (ty - y) * e2;
        const sc = 1 - 0.7 * e2;            // shrink toward the bar as it arrives
        el.style.transform = `translate(-50%,-50%) scale(${sc})`;
        el.style.left = cx + 'px';
        el.style.top = cy + 'px';
        el.style.opacity = String(Math.max(0, 1 - e2 * e2)); // fade out late
        if (t < 1) requestAnimationFrame(step);
        else arrive();
      };
      requestAnimationFrame(step);
    };

    if (countUp) {
      // tick the number from +1 → +amount over a short window (fast & juicy), THEN fly.
      const cuDur = 460, cu0 = performance.now();
      const cuStep = (now) => {
        if (gen !== this._gemFlightGen) { el.remove(); return; } // reloaded → abort
        let t = (now - cu0) / cuDur; if (t >= 1) t = 1;
        el.textContent = '+' + Math.max(1, Math.round(1 + (amount - 1) * t));
        if (t < 1) requestAnimationFrame(cuStep); else fly();
      };
      requestAnimationFrame(cuStep);
    } else {
      setTimeout(fly, hold);
    }
  }

  _praise(e) {
    // matching praise banner sprite for the tier (pop-in + fade).
    const src = PRAISE_SPRITE[e.tier] || PRAISE_SPRITE[1];
    const el = document.createElement('img');
    el.className = 'fx-praise';
    el.src = src; el.draggable = false;
    this.host.appendChild(el);
    setTimeout(() => el.remove(), this.cfg.ribbonMs);
  }

  _combo(e) {
    // combo_label sprite + the number (combo ×n badge, §6).
    const wrap = document.createElement('div');
    wrap.className = 'fx-combo';
    // Build the <img> with createElement + the .src PROPERTY (NOT innerHTML). The reels
    // build inlines every asset and resolves `assets/…` → data URI via a shim on
    // HTMLImageElement.prototype.src / setAttribute. innerHTML sets src through the HTML
    // PARSER, which BYPASSES that shim → the combo label loaded as a BROKEN image ("?"
    // box) in the webview host (USER REPORT 2026-06-23 "텍스트 연출이 빈 박스"). Going
    // through the property setter lets the shim swap it. (_praise already does this.)
    const label = document.createElement('img');
    label.className = 'fx-combo-label';
    label.src = FX + 'combo_label.webp';
    label.draggable = false;
    const x = document.createElement('span');
    x.className = 'fx-combo-x';
    x.textContent = '×' + e.combo;
    wrap.appendChild(label);
    wrap.appendChild(x);
    this.host.appendChild(wrap);
    setTimeout(() => wrap.remove(), this.cfg.ribbonMs);
  }

  _missionProgress() { /* HUD (counter + bar) is updated by the host index.html */ }

  _danger() {
    // ㊷ user req: NO red "danger" outline around the board — it read as an alarming
    // warning. The onDanger event still drives the adaptive feeder (rescue mode); we
    // just don't paint the red pulse anymore. Keep the method as a no-op.
    this.host.classList.remove('fx-danger');
  }

  _rescue() {
    this.host.classList.add('fx-rescue');
    clearTimeout(this._rescueT);
    this._rescueT = setTimeout(() => this.host.classList.remove('fx-rescue'), 500);
  }

  _stageClear() {
    // The VISUAL stage-clear SEQUENCE is driven by the host (index.html onStageClear),
    // which calls playStageClear({...}) with the Lv numbers + last-stage flag (data the
    // pure look layer doesn't own). Kept as a no-op so the event wiring (attach) is
    // unchanged; playStageClear() below is the actual implementation. (sfx_stageclear
    // still fires ONCE via the host inside playStageClear, not doubled.)
  }

  // ── INSTANT CLEAR FLOURISH: 가로세로 grid sweep (USER REQ 2026-06-19 ㊹) ──────────
  // Fired by the host the MOMENT the last piece lands (onStageClear), BEFORE the gems fly
  // — so the player registers "cleared!" immediately instead of staring at a blank board
  // until the result screen. VIVID, full-grid beams: every ROW lights a full-WIDTH beam
  // (cascading top→bottom) and every COLUMN a full-HEIGHT beam (sweeping left→right), so
  // the sweep FILLS the whole grid (height-matched) rather than scattering per-cell dots.
  // Self-removing on tracked timers (a level load tears it down via clearBanner). Returns
  // the total duration (ms).
  playSweep(opts = {}) {
    const br = opts.boardRect;
    if (!br) return 0;
    const cols = this.cols || 8, rows = this.rows || 8;
    const cw = br.w / cols, ch = br.h / rows;
    const host = this.scHost;
    host.style.display = 'block';
    const layer = document.createElement('div');
    layer.className = 'fx-sweep-layer';
    host.appendChild(layer);
    const ROW_STAG = 42, COL_STAG = 42, LIFE = 380;
    let total = 0;
    const beam = (cls, left, top, w, h, at) => {
      total = Math.max(total, at + LIFE);
      this._scTimers.push(setTimeout(() => {
        const b = document.createElement('div');
        b.className = 'fx-beam ' + cls;
        b.style.left = left + 'px'; b.style.top = top + 'px';
        b.style.width = w + 'px'; b.style.height = h + 'px';
        layer.appendChild(b);
        this._scTimers.push(setTimeout(() => b.remove(), LIFE + 80));
      }, at));
    };
    for (let y = 0; y < rows; y++) beam('fx-beam-h', br.x, br.y + y * ch, br.w, ch, y * ROW_STAG);       // 가로 (full width)
    for (let x = 0; x < cols; x++) beam('fx-beam-v', br.x + x * cw, br.y, cw, br.h, x * COL_STAG);       // 세로 (full height)
    this._scTimers.push(setTimeout(() => { if (layer.parentNode) layer.remove(); }, total + 160));
    return total;
  }

  // ── WIN-CLEAR CHOREOGRAPHY (USER REQ 2026-06-19 ㊻) ────────────────────────────
  // The ordered celebration that plays the moment the winning piece lands, BEFORE the result
  // screen:  A) the cleared cells ZOOM (scale-pop + flash) → B) those blocks FALL DOWN
  // (gravity tumble + fade) while CONFETTI rains from the TOP → C) a ZIGZAG RAINBOW grid fill
  // (가로세로 rainbow beams, boustrophedon) → host shows the result. Self-contained DOM in
  // scHost on tracked timers (a level load tears it all down via clearBanner). Returns total ms.
  playWinSequence(opts = {}) {
    const br = opts.boardRect; if (!br) return 0;
    const cells = opts.cells || [];
    this._scActive = true;
    // wipe the default at-placement line burst so the choreography reads cleanly — the gem
    // flights live in gemFlyHost (untouched), so collect missions still animate.
    if (this.fragmentHost) this.fragmentHost.innerHTML = '';
    const host = this.scHost; host.style.display = 'block'; host.innerHTML = '';
    const layer = document.createElement('div'); layer.className = 'fx-win-layer'; host.appendChild(layer);
    // B (AT PLACEMENT, simultaneously — USER REQ ㊻v2: no zoom; confetti immediate + plentiful):
    // the cleared blocks tumble down WHILE confetti rains from the top.
    this._winFall(layer, cells, br);
    this._winConfetti(layer, br);
    // C: a SLOWER, HORIZONTAL-ONLY rainbow zigzag (USER REQ ㊻v2: drop the vertical fill, play
    // longer). Starts after the blocks have begun falling.
    const C_AT = 560;
    const rows = this.rows || 8;
    const zAnim = this._winZigzagDuration();            // full animation (incl. last band's fade)
    const zVisual = (rows - 1) * 95 + 360;              // rainbow has swept ALL rows down (result cue)
    this._scTimers.push(setTimeout(() => this._winZigzag(layer, br), C_AT));
    this._scTimers.push(setTimeout(() => { if (layer.parentNode) layer.remove(); }, C_AT + zAnim + 280));
    // ㊻v3: the result screen should pop the INSTANT the rainbow finishes sweeping — return the
    // VISUAL-complete cue (not the full fade), so the host shows Well Done right then.
    return C_AT + zVisual;
  }

  // B1) FALL: the cleared blocks tumble DOWN past the board (gravity + spin + fade), lightly
  //     staggered so they cascade.
  _winFall(layer, cells, br) {
    if (!this.cellRectOf) return;
    cells.forEach((c, i) => {
      const r = this.cellRectOf(c); if (!r) return;
      const el = document.createElement('img'); el.className = 'fx-winfall'; el.src = BLK_SPRITE; el.draggable = false;
      el.style.left = r.x + 'px'; el.style.top = r.y + 'px'; el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
      el.style.setProperty('--fall', (br.y + br.h - r.y + 80) + 'px');
      el.style.setProperty('--tx', (((i * 53) % 60) - 30) + 'px');
      el.style.setProperty('--rot', (((i * 47) % 140) - 70) + 'deg');
      el.style.animationDelay = ((i % 8) * 16) + 'ms';
      layer.appendChild(el);
      this._scTimers.push(setTimeout(() => el.remove(), 720));
    });
  }

  // B2) CONFETTI from the TOP over the board (independent of the Well Done rain) — multicolor
  //     shards raining down while the blocks fall. Bounded pool, rAF, self-recycling till the
  //     sequence ends.
  _winConfetti(layer, br) {
    const rain = document.createElement('div'); rain.className = 'fx-win-rain';
    rain.style.left = br.x + 'px'; rain.style.top = br.y + 'px';
    rain.style.width = br.w + 'px'; rain.style.height = br.h + 'px';
    layer.appendChild(rain);
    const SHARDS = Object.values(SHARD_SPRITE);
    const POOL = 60, parts = [];                  // ㊻v2: plentiful confetti (was 28)
    for (let i = 0; i < POOL; i++) {
      const el = document.createElement('img'); el.className = 'fx-win-shard'; el.draggable = false;
      el.src = (i % 4 === 0) ? ACCENT_SPRITE[i % ACCENT_SPRITE.length] : SHARDS[i % SHARDS.length];
      const sz = 10 + (i % 5) * 3; el.style.width = sz + 'px'; el.style.height = sz + 'px';
      rain.appendChild(el);
      // ㊻v2: start spread from just-above-the-board to one board-height up, so confetti is
      // visible IMMEDIATELY (falls "동시에" with the block placement), not after a delay.
      parts.push({ el, x: Math.random() * br.w, y: Math.random() * br.h - br.h, vx: (Math.random() - 0.5) * 1.0,
        vy: 2.8 + Math.random() * 2.6, rot: Math.random() * 360, vr: (Math.random() - 0.5) * 9 });
    }
    const t0 = performance.now();
    const DUR = 2300;                              // ㊻v2: last through the longer zigzag
    const loop = () => {
      if (!this._scActive || !rain.parentNode) return;
      for (const p of parts) {
        p.y += p.vy; p.x += p.vx; p.rot += p.vr;
        if (p.y > br.h + 24) { p.y = -20; p.x = Math.random() * br.w; }
        p.el.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.rot}deg)`;
      }
      if (performance.now() - t0 < DUR) requestAnimationFrame(loop); else rain.remove();
    };
    requestAnimationFrame(loop);
    this._scTimers.push(setTimeout(() => { if (rain.parentNode) rain.remove(); }, DUR + 120));
  }

  // zigzag pacing (USER REQ ㊻v2: slower + longer). One place so playWinSequence + _winZigzag agree.
  _winZigzagDuration() { const rows = this.rows || 8; return (rows - 1) * 95 + 760; }

  // C) ZIGZAG RAINBOW: HORIZONTAL-only (USER REQ ㊻v2: vertical fill removed) — full-width ROW
  //    beams, each a rainbow hue, cascading top→bottom SLOWLY so the grid fills with colour over
  //    a longer beat, plus a glowing frame that lingers the whole time.
  _winZigzag(layer, br) {
    const rows = this.rows || 8;
    const ch = br.h / rows;
    const HUES = [0, 32, 50, 130, 200, 230, 280, 320]; // red→orange→yellow→green→cyan→blue→violet→pink
    const ROW_STAG = 95, LIFE = 760;                   // slower cascade + each band lingers longer
    const total = (rows - 1) * ROW_STAG + LIFE;
    // glowing frame around the grid — lasts the whole zigzag.
    const frame = document.createElement('div'); frame.className = 'fx-rzig-frame';
    frame.style.left = (br.x - 3) + 'px'; frame.style.top = (br.y - 3) + 'px';
    frame.style.width = (br.w + 6) + 'px'; frame.style.height = (br.h + 6) + 'px';
    frame.style.animationDuration = total + 'ms';
    layer.appendChild(frame);
    this._scTimers.push(setTimeout(() => frame.remove(), total + 80));
    for (let y = 0; y < rows; y++) {
      const top = br.y + y * ch, hue = HUES[y % HUES.length], at = y * ROW_STAG;
      this._scTimers.push(setTimeout(() => {
        const b = document.createElement('div'); b.className = 'fx-beam fx-beam-h fx-beam-rb';
        b.style.left = br.x + 'px'; b.style.top = top + 'px'; b.style.width = br.w + 'px'; b.style.height = ch + 'px';
        b.style.setProperty('--hue', hue);
        b.style.animationDuration = LIFE + 'ms';     // band lingers longer (slower fade)
        layer.appendChild(b);
        this._scTimers.push(setTimeout(() => b.remove(), LIFE + 80));
      }, at));
    }
  }

  // ── STAGE-CLEAR SEQUENCE (replaces the old popup card) ────────────────────────
  // Plays, in order: (1) a row-by-row ALTERNATING-direction neon grid sweep over the
  // board, then (2) a "Well Done" layer that fades in — Lv.N badge (left) + a RAPID
  // progress bar + Lv.N+1 badge (right) that FLASHES at full then the badges blink,
  // confetti raining from the TOP, the "Well Done!" banner revealed left→right, and a
  // few decorative center gems — and finally (3) reveals the "Next Stage" button ONLY
  // after the text wipe finishes. Returns immediately; everything runs on tracked
  // timers/rAF so a level load tears it all down (clearBanner). Advancement stays
  // BUTTON-ONLY — this layer never auto-advances; the host wires the button.
  //
  // opts = {
  //   levelNum,           // current stage number N (for "Lv.N" / "Lv.N+1")
  //   isLast,             // last stage? → show "Lv.N → Complete!"
  //   nextBtn,            // the host's #next-btn element to mount + reveal after the text
  //   onSfx,              // () => host plays sfx_stageclear ONCE (fired here, not doubled)
  //   palette,            // {key:hex} so the raining confetti matches the game colors
  //   boardRect,          // {x,y,w,h} of the board in #stage coords → the Well Done
  //                       //   layer (badges/gems/banner) is positioned OVER the board
  //                       //   (NOT the whole stage), matching the ref. Optional; falls
  //                       //   back to the full layer if absent.
  // }
  playStageClear(opts = {}) {
    this.tearDownStageClear();           // clean slate (kills any prior sequence)
    this._scActive = true;
    // remember the Next button's HOME parent (#next-wrap) so teardown returns it there
    // (not stranded in #fx) — keeps the host's at-rest markup intact (PUP7).
    if (opts.nextBtn) this._scBtnHome = opts.nextBtn.parentNode || this._scBtnHome || null;
    const host = this.scHost;
    host.style.display = 'block';
    host.innerHTML = '';                 // rebuild fresh each clear

    // (1) GRID SWEEP — already fired at the LAST PLACEMENT via playSweep() (the host calls
    // it in onStageClear the instant the winning piece lands, so "cleared!" reads
    // immediately — USER REQ 2026-06-19 ㊹). The Well Done layer below just fades in after a
    // tiny lead (the gems have already flown to the counter during the host's showDelay).
    const lead = 60;

    // (2) FULL-SCREEN DIMMED "Well Done" layer — fades in as the sweep finishes. It now
    // covers the WHOLE screen with a dim, and only the celebration (badges, gems, text,
    // confetti, button) rises above it (task #3). NOT positioned to the board any more.
    const wd = this._buildWellDone(opts);
    host.appendChild(wd.layer);
    this._scTimers.push(setTimeout(() => {
      wd.layer.classList.add('show');                 // dim + content fade in
      if (opts.onSfx) opts.onSfx();                   // sfx_stageclear ONCE, here
      // ── SIMULTANEOUS entrance (task #4): gems + Well Done text + progress bar + confetti
      //    ALL start NOW, each with its OWN entrance animation. ──
      this._startConfettiRain(opts.palette || null);  // confetti from the WHOLE width
      wd.gems.classList.add('show');                  // center gems pop in
      wd.text.classList.add('reveal');                // letters pop small→big (staggered)
      this._scTimers.push(setTimeout(() => { wd.fill.style.width = '100%'; }, 30)); // purple bar fills
      // when the bar reaches full → COLOR CYCLE (orange→red→blue→green→purple, blinking)
      // + the Lv badges blink.
      const fullAt = 30 + SC.BAR_FILL;
      this._scTimers.push(setTimeout(() => {
        wd.bar.classList.add('flash', 'cycle');
        wd.lvA.classList.add('blink'); wd.lvB.classList.add('blink');
      }, fullAt));
      // ── Next button: ONE BEAT after EVERY entrance animation has finished (task #4). ──
      const textTotal = (WELLDONE_TEXT.length - 1) * SC.CHAR_STAGGER + SC.CHAR_POP;
      const barTotal = fullAt + SC.BAR_CYCLE;
      const allDone = Math.max(textTotal, barTotal, SC.GEM_POP);
      this._scTimers.push(setTimeout(() => {
        if (opts.nextBtn) { wd.btnSlot.appendChild(opts.nextBtn); opts.nextBtn.classList.add('sc-show'); }
      }, allDone + SC.NEXT_BEAT));
    }, lead));
  }

  // build the Well Done overlay DOM (Lv badges + bar, confetti host, banner, gems,
  // button slot). Pure assembly — the timed animations are driven in playStageClear.
  _buildWellDone(opts) {
    const N = opts.levelNum || 1;
    const layer = document.createElement('div');
    layer.className = 'fx-welldone';

    // full-screen DIM backdrop — everything below sits ABOVE it so only the celebration
    // rises over the dimmed game (task #3). Appended FIRST → lowest in the stacking order.
    const dim = document.createElement('div'); dim.className = 'wd-dim';

    // top row: Lv.N badge — bar — Lv.N+1 badge (or "Complete!" on the last stage).
    const top = document.createElement('div'); top.className = 'wd-top';
    const lvA = document.createElement('div'); lvA.className = 'wd-lv wd-lv-a'; lvA.textContent = 'Lv.' + N;
    const bar = document.createElement('div'); bar.className = 'wd-bar';
    const fill = document.createElement('div'); fill.className = 'wd-fill'; bar.appendChild(fill);
    const lvB = document.createElement('div'); lvB.className = 'wd-lv wd-lv-b';
    lvB.textContent = opts.isLast ? 'Complete!' : ('Lv.' + (N + 1));
    if (opts.isLast) lvB.classList.add('wd-lv-complete');
    top.appendChild(lvA); top.appendChild(bar); top.appendChild(lvB);

    // confetti-rain host (full-screen — see _startConfettiRain — bounded recycled pool).
    const rain = document.createElement('div'); rain.className = 'wd-rain';

    // decorative center gems (per the ref: blue diamond, red star, purple starburst).
    const gems = document.createElement('div'); gems.className = 'wd-gems';
    for (const g of ['gem_starburst', 'gem_diamond', 'gem_star6']) {
      const im = document.createElement('img');
      im.className = 'wd-gem wd-gem-' + g; im.src = SPR + g + '.webp'; im.draggable = false;
      gems.appendChild(im);
    }

    // "Well Done!" as PER-LETTER text — each char pops small→big, staggered (task #4).
    // Replaces the single banner image so we can animate it letter by letter.
    const text = document.createElement('div'); text.className = 'wd-text';
    [...WELLDONE_TEXT].forEach((ch, i) => {
      const sp = document.createElement('span');
      sp.className = 'wd-char';
      sp.textContent = (ch === ' ') ? ' ' : ch;
      sp.style.animationDelay = (i * SC.CHAR_STAGGER) + 'ms';
      text.appendChild(sp);
    });

    // button slot (the host's #next-btn is mounted here AFTER all entrances finish).
    const btnSlot = document.createElement('div'); btnSlot.className = 'wd-btnslot';

    layer.appendChild(dim);
    layer.appendChild(top); layer.appendChild(rain); layer.appendChild(gems);
    layer.appendChild(text); layer.appendChild(btnSlot);
    return { layer, dim, lvA, lvB, bar, fill, rain, gems, text, btnSlot };
  }

  // confetti raining from the TOP of the layer — a bounded, recycled pool (no leak,
  // L13/L57) driven by ONE rAF loop. Each shard falls down + slightly spins; recycled
  // when it leaves the bottom. Stopped + cleared on teardown.
  _startConfettiRain(palette) {
    const rain = this.scHost.querySelector('.wd-rain');
    if (!rain) return;
    // size the rain to the RAIN element itself (it spans the Well Done layer = the board
    // area), so shards fall within that region — not mis-mapped to the full stage.
    const W = rain.clientWidth || this.host.clientWidth || 360;
    const H = rain.clientHeight || this.host.clientHeight || 640;
    const SHARDS = Object.values(SHARD_SPRITE);
    const POOL = 40;
    // (re)build the pool sized to this run.
    this._scRainPool = [];
    for (let i = 0; i < POOL; i++) {
      const el = document.createElement('img');
      el.className = 'wd-shard'; el.draggable = false;
      // mix colored shards with the sparkle/star/diamond accents (variety).
      const useAccent = (i % 4 === 0);
      el.src = useAccent ? ACCENT_SPRITE[i % ACCENT_SPRITE.length] : SHARDS[i % SHARDS.length];
      rain.appendChild(el);
      this._scRainPool.push(this._spawnRainShard(el, W, H, true));
    }
    const loop = () => {
      if (!this._scActive) { this._scRaf = 0; return; }
      const W2 = rain.clientWidth || W, H2 = rain.clientHeight || H;
      for (const p of this._scRainPool) {
        p.y += p.vy; p.x += p.vx; p.rot += p.vr;
        if (p.y > H2 + 30) Object.assign(p, this._spawnRainShard(p.el, W2, H2, false)); // recycle at top
        p.el.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.rot}deg)`;
      }
      this._scRaf = requestAnimationFrame(loop);
    };
    this._scRaf = requestAnimationFrame(loop);
  }

  // initialize one raining shard at the top (or scattered across the height on first
  // fill so the rain starts already-populated, not from a single line).
  _spawnRainShard(el, W, H, initial) {
    const size = 12 + Math.random() * 12;
    el.style.width = size + 'px'; el.style.height = size + 'px';
    el.style.display = 'block';
    const x = Math.random() * W;
    const y = initial ? (Math.random() * H - H) : (-30 - Math.random() * 40);
    return { el, x, y, vx: (Math.random() - 0.5) * 1.1, vy: 2.2 + Math.random() * 2.6,
      rot: Math.random() * 360, vr: (Math.random() - 0.5) * 8 };
  }

  // tear down the WHOLE stage-clear sequence: kill timers + the confetti-rain rAF, drop
  // all sequence DOM (sweep cells, Well Done layer, shards), and DETACH the Next button
  // back out so the host owns it again (no lingering glow/confetti/layer/timers — task).
  tearDownStageClear() {
    this._scActive = false;
    for (const t of this._scTimers) clearTimeout(t);
    this._scTimers = [];
    if (this._scRaf) { cancelAnimationFrame(this._scRaf); this._scRaf = 0; }
    this._scRainPool = [];
    // pull the Next button out before nuking the layer + return it to its HOME parent
    // (#next-wrap) so the host's at-rest markup is intact (no stranded button in #fx).
    const btn = this.scHost.querySelector('.wd-btnslot > *');
    if (btn) {
      btn.classList.remove('sc-show');
      (this._scBtnHome || this.host).appendChild(btn);
    }
    this.scHost.innerHTML = '';
    this.scHost.style.display = 'none';
  }

  _gameOver(e) {
    // ⑩: FIRST fill the empty board cells with blocks rising from the BOTTOM, THEN show the
    // Game Over banner (the host clears the queue + shows "No Space Left" meanwhile).
    const fillMs = this._playGameOverFill(e.cells, e.cols || this.cols || 8, e.rows || this.rows || 8);
    clearTimeout(this._goBannerT);
    this._goBannerT = setTimeout(() => this._banner('Game Over', `Score ${e.score}`, true), fillMs + 160);
  }

  // fill every EMPTY board cell with a block sprite, rising in from below row-by-row BOTTOM→TOP
  // (opacity+transform only → smooth). Blocks PERSIST (the board reads as full at game over);
  // a level load clears them via clearBanner→fragmentHost. Returns the total animation ms.
  _playGameOverFill(cells, cols, rows) {
    if (!this.cellRectOf || !cells || !this.fragmentHost) return 0;
    const layer = document.createElement('div');
    layer.className = 'fx-gameover-fill';
    this.fragmentHost.appendChild(layer);
    const PER_ROW = 78, POP_MS = 300; // a bit SLOWER cell-by-cell rise (user req ㉒)
    let maxDelay = 0;
    for (let y = rows - 1; y >= 0; y--) {              // bottom row first
      const rowDelay = (rows - 1 - y) * PER_ROW;
      for (let x = 0; x < cols; x++) {
        if (cells[y * cols + x]) continue;            // already a real block → skip
        const r = this.cellRectOf(y * cols + x);
        if (!r) continue;
        const img = document.createElement('img');
        img.className = 'fx-go-block'; img.draggable = false;
        img.src = SPR + 'block_b.webp';
        img.style.left = r.x + 'px'; img.style.top = r.y + 'px';
        img.style.width = r.w + 'px'; img.style.height = r.h + 'px';
        img.style.animation = `goBlockPop ${POP_MS}ms cubic-bezier(.3,1.45,.5,1) ${rowDelay}ms both`;
        layer.appendChild(img);
        if (rowDelay > maxDelay) maxDelay = rowDelay;
      }
    }
    return maxDelay + POP_MS;
  }

  // (CHANGE 2) the old _lineGlow (white/pale fx_lineglow.webp capsule BEAM stretched
  // over each cleared line on clear) is REMOVED — the user disliked the white vertical
  // light-beam. Line clears now read via the in-place FRAGMENTS + confetti (+ rainbow on
  // multi-line). The fx_lineglow.webp sprite is still used ONLY by the stage-clear grid
  // SWEEP (fx-sweep-cell), which is a different, intentional traveling glow.

  // ── line-clear PREVIEW (CHANGE 1) — THIN ORANGE NEON OUTLINE framing the lines a
  //    valid ghost WOULD complete, shown DURING the drag (before release). Public
  //    API called from input.js. Reconciles the displayed set against `rows`/`cols`,
  //    reusing pooled <div>s (no DOM churn / leak). The frame is a rounded-rect
  //    BORDER (.fx-linepreview) with an outer orange glow and a TRANSPARENT inside,
  //    so the blocks stay visible — it does NOT reuse the fx_lineglow.webp fill
  //    sprite. A gentle pulse makes "about to clear" read clearly.
  showLinePreview(rows, cols) {
    rows = rows || []; cols = cols || [];
    // signature so a no-op (ghost moved within the same completing cell) skips work.
    const sig = 'r' + rows.join(',') + '|c' + cols.join(',');
    if (sig === this._previewShown) return;
    this._previewShown = sig;
    if (!this.lineRectOf) return;

    // CHANGE 3 (per fx_preview_rainbow_2plus.png): a placement that would clear 2+
    // lines at once previews with a RAINBOW gradient border; a single line keeps the
    // soft ORANGE outline. The look is a CSS modifier toggled on each frame element.
    const multi = (rows.length + cols.length) >= 2;

    const wanted = new Set();
    for (const y of rows) wanted.add('row:' + y);
    for (const x of cols) wanted.add('col:' + x);

    // remove glows no longer wanted (recycle to the host detached, then drop).
    for (const [key, el] of this._previewEls) {
      if (!wanted.has(key)) { el.remove(); this._previewEls.delete(key); }
    }
    // add/position the wanted glows (reuse existing element when present).
    for (const key of wanted) {
      const [kind, idxStr] = key.split(':');
      const idx = +idxStr;
      const r = this.lineRectOf(kind, idx);
      if (!r) continue;
      let el = this._previewEls.get(key);
      if (!el) {
        // a <div> FRAME (border + outer glow, transparent fill) — NOT the fill sprite.
        el = document.createElement('div');
        el.className = 'fx-linepreview fx-linepreview-' + kind;
        this.previewHost.appendChild(el);
        this._previewEls.set(key, el);
      }
      // toggle the rainbow (2+) vs orange (1) modifier — thin outline either way.
      el.classList.toggle('fx-linepreview-rainbow', multi);
      el.style.left = r.x + 'px'; el.style.top = r.y + 'px';
      el.style.width = r.w + 'px'; el.style.height = r.h + 'px';
      // MATCH the block corner roundness (user: "둥글기가 블록과 다르다"). Blocks round at
      // sz*0.18 (sz = cell*0.9) and sit inset cell*0.05 inside the cell; the preview frames
      // the CELL rect, so a CONCENTRIC radius = block_radius + inset ≈ cell*0.21. Set per
      // frame from the live cell size so it tracks the board scale (not a fixed px).
      const cell = (this.renderer && this.renderer.cellSize) ? this.renderer.cellSize() : 0;
      if (cell) el.style.borderRadius = (cell * 0.21).toFixed(1) + 'px';
    }
  }

  // hide ALL preview glows (ghost moved to a non-clearing / invalid spot, or the
  // drag ended). Drops the pooled DOM so nothing leaks between drags.
  hideLinePreview() {
    if (this._previewShown === '') return; // already hidden → no-op
    this._previewShown = '';
    for (const [, el] of this._previewEls) el.remove();
    this._previewEls.clear();
  }

  // (CHANGE 2026-06-18) the old _confetti (pooled shards sprayed RADIALLY OUTWARD from
  // each cleared cell) is REMOVED — it escaped the cleared line (the SPILL the user
  // flagged). The cleared-line read now lives entirely in _lineBurst, where every shard/
  // sparkle is spawned INSIDE a per-line overflow:hidden container, so nothing can travel
  // outside the line rect. The shared pool + _spawnShard / _loop remain for _placeConfetti.

  // opts (all optional) tune the burst per call site (clear vs place vs rainbow):
  //   speed = horizontal spread, up = initial upward velocity, gravity = per-frame pull.
  // Defaults reproduce the original clear-confetti physics so existing callers are
  // unchanged. Each shard carries its OWN gravity so place specks settle faster.
  _spawnShard(x, y, src, size, now, life, opts) {
    const p = this.pool.find((q) => !q.active);
    if (!p) return; // pool exhausted → skip (bounded, no growth)
    const o = opts || null;
    p.active = true; this._active++;
    p.x = x; p.y = y;
    if (o && o.dir) {
      // explicit OUTWARD direction (perpendicular to the placed block's border edge) +
      // small tangential jitter so the row of specks isn't a perfectly straight line.
      const sp = (o.speed || 2.4) * (0.5 + Math.random() * 0.7);
      const jx = (Math.random() - 0.5) * 0.7, jy = (Math.random() - 0.5) * 0.7;
      p.vx = (o.dir.x + jx) * sp; p.vy = (o.dir.y + jy) * sp;
    } else if (o && o.radial) {
      // spread OUTWARD in ALL directions (no upward bias).
      const a = Math.random() * Math.PI * 2;
      const sp = (o.speed || 2) * (0.4 + Math.random() * 0.8);
      p.vx = Math.cos(a) * sp; p.vy = Math.sin(a) * sp;
    } else {
      const spread = o ? o.speed : 3.4;
      const up = o ? o.up : 6.0;          // (orig: 2.8 + rand*3.2 ≈ 2.8..6.0)
      p.vx = (Math.random() - 0.5) * spread;             // px/frame horizontal spread
      p.vy = -(up * (0.45 + Math.random() * 0.55));      // initial upward velocity
    }
    p.rot = Math.random() * 360; p.vr = (Math.random() - 0.5) * 22;
    p.born = now; p.life = life;
    p.g = o ? o.gravity : 0.42;                         // per-shard gravity
    p.size = size * (0.7 + Math.random() * 0.5);
    const el = p.el;
    if (el.src.indexOf(src) === -1) el.src = src; // only swap when needed
    el.style.width = p.size + 'px'; el.style.height = p.size + 'px';
    el.style.display = 'block';
    el.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.rot}deg)`;
    el.style.opacity = '1';
  }

  // single shared physics loop for ALL active shards (no per-shard timer).
  _loop() {
    const now = performance.now();
    let any = false;
    for (const p of this.pool) {
      if (!p.active) continue;
      const t = (now - p.born) / p.life;
      if (t >= 1) { p.active = false; this._active--; p.el.style.display = 'none'; continue; }
      any = true;
      p.vy += (p.g != null ? p.g : 0.42); // per-shard gravity px/frame^2
      p.x += p.vx; p.y += p.vy; p.rot += p.vr;
      const el = p.el;
      el.style.transform = `translate(${p.x}px,${p.y}px) rotate(${p.rot}deg)`;
      el.style.opacity = String(Math.max(0, 1 - t * t)); // ease-out fade
    }
    if (any) this._raf = requestAnimationFrame(this._loop);
    else this._raf = 0; // idle → stop the loop (no leak)
  }

  // ── +score popup (gold text, stays styled) ───────────────────────────────────
  _popup(text, x, y) {
    const el = document.createElement('div');
    el.className = 'fx-popup';
    el.textContent = text;
    el.style.left = x + 'px'; el.style.top = y + 'px';
    this.host.appendChild(el);
    setTimeout(() => el.remove(), this.cfg.popupMs);
  }

  // game-over banner (end-of-round state; host clears on retry).
  _banner(title, sub, isFail) {
    const el = document.createElement('div');
    el.className = 'fx-banner' + (isFail ? ' fx-fail' : '');
    el.innerHTML = `<div class="fx-banner-title">${title}</div><div class="fx-banner-sub">${sub}</div>`;
    this.host.appendChild(el);
    this.lastBanner = el;
    // The banner dim is inset:0 of the fixed-aspect #stage box, so it stops at #stage's
    // bottom edge → the page background showed as a WHITE strip below it (USER REPORT
    // 2026-06-23 "게임오버 딤 하단 잘려"). Darken the FULL viewport (incl. letterbox margins)
    // by darkening #bg — exactly how the stage-clear result dim does it (body.sc-dim #bg).
    // Cleared on retry by the next loadLevel (index.html drops sc-dim on a fresh stage).
    if (isFail) document.body.classList.add('sc-dim');
  }

  // remove any persistent overlays (banner / stage-clear) — called on load/retry.
  // Also aborts in-flight collect gems so a stale flight from the previous stage can
  // never land on the NEW stage's counter (which would corrupt its DISPLAYED count).
  // preserveClearFx (task D): when TRUE, the in-flight CLEAR fragments (incl. the 2+
  // line RAINBOW WAVE-BURST) are KEPT — the host passes this for a WINNING 2+ clear so
  // the up-front clearBanner() in onStageClear can drop leftover banners/flights WITHOUT
  // wiping the just-started wave-burst before the result waits for it. (Level LOAD calls
  // clearBanner() with no arg → wipes everything, the safe default.)
  clearBanner(preserveClearFx) {
    if (this.lastBanner) { this.lastBanner.remove(); this.lastBanner = null; }
    if (this._clearEl) { this._clearEl.remove(); this._clearEl = null; }
    // On a WINNING clear (preserveClearFx) keep ALL the in-flight reward fx alive — the result
    // sequence waits for them. Bumping the gen here would abort the wave-burst that the winning
    // move JUST scheduled (that was the "stage-1 burst doesn't play" bug, since stage 1's clear
    // IS the win → clearBanner fires before the +250ms burst); dropping the flight DOM would
    // erase the win's gem/score flights too. Only invalidate for a non-preserving teardown.
    if (!preserveClearFx) {
      this._gemFlightGen++;                      // invalidate any running flights (gems + score-flies)
      if (this.gemFlyHost) this.gemFlyHost.innerHTML = '';      // drop their DOM immediately
      if (this.scoreGainHost) this.scoreGainHost.innerHTML = ''; // drop any in-flight score-gain popups
    }
    // keep the live wave-burst when asked (task D); otherwise drop stale fragments / blocks.
    if (this.fragmentHost && !preserveClearFx) this.fragmentHost.innerHTML = '';
    // reset the pooled confetti so a fresh stage never inherits a prior spray (also keeps
    // QA deterministic). Skipped when preserving the live wave-burst (its particles pool too).
    if (!preserveClearFx && this.pool) {
      for (const p of this.pool) { if (p.active) { p.active = false; p.el.style.display = 'none'; } }
      this._active = 0;
    }
    this.hideLinePreview();                      // drop any stale line-clear preview (CHANGE 1)
    // drop any lingering praise / combo / +score popups so a fresh stage never inherits them.
    if (!preserveClearFx && this.host) {
      this.host.querySelectorAll('.fx-praise, .fx-combo, .fx-popup').forEach((e) => e.remove());
    }
    this.tearDownStageClear();                   // kill the whole stage-clear sequence (no lingering glow/confetti/layer/timers)
    // cancel any in-flight BOARD SHAKE so a FRESH STAGE never inherits an offset board (an
    // active shake transforms the canvas → its rect drifts). BUT keep it when preserving the
    // clear fx (a WINNING clear's onStageClear) — else the win/ tutorial clear's shake gets
    // wiped the instant it starts (that was the "tutorial doesn't shake" bug).
    if (!preserveClearFx) {
      clearTimeout(this._shakeT);
      const bc = this.renderer && this.renderer.boardCanvas;
      if (bc) for (let i = 1; i <= 4; i++) bc.classList.remove('fx-shake-' + i);
    }
  }

  _centroid(cellIndices) {
    if (!cellIndices.length) return null;
    let sx = 0, sy = 0, n = 0;
    for (const i of cellIndices) {
      const r = this.cellRectOf(i);
      if (!r) continue;
      sx += r.x + r.w / 2; sy += r.y + r.h / 2; n++;
    }
    return n ? { x: sx / n, y: sy / n } : null;
  }
}
