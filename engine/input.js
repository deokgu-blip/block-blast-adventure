// engine/input.js — DRAG INPUT (tray → board), pointer events (GAME_DESIGN §7).
//
// One-hand touch + mouse-drag on desktop (Pointer Events). On pointerdown over a
// tray slot we lift that piece; while dragging we show a ghost on the board (valid
// / invalid). On release over a valid board location we call game.placeAt().
//
// Look-agnostic: it talks to the renderer for cell hit-testing + ghost state, and
// to the game for the logical placement. It owns no game rules.
//
// Mobile nicety: the dragged piece is shown a fixed offset ABOVE the finger so it
// is not hidden under the thumb (lift = pieceLiftPx).
//
// HAPTICS (additive juice — works in BOTH solo web via navigator.vibrate AND reels via
// the host signal; see engine/hostbridge.js): a light 'selection' tick when the dragged
// ghost snaps to a NEW valid placement (preview-snap moment), and a 'light' buzz on a
// committed drop (place). haptic() is internally throttled so dragging across cells
// doesn't machine-gun; we also only tick when the snapped cell actually CHANGES.
import { haptic } from './hostbridge.js?v=20260624123400';

export class DragInput {
  constructor({ stage, boardCanvas, traySlots, renderer, game, onPlaced, onChange, tutorial, effects }) {
    this.stage = stage;            // #stage box (positioning reference)
    this.boardCanvas = boardCanvas;
    this.traySlots = traySlots;    // array of {el, canvas} per tray index
    this.renderer = renderer;
    this.game = game;
    this.onPlaced = onPlaced || (() => {});
    this.onChange = onChange || (() => {}); // re-render hook
    this.tutorial = tutorial || null; // onboarding controller (gates input, §10.2)
    this.effects = effects || null; // FX director (line-clear preview during drag, CHANGE 1)
    this.pieceLiftPx = 120;        // raise dragged piece WELL above finger (㉚; QA mirrors this)
    this.drag = null;              // { trayIndex, piece, ghostEl }
    // FIX C: while the HOST is delaying the visual appearance of a freshly refilled
    // tray (so the player first sees the last block land + its line clear), the new
    // pieces must NOT be grabbable. The host toggles this gate; logical game.tray is
    // unaffected (it already holds the new pieces). Defaults to NOT suppressed.
    this.traySuppressed = false;
    // BOOT GATE (USER REPORT 2026-06-23): a grab during the heavy first-load main-thread
    // work has its move/up dropped by iOS WKWebView → the piece lifts but is stuck. The host
    // holds this false until the boot thread is free (sprites ready + first paint), so the
    // FIRST grab can only start once events flow reliably. Defaults true → non-reels/normal
    // boot (fast) is unaffected unless the host explicitly gates.
    this._ready = true;
    this._bind();
  }

  setEffects(effects) { this.effects = effects || null; }

  // BOOT GATE: the host sets this false on entry and true once the first-load main-thread
  // work has settled, so a doomed drag can't start during the saturation window.
  setReady(v) { this._ready = !!v; }

  // FIX C — host gate: when true, pointerdown on a tray slot is ignored (the new,
  // not-yet-shown pieces can't be grabbed during the refill-reveal delay).
  setTraySuppressed(v) { this.traySuppressed = !!v; }

  setGame(game) { this.game = game; }
  setTutorial(tutorial) { this.tutorial = tutorial || null; }
  setOnPlaced(fn) { this.onPlaced = fn || (() => {}); }

  _bind() {
    for (let i = 0; i < this.traySlots.length; i++) {
      const slot = this.traySlots[i];
      slot.el.addEventListener('pointerdown', (ev) => this._down(ev, i));
    }
    window.addEventListener('pointermove', (ev) => this._move(ev));
    window.addEventListener('pointerup', (ev) => this._up(ev));
    // SAFETY NET ONLY (CHANGE 2): with setPointerCapture set on pointerdown, the
    // browser no longer fires pointercancel just because the touch leaves the
    // origin tray slot (that was the root cause of mid-drag cancel on mobile).
    // This handler is now a last resort (e.g. OS-level gesture interruption) and
    // should not fire on a normal out-of-grid move. It returns the piece to the tray.
    window.addEventListener('pointercancel', () => this._cancel());
  }

  _down(ev, trayIndex) {
    if (this.game.over || this.game.cleared) return;
    // BOOT GATE: not grabbable until the first-load main-thread work has settled (see _ready).
    if (!this._ready) return;
    // SAFETY NET (USER REPORT 2026-06-23): if a previous drag was orphaned — iOS WKWebView
    // dropped its move/up events during a boot-saturation hitch, leaving the lifted ghost
    // stuck with no release — a fresh pointerdown tears it down first, so the player recovers
    // by simply tapping again instead of being locked out. No-op when there's no stale drag.
    if (this.drag) this._cancel();
    // FIX C: during the refill-reveal delay the new tray pieces aren't shown yet →
    // they must not be grabbable (the player can't drag a piece they can't see).
    if (this.traySuppressed) return;
    // tutorial gating: only the current step's pointTo piece is draggable (§10.2)
    if (this.tutorial && !this.tutorial.isDraggable(trayIndex)) return;
    const piece = this.game.tray[trayIndex];
    if (!piece) return;
    ev.preventDefault();
    // CHANGE 2 — capture the pointer on the originating tray slot so the drag
    // SURVIVES the touch/pointer leaving that element (without capture, mobile
    // fires pointercancel the moment the finger leaves the slot → the piece would
    // snap back mid-hold). With capture, ALL subsequent move/up events are routed
    // here until release, so the held piece is NEVER canceled until pointerup —
    // no matter where the pointer goes (outside the grid/board/anywhere). The
    // capture is released automatically by the browser on pointerup/pointercancel.
    const slotEl = this.traySlots[trayIndex].el;
    let captured = false;
    try { slotEl.setPointerCapture(ev.pointerId); captured = true; } catch (_) { /* capture unsupported → fall back */ }
    // floating clone follows the pointer
    // The floating held piece, rendered at BOARD CELL SIZE so the dragged block ==
    // the placed block (a small queue block GROWS to full size on grab — reference).
    // Appended to <body> as position:fixed so it is NEVER clipped off-field.
    const ghostEl = this.renderer.makeGhostCanvas(piece);
    ghostEl.className = 'drag-ghost';
    document.body.appendChild(ghostEl);
    const gw = parseFloat(ghostEl.style.width) || ghostEl.offsetWidth || 90;
    const gh = parseFloat(ghostEl.style.height) || ghostEl.offsetHeight || 90;
    this.drag = {
      trayIndex, piece, ghostEl, startedFromTray: true, pointerId: ev.pointerId, slotEl, captured,
      gw, gh,            // cached ghost size (no per-move layout read)
      lastGhost: null,   // last board-preview cell (redraw only on change)
    };
    slotEl.classList.add('lifted');
    this._positionGhost(ev);
    this._updateBoardGhost(ev);
  }

  _move(ev) {
    if (!this.drag) return;
    // SINGLE-DRAG MODEL: one held piece at a time (setPointerCapture already routes
    // our pointer here). We intentionally do NOT hard-gate on ev.pointerId ===
    // this.drag.pointerId — iOS WKWebView can deliver move/up with a DRIFTED
    // pointerId right after load (busy main thread during sprite decode), which made
    // the ghost freeze (no move = "드래그 안 됨") and orphan (no up = "취소 안 됨"),
    // locking the tutorial on the very first touch. Driving the drag with whatever
    // pointer is moving fixes that; the cost (a 2nd finger could nudge the ghost) is
    // far less broken than an unrecoverable stuck piece.
    ev.preventDefault();
    // CHANGE 2: a move NEVER cancels — it only updates the floating ghost + the
    // board preview, even when the pointer is far outside the grid/board. The drag
    // is resolved ONLY on release (_up).
    this._positionGhost(ev);
    this._updateBoardGhost(ev);
  }

  _up(ev) {
    if (!this.drag) return;
    // See _move: do NOT bail on pointerId mismatch. A drifted-id pointerup must
    // still resolve the drag (commit-or-cancel) so the floating ghost + board
    // preview are never left stuck on screen — that was the tutorial lock bug.
    const { trayIndex, piece } = this.drag;
    const cell = this._boardCellAt(ev, piece);
    let placed = false;
    // tutorial: only snap-accept a drop near the current step's dropAt; wrong
    // drops gently return (no fail state, §10.2). The placement must also be
    // legal on the board.
    const tutOk = !this.tutorial || (cell && this.tutorial.isAcceptableDrop(trayIndex, cell.x, cell.y));
    if (tutOk && cell && this.game.canPlaceAt(trayIndex, cell.x, cell.y)) {
      const res = this.game.placeAt(trayIndex, cell.x, cell.y);
      placed = res.ok;
      if (placed) {
        haptic('light');                 // PLACE: a light buzz on a committed drop (juice)
        this.onPlaced(res, trayIndex);
        if (this.tutorial) this.tutorial.onPlaced(res, trayIndex);
      }
    }
    this._cancel();
    this.onChange();
  }

  // Internal teardown — clears the floating ghost + board preview and releases the
  // pointer capture. This is NOT a user-facing "cancel the drag" path: it runs
  // after a RELEASE (pointerup, whether the piece placed or returned) and as the
  // pointercancel safety net. Nothing in _move calls this, so a held drag is never
  // torn down mid-hold (CHANGE 2).
  _cancel() {
    if (!this.drag) return;
    const { ghostEl, slotEl, pointerId, captured } = this.drag;
    ghostEl.remove();
    this.traySlots[this.drag.trayIndex].el.classList.remove('lifted');
    // release the captured pointer (no-op if the browser already released it on up)
    if (captured && slotEl) { try { slotEl.releasePointerCapture(pointerId); } catch (_) { /* already released */ } }
    this.drag = null;
    // hide the line-clear preview on release/cancel (CHANGE 1) — the post-clear
    // burst (if any) is fired separately by the game's onLineClear event.
    if (this.effects) this.effects.hideLinePreview();
    this.renderer.ghost = null;
    this.renderer.draw(this.renderer._lastState);
  }

  _positionGhost(ev) {
    // viewport-fixed + GPU transform (no layout reflow) → smooth, non-stiff drag, and
    // never clipped by #stage's overflow:hidden. The piece is lifted above the finger.
    const g = this.drag.ghostEl;
    const x = ev.clientX - this.drag.gw / 2;
    const y = ev.clientY - this.pieceLiftPx - this.drag.gh / 2;
    g.style.transform = `translate3d(${x}px, ${y}px, 0)`;
  }

  // map the pointer (CSS px, L1) to the board cell where the piece's TOP-LEFT goes.
  // We anchor the piece so that its visual centre sits at the lifted pointer point.
  _boardCellAt(ev, piece) {
    const rect = this.boardCanvas.getBoundingClientRect();
    const cell = this.renderer.cellSize();
    const origin = this.renderer.cellOrigin(); // board grid starts at the panel pad (L12 SSOT)
    // pointer position over the board, lifted (matches the floating ghost),
    // measured from the cell-grid ORIGIN (not the canvas edge — the panel has padding)
    const px = ev.clientX - rect.left - origin.x;
    const py = ev.clientY - rect.top - this.pieceLiftPx - origin.y;
    // piece bbox to centre the anchor
    let w = 0, h = 0; for (const [dx, dy] of piece.cells) { w = Math.max(w, dx + 1); h = Math.max(h, dy + 1); }
    const ox = Math.round((px - (w * cell) / 2) / cell);
    const oy = Math.round((py - (h * cell) / 2) / cell);
    if (ox < 0 || oy < 0) return { x: ox, y: oy }; // out → invalid (caller checks)
    return { x: ox, y: oy };
  }

  _updateBoardGhost(ev) {
    const { piece, trayIndex } = this.drag;
    const cell = this._boardCellAt(ev, piece);
    const gx = cell ? cell.x : -99, gy = cell ? cell.y : -99;
    const valid = !!(cell && this.game.canPlaceAt(trayIndex, cell.x, cell.y));
    // PERF (fixes "stiff" drag): the board canvas is heavy to redraw (panel + 64 wells
    // + blocks). Only redraw when the target cell or validity actually CHANGES — not on
    // every pixel of pointer movement. The floating ghost (transform) stays smooth.
    const last = this.drag.lastGhost;
    if (last && last.x === gx && last.y === gy && last.valid === valid) return;
    // PREVIEW-SNAP haptic (juice): the ghost just transitioned to a NEW board cell/validity.
    // Tick only when it's a VALID landing and the snapped position actually changed (a new
    // valid cell, or invalid→valid) — so sliding across blocked cells stays silent. haptic()
    // is throttled internally so a fast drag across valid cells doesn't machine-gun.
    if (valid && (!last || !last.valid || last.x !== gx || last.y !== gy)) haptic('selection');
    this.drag.lastGhost = { x: gx, y: gy, valid };
    // Only show the on-board landing preview where the piece ACTUALLY fits. If the spot
    // is blocked (overlaps other blocks) or out of bounds, show NO ghost — the user does
    // not want a preview at places the block can't be placed (it just reads as noise).
    this.renderer.ghost = valid ? { x: gx, y: gy, piece, valid } : null;
    // line-clear PREVIEW (CHANGE 1): at a VALID placement, simulate the drop on a
    // board snapshot and ask which row(s)/col(s) WOULD complete → glow exactly those
    // lines (steady, before release). Non-clearing/invalid spots hide it. This runs
    // ONLY here (change-gated above), so it never does per-pixel work; the snapshot/
    // restore touches one Array slice + the placed cells (cheap, ≤9 cells).
    if (this.effects) {
      if (valid) {
        const lines = this._previewLinesAt(piece, gx, gy);
        if (lines && (lines.rows.length || lines.cols.length)) this.effects.showLinePreview(lines.rows, lines.cols);
        else this.effects.hideLinePreview();
      } else {
        this.effects.hideLinePreview();
      }
    }
    this.renderer.draw(this.renderer._lastState);
  }

  // Which rows/cols would COMPLETE if `piece` were placed with its top-left at
  // (ox,oy)? Simulates on a board snapshot (no commit), reading the SAME canPlace/
  // place/fullLines/snapshot/restore the logic layer uses (look-agnostic, no rules
  // duplicated here). Returns {rows:[],cols:[]} or null when the placement is illegal.
  _previewLinesAt(piece, ox, oy) {
    const board = this.game.board;
    if (!board.canPlace(piece, ox, oy)) return null;
    const snap = board.snapshot();
    board.place(piece, ox, oy, piece.color);
    const lines = board.fullLines();
    board.restore(snap);
    return lines;
  }
}
