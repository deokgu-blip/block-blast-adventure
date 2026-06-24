// engine/board.js — GRID STATE · PLACEMENT · ROW/COL CLEAR (logic layer).
// No gravity. A cell is 0 (empty) or a palette colorKey (string) when filled.
// Items (apple etc.) live in a parallel map keyed by cell index; an item is
// collected when its cell is part of a cleared line.
//
// Pure data + small helpers; no rendering, no RNG, no per-frame allocation in
// the hot query paths (uses integer cell indices, not "x,y" string keys — L13).

export class Board {
  constructor(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.size = cols * rows;
    this.cells = new Array(this.size).fill(0); // 0 | colorKey
    this.items = new Map();                     // cellIndex -> itemId
  }

  idx(x, y) { return y * this.cols + x; }
  inBounds(x, y) { return x >= 0 && y >= 0 && x < this.cols && y < this.rows; }
  get(x, y) { return this.cells[this.idx(x, y)]; }
  isEmpty(x, y) { return this.inBounds(x, y) && this.cells[this.idx(x, y)] === 0; }

  filledCount() {
    let n = 0;
    for (let i = 0; i < this.size; i++) if (this.cells[i] !== 0) n++;
    return n;
  }

  // Can `piece` be placed with its top-left at (ox,oy)?  (all cells in-bounds & empty)
  canPlace(piece, ox, oy) {
    const c = piece.cells;
    for (let i = 0; i < c.length; i++) {
      const x = ox + c[i][0], y = oy + c[i][1];
      if (!this.inBounds(x, y) || this.cells[this.idx(x, y)] !== 0) return false;
    }
    return true;
  }

  // Number of distinct (ox,oy) positions where `piece` fits (fitCount, §4.1).
  fitCount(piece) {
    let n = 0;
    for (let oy = 0; oy < this.rows; oy++)
      for (let ox = 0; ox < this.cols; ox++)
        if (this.canPlace(piece, ox, oy)) n++;
    return n;
  }

  hasAnyFit(piece) {
    for (let oy = 0; oy < this.rows; oy++)
      for (let ox = 0; ox < this.cols; ox++)
        if (this.canPlace(piece, ox, oy)) return true;
    return false;
  }

  // Place a piece (assumes canPlace). Returns the list of filled cell indices.
  // GEM-IN-QUEUE (USER REQ 2026-06-18): a tray piece may carry a gem (piece.gem = gemId at
  // cell offset piece.gemAt = [dx,dy]); placing it drops that gem onto the board (items map)
  // so clearing its line collects it — the same gem-in-block collection path as presets.
  place(piece, ox, oy, colorKey) {
    const filled = [];
    for (const [dx, dy] of piece.cells) {
      const i = this.idx(ox + dx, oy + dy);
      this.cells[i] = colorKey;
      filled.push(i);
    }
    // ONE gem per block (USER REQ 2026-06-22): a tray piece carries at most a single gem
    // (piece.gem at offset piece.gemAt). Placing it drops that gem onto the board.
    if (piece.gem && piece.gemAt) {
      this.items.set(this.idx(ox + piece.gemAt[0], oy + piece.gemAt[1]), piece.gem);
    }
    return filled;
  }

  // Find every fully-filled row and column. Returns {rows:[], cols:[]}.
  fullLines() {
    const fullRows = [], fullCols = [];
    for (let y = 0; y < this.rows; y++) {
      let full = true;
      for (let x = 0; x < this.cols; x++) if (this.cells[this.idx(x, y)] === 0) { full = false; break; }
      if (full) fullRows.push(y);
    }
    for (let x = 0; x < this.cols; x++) {
      let full = true;
      for (let y = 0; y < this.rows; y++) if (this.cells[this.idx(x, y)] === 0) { full = false; break; }
      if (full) fullCols.push(x);
    }
    return { rows: fullRows, cols: fullCols };
  }

  // Clear the given full rows/cols SIMULTANEOUSLY (intersection counted once).
  // Returns { cleared:[cellIndex...], items:[{cell,item}...], lines:n }.
  clearLines(lines) {
    const cleared = new Set();
    for (const y of lines.rows) for (let x = 0; x < this.cols; x++) cleared.add(this.idx(x, y));
    for (const x of lines.cols) for (let y = 0; y < this.rows; y++) cleared.add(this.idx(x, y));
    const collected = [];
    for (const i of cleared) {
      this.cells[i] = 0;
      if (this.items.has(i)) { collected.push({ cell: i, item: this.items.get(i) }); this.items.delete(i); }
    }
    return { cleared: [...cleared], items: collected, lines: lines.rows.length + lines.cols.length };
  }

  // Snapshot / restore — used by the feeder's survivability DFS and the tutorial's
  // _wouldClear probe. These simulations call place()+clearLines() to look ahead, and
  // clearLines() DELETES embedded gems from `items`. So the snapshot must round-trip
  // `items` too, or a look-ahead that completes a gem-bearing line would permanently
  // collect the gem during a non-committing probe (gem-in-block, GAME_DESIGN §11.3).
  snapshot() { return { cells: this.cells.slice(), items: new Map(this.items) }; }
  restore(snap) {
    const c = snap.cells;
    for (let i = 0; i < this.size; i++) this.cells[i] = c[i];
    this.items.clear();
    for (const [k, v] of snap.items) this.items.set(k, v);
  }

  // ── ALLOCATION-FREE look-ahead (PERF / L13) ──────────────────────────────────
  // The feeder's survivability + multi-clear DFS visited ~3000 nodes per refill, each
  // doing snapshot()/restore() = a 64-element Array.slice() + a new Map() PER NODE
  // (≈3000 array+Map allocs per refill → GC churn → a visible stall on a throttled
  // low-end phone). These two methods do the SAME place→detect→clear step with an
  // IN-PLACE undo that allocates NOTHING per call: the caller passes a reusable
  // `rec` scratch object (created ONCE per DFS, see feeder.js) holding fixed-size
  // index/value arrays; we record only the cells we actually touched (piece cells +
  // any cleared cells, plus any collected gem) and undo exactly those. Behaviour is
  // identical to place()+fullLines()+clearLines()+restore(); only the allocation goes.
  //
  // simPlaceClear(piece, ox, oy, rec) — assumes canPlace already checked. Fills the
  // piece, clears any completed lines, and writes the undo data into `rec`. Returns
  // the number of lines cleared (rows+cols). `rec` must expose:
  //   rec.fillIdx (Int32Array≥9)              — piece cell indices we set
  //   rec.fillN                               — how many we set
  //   rec.clrIdx (Int32Array≥cols*rows)       — cleared cell indices
  //   rec.clrVal (Array≥cols*rows)            — their prior color values
  //   rec.clrN                                — how many cleared
  //   rec.gemKey (Array), rec.gemVal (Array), rec.gemN — collected gems to re-add
  simPlaceClear(piece, ox, oy, rec, colorKey) {
    const cells = piece.cells, cols = this.cols, C = this.cells;
    // 1) fill the piece in place (record indices to undo).
    let fn = 0;
    for (let i = 0; i < cells.length; i++) {
      const idx = (oy + cells[i][1]) * cols + (ox + cells[i][0]);
      C[idx] = colorKey;
      rec.fillIdx[fn++] = idx;
    }
    rec.fillN = fn;
    // 2) detect full rows/cols (no allocation — scan directly).
    rec.clrN = 0; rec.gemN = 0;
    let lines = 0;
    // rows
    for (let y = 0; y < this.rows; y++) {
      let full = true; const base = y * cols;
      for (let x = 0; x < cols; x++) if (C[base + x] === 0) { full = false; break; }
      if (full) { lines++; for (let x = 0; x < cols; x++) this._markClear(base + x, rec); }
    }
    // cols
    for (let x = 0; x < cols; x++) {
      let full = true;
      for (let y = 0; y < this.rows; y++) if (C[y * cols + x] === 0) { full = false; break; }
      if (full) { lines++; for (let y = 0; y < this.rows; y++) this._markClear(y * cols + x, rec); }
    }
    // 3) apply the clear (intersection cells were de-duped by _markClear via the
    //    sentinel 'cleared' marker; here we actually zero them + pull any gems).
    for (let i = 0; i < rec.clrN; i++) {
      const idx = rec.clrIdx[i];
      C[idx] = 0;
      if (this.items.has(idx)) {
        rec.gemKey[rec.gemN] = idx; rec.gemVal[rec.gemN] = this.items.get(idx); rec.gemN++;
        this.items.delete(idx);
      }
    }
    return lines;
  }
  // mark a cell for clearing once (dedupe row/col intersection). We stash the prior
  // value BEFORE zeroing so undo can restore it, and use a transient 'cleared' tag on
  // the recorded value slot is unnecessary — we dedupe by checking C[idx] is already
  // queued. To dedupe without a Set, we use a tiny inline guard: a cell already added
  // has its value captured; re-adding would double-restore. We guard with a marker.
  _markClear(idx, rec) {
    // dedupe: if this idx is already queued (intersection), skip. Linear scan is fine
    // — clrN is small (≤ a few lines × 8), and this avoids a per-call Set allocation.
    for (let i = 0; i < rec.clrN; i++) if (rec.clrIdx[i] === idx) return;
    rec.clrIdx[rec.clrN] = idx;
    rec.clrVal[rec.clrN] = this.cells[idx];
    rec.clrN++;
  }
  // Undo a simPlaceClear in reverse: re-fill cleared cells with their prior color,
  // re-add collected gems, then clear the piece cells. Restores the EXACT prior state.
  simUndo(rec) {
    const C = this.cells;
    for (let i = 0; i < rec.clrN; i++) C[rec.clrIdx[i]] = rec.clrVal[i];
    for (let i = 0; i < rec.gemN; i++) this.items.set(rec.gemKey[i], rec.gemVal[i]);
    for (let i = 0; i < rec.fillN; i++) C[rec.fillIdx[i]] = 0;
  }
  // Allocate a reusable undo record sized for this board (created ONCE per DFS).
  makeSimRec() {
    const cap = this.size + 16;
    return {
      fillIdx: new Int32Array(16), fillN: 0,
      clrIdx: new Int32Array(cap), clrVal: new Array(cap), clrN: 0,
      gemKey: new Array(cap), gemVal: new Array(cap), gemN: 0,
    };
  }

  // Largest connected empty region (flood fill) → used for fragmentation metric.
  // Returns the max empty-component size in cells.
  maxEmptyRegion() {
    const seen = new Uint8Array(this.size);
    let best = 0;
    const stack = [];
    for (let s = 0; s < this.size; s++) {
      if (this.cells[s] !== 0 || seen[s]) continue;
      let count = 0; stack.length = 0; stack.push(s); seen[s] = 1;
      while (stack.length) {
        const i = stack.pop(); count++;
        const x = i % this.cols, y = (i / this.cols) | 0;
        if (x > 0 && this.cells[i - 1] === 0 && !seen[i - 1]) { seen[i - 1] = 1; stack.push(i - 1); }
        if (x < this.cols - 1 && this.cells[i + 1] === 0 && !seen[i + 1]) { seen[i + 1] = 1; stack.push(i + 1); }
        if (y > 0 && this.cells[i - this.cols] === 0 && !seen[i - this.cols]) { seen[i - this.cols] = 1; stack.push(i - this.cols); }
        if (y < this.rows - 1 && this.cells[i + this.cols] === 0 && !seen[i + this.cols]) { seen[i + this.cols] = 1; stack.push(i + this.cols); }
      }
      if (count > best) best = count;
    }
    return best;
  }
}
