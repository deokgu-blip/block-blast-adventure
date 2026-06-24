// engine/renderer.js — LOOK LAYER (swappable, GLOBAL A6/L16).
//
// Renders the board (Canvas2D) + tray (Canvas2D per slot) using the foundation art
// SPRITES (block_*.webp on a board_panel.webp). This is the ONLY file that knows
// pixels/colors/sprites — logic (game/board/feeder) and data (config/levels) never
// touch the screen. A different look (3D, atlas) would replace ONLY this file. All
// sizing/look constants live in `look` so they are reversible via setLook (§8/L16).
//
// Geometry SSOT (GLOBAL L12/L15): the board panel image and the 8×8 cell grid share
// ONE geometry source — `geom()`. Everything that maps a board cell ↔ pixels (input
// hit-test, tutorial finger, FX centroids) reads it so the drawn blocks sit exactly
// in the panel's wells with no drift.
//
// Perf: one canvas for the board, drawn on demand (event-driven game, not a rAF
// loop) → no per-frame allocations (L13). Sprites are decoded once at construction
// (preload) and only drawImage()'d in the draw loop. DPR-aware backing store,
// CSS-pixel input coordinates (L1).

// Asset paths are RELATIVE so the game works as static files (GitHub Pages / file
// root) and when inlined into a single self-contained HTML (GLOBAL A3).
const BLOCK_FILES = {
  r: 'assets/sprites/block_r.webp',
  o: 'assets/sprites/block_o.webp',
  y: 'assets/sprites/block_y.webp',
  g: 'assets/sprites/block_g.webp',
  b: 'assets/sprites/block_b.webp',
  p: 'assets/sprites/block_p.webp',
  c: 'assets/sprites/block_c.webp',
};

const BOARD_PANEL_FILE = 'assets/sprites/board_panel.webp';

// item id → gem sprite (collect-mission markers + top-bar counter icon).
// A level's collect target.item must be one of these keys (or it falls back to a
// generic gem). Mapping lives here so the look layer owns item→sprite (A6).
export const GEM_FILES = {
  gem_diamond: 'assets/sprites/gem_diamond.webp',
  gem_pentagon: 'assets/sprites/gem_pentagon.webp',
  gem_star6: 'assets/sprites/gem_star6.webp',
  gem_starburst: 'assets/sprites/gem_starburst.webp',
  gem_diamond_green: 'assets/sprites/gem_diamond_green.webp',
  // legacy alias: older levels used "apple" as the collect item id → show a gem.
  apple: 'assets/sprites/gem_star6.webp',
};

// resolve an item id to a gem sprite path (used by HUD too). Exported so the host
// HUD can show the same icon as the board markers (single source — L15).
export function gemFileFor(itemId) {
  return GEM_FILES[itemId] || GEM_FILES.gem_star6;
}

// Normalize a tray piece's embedded gem(s) to a list of { at:[dx,dy], gem } — supports both
// the multi-gem form (piece.gems, USER REQ 2026-06-22) and the legacy single gem/gemAt.
function pieceGemList(piece) {
  if (piece && piece.gems && piece.gems.length) return piece.gems;
  if (piece && piece.gem && piece.gemAt) return [{ at: piece.gemAt, gem: piece.gem }];
  return [];
}

// preload <img>s once; callers draw only after `loaded`. Shared module-level cache
// so the board + every tray canvas reuse the same decoded bitmaps (no per-draw
// allocation, L13). Returns { get(key)->HTMLImageElement|null, ready:Promise }.
function makeImageCache() {
  const imgs = new Map();
  const pending = [];
  const load = (key, src) => {
    const im = new Image();
    const p = new Promise((res) => { im.onload = () => res(); im.onerror = () => res(); });
    im.src = src;
    imgs.set(key, im);
    pending.push(p);
  };
  for (const [k, src] of Object.entries(BLOCK_FILES)) load('block:' + k, src);
  for (const [k, src] of Object.entries(GEM_FILES)) load('gem:' + k, src);
  load('board', BOARD_PANEL_FILE);
  return {
    get(key) { const im = imgs.get(key); return im && im.complete && im.naturalWidth > 0 ? im : null; },
    ready: Promise.all(pending),
  };
}

let _imageCache = null;
function imageCache() { if (!_imageCache) _imageCache = makeImageCache(); return _imageCache; }

export const DEFAULT_LOOK = {
  // ── board panel geometry (the panel image's wells), SSOT for the cell grid ──
  panelPad: 0.02,       // outer pad = 2% (THIN frame, user req ⑬ — was 4.5%; QA mirrors this)
  cellInset: 0.03,      // gap around each EMPTY well → thin gridline (user req ⑯: tighter — was 0.045)
  // ── fallback (used until the panel sprite finishes decoding) ──
  gridBg: '#eef1f6',    // flat board background (light, user req ⑬ white theme)
  // ── per-cell MULTICOLOR blocks (USER REQ 2026-06-22): render each block in its own palette
  //    color (the reference is multicolor, varying per stage). Blue stays in the deck as one of
  //    the colors. (Was 'b' = force every block blue.) Color is purely cosmetic — no gameplay tie.
  uniformBlockKey: null,
  // ── solid-color fallbacks per palette key (if a block sprite is missing) ──
  fallbackColors: { r: '#C0392B', o: '#D8722C', y: '#E0A516', g: '#3E9E5E', b: '#3372B5', p: '#8E44AD', c: '#2A93B5' },
  ghostInvalidTint: 'rgba(255,60,60,0.45)', // red wash over an invalid ghost
  ghostValidAlpha: 0.55,   // alpha of the (sprite) ghost at a valid target
  ghostInvalidAlpha: 0.45, // alpha of the (sprite) ghost at an invalid target
  trayPieceScale: 1.0,     // tray cells FLUSH (user req ⑯ — was 0.92; draw uses a +0.5px overlap)
  trayCellRatio: 0.56,     // tray block size = this × board cell → small queue blocks that GROW to full board size on grab (reference behavior)
  gemScale: 0.52,          // small jewel inset centered on the block (not covering it)
};

export class Renderer {
  constructor(boardCanvas, look = {}) {
    this.boardCanvas = boardCanvas;
    this.b2d = boardCanvas.getContext('2d');
    this.look = { ...DEFAULT_LOOK, ...look };
    this.cols = 8; this.rows = 8;
    this.cssW = 0; this.cssH = 0; this.size = 0; this.dpr = 1;
    this.ghost = null;   // {x, y, piece, valid}
    this.flash = new Map(); // transient flash cells: cellIndex -> expiry ms
    // sprite cache (decoded once). Redraw once they finish loading.
    this.imgs = imageCache();
    this.imgs.ready.then(() => { if (this._lastState) this.draw(this._lastState); });
  }

  setLook(partial) { Object.assign(this.look, partial); this.resize(this.cssW, this.cssH); this.draw(this._lastState); }

  // size the board canvas to a CSS-pixel square; backing store scaled by DPR (L1).
  resize(cssW, cssH) {
    this.cssW = cssW; this.cssH = cssH;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.boardCanvas.width = Math.round(cssW * this.dpr);
    this.boardCanvas.height = Math.round(cssH * this.dpr);
    this.boardCanvas.style.width = cssW + 'px';
    this.boardCanvas.style.height = cssH + 'px';
    // the panel is a square; use the smaller side so it never crops.
    this.size = Math.min(cssW, cssH);
  }

  // ── GEOMETRY SSOT ───────────────────────────────────────────────────────────
  // outer pad = panelPad * panel size; inner region = the rest; 8×8 equal cells
  // across the inner region. Everything (input, tutorial, FX) reads this so the
  // drawn blocks sit centered in the panel's wells (no drift, L12).
  geom() {
    const S = this.size;
    const pad = S * this.look.panelPad;
    const inner = S - pad * 2;            // ≈91% of the panel
    const cell = inner / Math.max(this.cols, this.rows);
    return { S, pad, inner, cell, originX: pad, originY: pad };
  }

  // top-left CSS pixel of board cell (x,y) within the board canvas (SSOT).
  cellToXY(x, y) {
    const g = this.geom();
    return { x: g.originX + x * g.cell, y: g.originY + y * g.cell };
  }

  // map a CSS-pixel point (relative to the canvas) → board cell (x,y) or null.
  pointToCell(px, py) {
    const g = this.geom();
    const x = Math.floor((px - g.originX) / g.cell), y = Math.floor((py - g.originY) / g.cell);
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return null;
    return { x, y };
  }

  // size of ONE cell in CSS px (input/tutorial use this for anchor math).
  cellSize() { return this.geom().cell; }
  // origin (top-left of cell 0,0) in CSS px — consumers add this to x*cell (L12).
  cellOrigin() { const g = this.geom(); return { x: g.originX, y: g.originY }; }

  setDims(cols, rows) { this.cols = cols; this.rows = rows; this.resize(this.cssW, this.cssH); }

  // mark cleared cells to flash (PLACEHOLDER look — replaced by API assets later (GLOBAL C6/C7))
  flashCells(cellIndices, ms) {
    const until = performance.now() + ms;
    for (const i of cellIndices) this.flash.set(i, until);
  }

  // full board draw from a game.state() snapshot.
  draw(state) {
    if (!state) return;
    this._lastState = state;
    const { b2d, look, dpr } = this;
    const g = this.geom();
    b2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    b2d.clearRect(0, 0, this.cssW, this.cssH);

    // ── board panel: PROCEDURAL rounded navy panel drawn from the SAME geom() as the
    // blocks. (The external board_panel.webp painted wells WITH GAPS that did not match
    // the engine's contiguous cell grid → blocks straddled the wells. Drawing the panel
    // here removes any external geometry to drift against — blocks always sit in-cell.)
    // LIGHT theme (user req ⑬): the panel is a light-gray rounded board with a THIN frame; the
    // pad ring + the inter-cell gaps show this gray as the grid's frame + gridlines, white cells
    // sit in it. (Was a thick navy panel.) A subtle 1px border crisps the frame on a white page.
    const rad = g.S * 0.035;
    this._roundRect(0, 0, g.S, g.S, rad);
    b2d.fillStyle = '#dfe4ec'; b2d.fill();
    b2d.lineWidth = Math.max(1, g.S * 0.004);
    b2d.strokeStyle = '#cfd6e2';
    this._roundRect(0.5, 0.5, g.S - 1, g.S - 1, rad);
    b2d.stroke();

    const items = new Map(state.items.map((it) => [it.cell, it.item]));
    const now = performance.now();
    const inset = g.cell * look.cellInset;

    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const i = y * this.cols + x;
        const cx = g.originX + x * g.cell, cy = g.originY + y * g.cell;
        const px = cx + inset, py = cy + inset, sz = g.cell - inset * 2; // inset rect (empty well / gem / flash)
        const v = state.cells[i];
        const isGem = items.has(i);                  // ㊺ gem-bearing block → silver tone
        if (v !== 0) {
          // FLUSH blocks (user req ⑭): draw at the FULL cell (NO inset) so adjacent blocks
          // TOUCH like the reference; a tiny +0.5px overlap each side kills sub-pixel seams.
          // A cell carrying a gem is drawn in the SILVER gem-block tone (㊺), else uniform blue.
          this._blitBlock(b2d, cx - 0.5, cy - 0.5, g.cell + 1, (look.uniformBlockKey || v), isGem);
        } else {
          // empty cell — WHITE rounded square (⑬ light theme) INSET so the light-gray panel
          // shows through the gap as a thin GRIDLINE; the cell center == where a block lands.
          this._roundRect(px, py, sz, sz, sz * 0.16);
          b2d.fillStyle = '#ffffff'; b2d.fill();
        }

        // item marker (gem sprite + thin outline on top of the cell) — collect-mission target.
        if (isGem) this._drawGem(cx, cy, g.cell, items.get(i));

        // flash overlay on recently cleared cells (PLACEHOLDER — API assets later C6/C7)
        const exp = this.flash.get(i);
        if (exp) {
          if (now < exp) {
            const t = (exp - now) / 260;
            b2d.globalAlpha = Math.max(0, Math.min(1, t)) * 0.85;
            this._roundRect(px, py, sz, sz, sz * 0.18);
            b2d.fillStyle = '#ffffff'; b2d.fill();
            b2d.globalAlpha = 1;
          } else { this.flash.delete(i); }
        }
      }
    }

    // ── ghost preview (sprite at the target; reddish wash when invalid) ──
    if (this.ghost && this.ghost.piece) {
      const { x, y, piece, valid } = this.ghost;
      const key = (this.look.uniformBlockKey || piece.color); // palette KEY letter = block sprite key
      for (const [dx, dy] of piece.cells) {
        const gx = (x + dx), gy = (y + dy);
        if (gx < 0 || gy < 0 || gx >= this.cols || gy >= this.rows) continue;
        const cx = g.originX + gx * g.cell, cy = g.originY + gy * g.cell;
        const px = cx + inset, py = cy + inset, sz = g.cell - inset * 2;
        b2d.globalAlpha = valid ? look.ghostValidAlpha : look.ghostInvalidAlpha;
        this._drawBlock(px, py, sz, key);
        b2d.globalAlpha = 1;
        if (!valid) { // red wash to read as "can't place here"
          this._roundRect(px, py, sz, sz, sz * 0.18);
          b2d.fillStyle = look.ghostInvalidTint; b2d.fill();
        }
      }
    }

    // keep flashing while any flash is active (event-driven micro-loop)
    if (this.flash.size > 0) requestAnimationFrame(() => this.draw(this._lastState));
  }

  // draw one block sprite into a cell well; falls back to a rounded solid color.
  _drawBlock(px, py, sz, key) {
    if (this.look.uniformBlockKey) key = this.look.uniformBlockKey; // ⑲ unify block color
    this._blitBlock(this.b2d, px, py, sz, key, false);
  }

  // ── GEM-BLOCK LOOK (USER REQ 2026-06-19 ㊺): the real game shows a gem-bearing block in a
  //    SILVER/GRAY tone (not blue) + a thin OUTLINE on the gem. ──
  // a desaturated+brightened SILVER copy of the uniform block sprite, built ONCE via pixel
  // desaturation (so it works WITHOUT ctx.filter, which older iOS Safari ignores). Returns
  // null until the sprite has decoded (retried on the next draw).
  _grayBlock() {
    if (this._grayBlk !== undefined) return this._grayBlk;
    const im = this.imgs.get('block:' + (this.look.uniformBlockKey || 'b'));
    const w = im && (im.naturalWidth || im.width), h = im && (im.naturalHeight || im.height);
    if (!im || !w || !h) return null;                  // not decoded yet → retry next draw
    try {
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const c = cv.getContext('2d'); c.drawImage(im, 0, 0, w, h);
      const d = c.getImageData(0, 0, w, h), a = d.data;
      for (let i = 0; i < a.length; i += 4) {
        const lum = 0.299 * a[i] + 0.587 * a[i + 1] + 0.114 * a[i + 2];
        const g = Math.min(255, lum * 0.6 + 104);      // lift toward a light silver, keep bevel
        a[i] = g * 0.97; a[i + 1] = g * 0.985; a[i + 2] = g; // faint cool tint
      }
      c.putImageData(d, 0, 0);
      this._grayBlk = cv;
    } catch (e) { this._grayBlk = null; }               // tainted (shouldn't happen same-origin) → skip
    return this._grayBlk;
  }

  // shared block blit (any ctx): gemBlock=true → silver gem-block tone (㊺), else normal sprite.
  _blitBlock(ctx, px, py, sz, key, gemBlock) {
    const gray = gemBlock ? this._grayBlock() : null;
    if (gray) { ctx.drawImage(gray, px, py, sz, sz); return; }
    const im = this.imgs.get('block:' + key);
    if (im) { ctx.drawImage(im, px, py, sz, sz); return; }
    const col = gemBlock ? '#c3c9d3' : (this.look.fallbackColors[key] || '#888');
    const r = Math.min(sz * 0.18, sz / 2);
    ctx.beginPath(); ctx.moveTo(px + r, py); ctx.arcTo(px + sz, py, px + sz, py + sz, r);
    ctx.arcTo(px + sz, py + sz, px, py + sz, r); ctx.arcTo(px, py + sz, px, py, r);
    ctx.arcTo(px, py, px + sz, py, r); ctx.closePath(); ctx.fillStyle = col; ctx.fill();
  }

  // BLACK silhouette of a gem sprite (built once/gem, COMPOSITE-only → never taints), used to
  // stamp a thin OUTLINE behind the gem (㊺ — user req 2026-06-19: thin + black).
  _gemSilhouette(key, im) {
    this._gemSil = this._gemSil || {};
    if (this._gemSil[key]) return this._gemSil[key];
    const w = im && (im.naturalWidth || im.width), h = im && (im.naturalHeight || im.height);
    if (!im || !w || !h) return null;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const c = cv.getContext('2d');
    c.drawImage(im, 0, 0, w, h);
    c.globalCompositeOperation = 'source-in';
    c.fillStyle = '#000000'; c.fillRect(0, 0, w, h);
    this._gemSil[key] = cv;
    return cv;
  }

  // stamp a THIN black outline around a gem (8-way offset of its silhouette).
  _gemOutline(ctx, im, key, dx, dy, s) {
    const sil = this._gemSilhouette(key, im);
    if (!sil) return;
    const r = Math.max(0.75, s * 0.03);   // thinner (user req)
    const o = [[-r, 0], [r, 0], [0, -r], [0, r], [-r, -r], [r, -r], [-r, r], [r, r]];
    for (const [ax, ay] of o) ctx.drawImage(sil, dx + ax, dy + ay, s, s);
  }

  // draw a gem centered on a cell, slightly oversized (gemScale), on top of content.
  _drawGem(cx, cy, cell, itemId) {
    const key = (itemId in GEM_FILES) ? itemId : 'gem_star6';
    const im = this.imgs.get('gem:' + key);
    const s = cell * this.look.gemScale;
    const off = (cell - s) / 2;
    if (im) { this._gemOutline(this.b2d, im, key, cx + off, cy + off, s); this.b2d.drawImage(im, cx + off, cy + off, s, s); return; } // ㊺ thin outline behind the gem
    // fallback dot (sprite not yet decoded)
    this.b2d.beginPath();
    this.b2d.arc(cx + cell / 2, cy + cell / 2, cell * 0.3, 0, Math.PI * 2);
    this.b2d.fillStyle = '#ff5b5b'; this.b2d.fill();
  }

  _roundRect(x, y, w, h, r) {
    const b2d = this.b2d; r = Math.min(r, w / 2, h / 2);
    b2d.beginPath();
    b2d.moveTo(x + r, y);
    b2d.arcTo(x + w, y, x + w, y + h, r);
    b2d.arcTo(x + w, y + h, x, y + h, r);
    b2d.arcTo(x, y + h, x, y, r);
    b2d.arcTo(x, y, x + w, y, r);
    b2d.closePath();
  }

  // Build a standalone canvas of `piece` rendered at BOARD CELL SIZE, so the dragged
  // ghost is identical to what gets placed (small queue block grows to full size on
  // grab — reference). CSS-sized to the piece footprint; consumer positions it.
  makeGhostCanvas(piece) {
    const cell = this.cellSize();
    const dpr = this.dpr || Math.min(window.devicePixelRatio || 1, 2);
    let w = 0, h = 0; for (const [dx, dy] of piece.cells) { w = Math.max(w, dx + 1); h = Math.max(h, dy + 1); }
    const cssW = w * cell, cssH = h * cell;
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(cssW * dpr)); cv.height = Math.max(1, Math.round(cssH * dpr));
    cv.style.width = cssW + 'px'; cv.style.height = cssH + 'px';
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // FLUSH ghost cells (user req ⑯): full cell + a +0.5px overlap so the grabbed piece's cells
    // touch like the placed blocks (no gaps).
    const key = (this.look.uniformBlockKey || piece.color);
    const gemList = pieceGemList(piece);                 // 0..N embedded gems (㊺ / multi-gem)
    for (const [dx, dy] of piece.cells) {
      const px = dx * cell - 0.5, py = dy * cell - 0.5, sz = cell + 1;
      const isGemCell = gemList.some((g) => g.at[0] === dx && g.at[1] === dy); // ㊺ silver gem block
      this._blitBlock(ctx, px, py, sz, key, isGemCell);
    }
    // GEM-IN-QUEUE: the dragged piece shows its embedded gem(s) too.
    for (const g of gemList) this._drawGemOn(ctx, g.at[0] * cell, g.at[1] * cell, cell, g.gem);
    return cv;
  }

  // draw a single tray piece into its own small canvas, centered, with block sprites.
  drawTrayPiece(canvas, piece, palette) {
    const ctx = canvas.getContext('2d');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 64, cssH = canvas.clientHeight || 64;
    canvas.width = Math.round(cssW * dpr); canvas.height = Math.round(cssH * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (!piece) return;
    let w = 0, h = 0; for (const [dx, dy] of piece.cells) { w = Math.max(w, dx + 1); h = Math.max(h, dy + 1); }
    // UNIFORM small block size: every tray piece's cell = a fixed fraction of the BOARD
    // cell (clamped to fit the slot) → all queue blocks are the same small size and GROW
    // to full board size on grab (reference). NOT fit-to-slot (which shrank big pieces /
    // enlarged small ones inconsistently — the look the user disliked).
    const pad = 6;
    const fit = Math.min((cssW - pad * 2) / w, (cssH - pad * 2) / h);
    const boardCell = this.cellSize();
    const cell = Math.floor(boardCell > 0 ? Math.min(boardCell * this.look.trayCellRatio, fit) : fit);
    const ox = (cssW - cell * w) / 2, oy = (cssH - cell * h) / 2;
    const key = (this.look.uniformBlockKey || piece.color); // palette KEY letter (matches block sprite key)
    // FLUSH tray cells (user req ⑯): full cell with a +0.5px overlap so multi-cell pieces read
    // as solid (matches the board's flush blocks), no gaps between cells. A gem cell → silver (㊺).
    const gemList = pieceGemList(piece);                 // 0..N embedded gems (multi-gem)
    for (const [dx, dy] of piece.cells) {
      const px = ox + dx * cell - 0.5, py = oy + dy * cell - 0.5, sz = cell + 1;
      const isGemCell = gemList.some((g) => g.at[0] === dx && g.at[1] === dy);
      this._blitBlock(ctx, px, py, sz, key, isGemCell);
    }
    // GEM-IN-QUEUE: draw the embedded gem(s) on their cells (same look as a board gem).
    for (const g of gemList) this._drawGemOn(ctx, ox + g.at[0] * cell, oy + g.at[1] * cell, cell, g.gem);
  }

  // draw a gem on an ARBITRARY ctx (tray slot / drag ghost), centered on a cell rect.
  _drawGemOn(ctx, cx, cy, cell, gemId) {
    const key = (gemId in GEM_FILES) ? gemId : 'gem_star6';
    const im = this.imgs.get('gem:' + key);
    const s = cell * this.look.gemScale, off = (cell - s) / 2;
    if (im) { this._gemOutline(ctx, im, key, cx + off, cy + off, s); ctx.drawImage(im, cx + off, cy + off, s, s); return; } // ㊺ thin outline behind the gem
    ctx.beginPath(); ctx.arc(cx + cell / 2, cy + cell / 2, cell * 0.3, 0, Math.PI * 2);
    ctx.fillStyle = '#ff5b5b'; ctx.fill();
  }
}
