// engine/pieces.js — PIECE LIBRARY (data layer, GAME_DESIGN §2.1).
// Standard Block-Blast polyomino set. Rotations are PRE-EXPANDED as distinct ids
// (no runtime rotation) → deterministic + easy headless QA.
//
//   cells:   [[dx,dy], ...]  relative to the piece's top-left bounding cell.
//   sizeTag: xs | s | m | l   (used by the feeder to bias difficulty by area).
//
// The `color` of a placed piece is chosen from the LEVEL palette at feed time,
// so this file stays look-agnostic (only shape + difficulty class here).

export const PIECES = [
  // 1 cell
  { id: 'dot',      sizeTag: 'xs', cells: [[0, 0]] },

  // 2 cells
  { id: 'dom_h',    sizeTag: 's',  cells: [[0, 0], [1, 0]] },
  { id: 'dom_v',    sizeTag: 's',  cells: [[0, 0], [0, 1]] },

  // 3 cells — lines + the four L-corners (corner_* = 3-cell right angle)
  { id: 'tri_h',    sizeTag: 's',  cells: [[0, 0], [1, 0], [2, 0]] },
  { id: 'tri_v',    sizeTag: 's',  cells: [[0, 0], [0, 1], [0, 2]] },
  { id: 'corner_ne', sizeTag: 's', cells: [[0, 0], [1, 0], [0, 1]] },
  { id: 'corner_nw', sizeTag: 's', cells: [[0, 0], [1, 0], [1, 1]] },
  { id: 'corner_se', sizeTag: 's', cells: [[0, 1], [1, 1], [1, 0]] },
  { id: 'corner_sw', sizeTag: 's', cells: [[0, 0], [0, 1], [1, 1]] },
  // 3-cell DIAGONAL staircases (corner-touching) — USER REQ 2026-06-18 (IMG_3002). These
  // were missing from the library (so they never appeared). Cells are corner-connected; the
  // engine has no edge-connectivity requirement so they place/clear normally.
  { id: 'diag_a',   sizeTag: 's',  cells: [[0, 2], [1, 1], [2, 0]] }, // ↗
  { id: 'diag_b',   sizeTag: 's',  cells: [[0, 0], [1, 1], [2, 2]] }, // ↘

  // 4 cells — lines, 2x2, and tetromino set (J/L/S/Z/T, both orientations of the
  // asymmetric ones expanded as distinct ids)
  { id: 'line4_h',  sizeTag: 'm',  cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
  { id: 'line4_v',  sizeTag: 'm',  cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
  { id: 'square2',  sizeTag: 'm',  cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },

  { id: 'T_up',     sizeTag: 'm',  cells: [[0, 1], [1, 1], [2, 1], [1, 0]] },
  { id: 'T_down',   sizeTag: 'm',  cells: [[0, 0], [1, 0], [2, 0], [1, 1]] },
  { id: 'T_left',   sizeTag: 'm',  cells: [[1, 0], [1, 1], [1, 2], [0, 1]] },
  { id: 'T_right',  sizeTag: 'm',  cells: [[0, 0], [0, 1], [0, 2], [1, 1]] },

  { id: 'J_a',      sizeTag: 'm',  cells: [[1, 0], [1, 1], [1, 2], [0, 2]] },
  { id: 'J_b',      sizeTag: 'm',  cells: [[0, 0], [0, 1], [1, 1], [2, 1]] },
  { id: 'L_a',      sizeTag: 'm',  cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
  { id: 'L_b',      sizeTag: 'm',  cells: [[0, 0], [1, 0], [2, 0], [0, 1]] },

  { id: 'S_h',      sizeTag: 'm',  cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
  { id: 'S_v',      sizeTag: 'm',  cells: [[0, 0], [0, 1], [1, 1], [1, 2]] },
  { id: 'Z_h',      sizeTag: 'm',  cells: [[0, 0], [1, 0], [1, 1], [2, 1]] },
  { id: 'Z_v',      sizeTag: 'm',  cells: [[1, 0], [0, 1], [1, 1], [0, 2]] },

  // 5 cells — lines, plus, big L
  { id: 'line5_h',  sizeTag: 'l',  cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] },
  { id: 'line5_v',  sizeTag: 'l',  cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] },
  { id: 'plus',     sizeTag: 'l',  cells: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]] },
  // (L5_a removed by USER REQ 2026-06-18 — the "4-in-a-column + one foot" shape kept
  //  reappearing in the tray; the user wants it gone like its mirror below.)
  // (L5_b removed by USER REQ — the "4-in-a-row + one cell below the leftmost" shape.)
  { id: 'corner_big', sizeTag: 'l', cells: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]] },

  // 6 cells — big rectangles (the "satisfying box" pieces). sizeTag 'l' but their
  // ACTUAL area is 6 cells — size math must use piece.cells.length / pieceBounds,
  // never assume l==6 (square3 below is 9). USER REQ #1.
  { id: 'rect2x3',  sizeTag: 'l',  cells: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2], [1, 2]] }, // 2 wide × 3 tall
  { id: 'rect3x2',  sizeTag: 'l',  cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1]] }, // 3 wide × 2 tall

  // 9 cells — 3x3
  { id: 'square3',  sizeTag: 'l',  cells: [[0, 0], [1, 0], [2, 0], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2], [2, 2]] },
];

// id → piece lookup (built once).
export const PIECE_BY_ID = Object.freeze(
  PIECES.reduce((m, p) => { m[p.id] = p; return m; }, {})
);

// Coarse area-by-tag — kept only as a NOMINAL ordering hint. NOTE: the 'l' tag now
// covers 5-cell (line5/plus/L5), 6-cell (rect2x3/rect3x2) AND 9-cell (square3)
// pieces, so it is NOT a true cell count. Size math in the feeder uses the REAL
// `pieceArea()` (cells.length) below — never `SIZE_AREA['l'] == 6` (USER REQ #1).
export const SIZE_AREA = { xs: 1, s: 3, m: 4, l: 6 };

// True area = actual filled-cell count (the only correct size for shaping math).
export function pieceArea(piece) { return piece.cells.length; }

// The "satisfying big box" set the space-aware bias favours on roomy boards
// (USER REQ #2): the 3×3 (9 cells), 2×3 and 3×2 rectangles (6 cells each).
export const BIG_BOX_IDS = Object.freeze(['square3', 'rect2x3', 'rect3x2']);
const _BIG_BOX_SET = new Set(BIG_BOX_IDS);
export function isBigBox(piece) { return _BIG_BOX_SET.has(piece.id); }

// Bounding-box dimensions of a piece (cached).
export function pieceBounds(piece) {
  let w = 0, h = 0;
  for (const [dx, dy] of piece.cells) {
    if (dx + 1 > w) w = dx + 1;
    if (dy + 1 > h) h = dy + 1;
  }
  return { w, h };
}
