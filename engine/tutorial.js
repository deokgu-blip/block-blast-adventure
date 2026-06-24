// engine/tutorial.js — ONBOARDING TUTORIAL CONTROLLER (GAME_DESIGN §10).
//
// Drives Stage 1 onboarding from DATA in the level json (level.tutorial.steps /
// fixedQueue) — the controller hardcodes NO step values (GLOBAL A1). It owns the
// 3-beat flow: (1) drag a block, (2) fill the line to clear it, (3) success.
//
// 3-layer split (GLOBAL A6): LOGIC = step gating / advancement (here + game.js);
// LOOK = the dim overlay + instruction banner + finger pointer, which are
// // PLACEHOLDER look — replaced by API assets later (GLOBAL C6/C7)
// (CSS shapes + text for now; real hand-pointer / speech-bubble sprites drop in
// later via the image pipeline, shown to the user first).
//
// Input gating contract (consumed by input.js):
//   isDraggable(trayIndex)      → only the current step's pointTo piece is liftable
//   isAcceptableDrop(ti, x, y)  → only a drop snapped near the step's dropAt sticks
//   onPlaced(res, trayIndex)    → notified after a successful placement to advance
// Wrong drops are simply rejected by input.js (no fail state) → the piece returns.

export class TutorialController {
  // host = {
  //   game, level,
  //   overlay,            // #tut overlay element (covers #stage)
  //   bannerEl, fingerEl, // PLACEHOLDER look elements (CSS)
  //   traySlots,          // [{el,canvas}, ...]
  //   stageRect(),        // #stage getBoundingClientRect() (CSS px)
  //   traySlotCenter(i),  // {x,y} center of tray slot i, in #stage CSS coords
  //   cellTopLeft(x,y),   // {x,y} top-left of board cell (x,y), in #stage CSS coords
  //   cellSize(),         // board cell size in CSS px
  //   onStepChange(i),    // optional: HUD/step hook
  // }
  constructor(host) {
    this.h = host;
    this.game = host.game;
    this.steps = (host.game.tutorial && host.game.tutorial.steps) || [];
    this.stepIndex = -1;
    this._raf = 0;
    this._autoTimer = 0;
    this._t0 = 0;
    this.active = !!host.game.tutorial;
  }

  start() {
    if (!this.active) { this.h.overlay.style.display = 'none'; return; }
    this.h.overlay.style.display = 'block';
    this._goto(0);
    this._loop = this._loop.bind(this);
    this._t0 = performance.now();
    this._raf = requestAnimationFrame(this._loop);
  }

  stop() {
    if (this._raf) cancelAnimationFrame(this._raf), (this._raf = 0);
    if (this._autoTimer) clearTimeout(this._autoTimer), (this._autoTimer = 0);
  }

  destroy() {
    this.stop();
    this.h.overlay.style.display = 'none';
    // clear the active tray-slot highlight so it doesn't linger into the next stage.
    for (let i = 0; i < this.h.traySlots.length; i++) this.h.traySlots[i].el.classList.remove('tut-hi');
  }

  // ── current step accessors (used by input.js gating) ────────────────────────
  current() { return this.steps[this.stepIndex] || null; }

  isDraggable(trayIndex) {
    if (!this.active) return true;
    const s = this.current();
    if (!s || s.gate === 'auto') return false; // auto steps take no input
    return s.pointTo && s.pointTo.type === 'tray' && s.pointTo.index === trayIndex;
  }

  // Outcome-based, forgiving gating (real-touch friendly — NOT an exact-cell match,
  // which is nearly impossible to hit on a phone with the lifted drag ghost):
  //   'place'     → any LEGAL placement that does NOT complete a line (we save the
  //                 satisfying line-clear for the next step, and keep the target
  //                 line intact so step 2 stays solvable).
  //   'lineClear' → any LEGAL placement that DOES clear ≥1 line.
  // The finger still *suggests* dropAt, but the player can drop anywhere sensible;
  // wrong drops are rejected and the piece gently returns (input.js; no fail state).
  isAcceptableDrop(trayIndex, x, y) {
    if (!this.active) return true;
    const s = this.current();
    if (!s || s.gate === 'auto') return false;
    const piece = this.game.tray[trayIndex];
    const board = this.game.board;
    if (!piece || !board || !board.canPlace(piece, x, y)) return false;
    const clears = this._wouldClear(piece, x, y);
    return s.gate === 'lineClear' ? clears : !clears;
  }

  // Would placing `piece` at (x,y) complete (clear) any row/col? Pure check via a
  // board snapshot — no mutation leaks (board has no per-frame alloc concern here).
  _wouldClear(piece, x, y) {
    const board = this.game.board;
    const snap = board.snapshot();
    board.place(piece, x, y, piece.color);
    const f = board.fullLines();
    board.restore(snap);
    return f.rows.length + f.cols.length > 0;
  }

  // ── step advancement ─────────────────────────────────────────────────────────
  // Called by input.js after a successful placement. Decide whether this step's
  // gate is satisfied and advance.
  onPlaced(res /*, trayIndex */) {
    if (!this.active) return;
    const s = this.current();
    if (!s) return;
    if (s.gate === 'place') {
      this._next();
    } else if (s.gate === 'lineClear') {
      if (res && res.lines > 0) this._next();
      // (input.js already restricts drops to dropAt, so a lineClear gate that
      //  doesn't clear shouldn't happen; if it ever does, we just wait.)
    }
  }

  _goto(i) {
    this.stepIndex = i;
    this.game.setTutorialStep(i);
    if (this.h.onStepChange) this.h.onStepChange(i);
    const s = this.steps[i];
    this._renderBanner(s ? s.text : '');
    // (re)arm an auto gate
    if (this._autoTimer) clearTimeout(this._autoTimer), (this._autoTimer = 0);
    if (s && s.gate === 'auto') {
      this._autoTimer = setTimeout(() => this._next(), s.ms || 1000);
    }
    this._pathT0 = performance.now(); // restart finger animation for the new step
  }

  _next() {
    const nextIndex = this.stepIndex + 1;
    if (nextIndex >= this.steps.length) {
      // last step done → onboarding complete (failure-proof victory).
      this.game.markTutorialClear();
      this.stop();
      this.h.overlay.style.display = 'none';
      return;
    }
    this._goto(nextIndex);
  }

  // ── LOOK: dim overlay + banner + animated finger pointer ─────────────────────
  // PLACEHOLDER look — replaced by API assets later (GLOBAL C6/C7).
  _renderBanner(text) {
    if (this.h.bannerEl) this.h.bannerEl.textContent = text || '';
  }

  // Finger pointer animates from the highlighted tray piece toward the target
  // cell, looping, to demonstrate the drag (PLACEHOLDER look — CSS dot+ring).
  _loop() {
    if (!this.active) return;
    const s = this.current();
    const finger = this.h.fingerEl;
    if (s && s.gate !== 'auto' && s.pointTo && s.dropAt) {
      finger.style.display = 'block';
      const from = this.h.traySlotCenter(s.pointTo.index);
      const to = this._dropCenter(s.dropAt, s.pointTo.index);
      if (from && to) {
        const period = 1500; // ms per loop
        const dwell = 0.18;  // fraction held at each end
        const phase = ((performance.now() - this._pathT0) % period) / period;
        let t;
        if (phase < dwell) t = 0;
        else if (phase < 0.5) t = (phase - dwell) / (0.5 - dwell);
        else if (phase < 0.5 + dwell) t = 1;
        else t = 1 - (phase - 0.5 - dwell) / (0.5 - dwell);
        const ease = t * t * (3 - 2 * t); // smoothstep
        const x = from.x + (to.x - from.x) * ease;
        const y = from.y + (to.y - from.y) * ease;
        finger.style.transform = `translate(${x}px, ${y}px)`;
        // "press" pulse at the ends
        const pressing = phase < dwell || (phase >= 0.5 && phase < 0.5 + dwell);
        finger.classList.toggle('tut-finger-press', pressing);
        // highlight the active tray slot
        this._highlightSlot(s.pointTo.index);
      }
    } else {
      finger.style.display = 'none';
      this._highlightSlot(-1);
    }
    this._raf = requestAnimationFrame(this._loop);
  }

  // Center of where the piece visually ends up: anchor the piece's bounding box at
  // dropAt and aim the finger at that box center (matches the placement anchor).
  _dropCenter(dropAt, trayIndex) {
    const piece = this.game.tray[trayIndex];
    const cs = this.h.cellSize();
    const tl = this.h.cellTopLeft(dropAt.x, dropAt.y);
    if (!tl) return null;
    let w = 1, hgt = 1;
    if (piece) { w = 0; hgt = 0; for (const [dx, dy] of piece.cells) { w = Math.max(w, dx + 1); hgt = Math.max(hgt, dy + 1); } }
    return { x: tl.x + (w * cs) / 2, y: tl.y + (hgt * cs) / 2 };
  }

  _highlightSlot(activeIndex) {
    for (let i = 0; i < this.h.traySlots.length; i++) {
      this.h.traySlots[i].el.classList.toggle('tut-hi', i === activeIndex);
    }
  }
}
