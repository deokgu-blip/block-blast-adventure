// Build a clean, TEXT-FREE key-visual seed image for the promo video (image-to-video seed).
// Composites the real game assets (glossy blue blocks + board panel + gems) on the game's
// blue gradient background. Portrait 9:16 (720x1280). No text/UI/logos.
import sharp from 'sharp';
import path from 'node:path';

const SPR = '/Users/supercent/nanoclo/나노클로-B/games/block-blast/assets/sprites';
const OUT = process.argv[2] || '/Users/supercent/nanoclo/나노클로-B/games/block-blast/assets/promo/seed_keyvisual.png';

const W = 720, H = 1280;

// Page background: blue gradient (top #3E6DD6 -> bottom #2A4FA0) per ART_STYLE.md
const bgSvg = `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#3E6DD6"/>
      <stop offset="1" stop-color="#2A4FA0"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#bg)"/>
</svg>`;

// Board: dark navy rounded panel 8x8, centered
const BOARD = 600;             // board pixel size
const BX = Math.round((W - BOARD) / 2);
const BY = 360;                // top of board
const PAD = 18;                // inner padding of grid inside panel
const CELLS = 8;
const cell = (BOARD - PAD * 2) / CELLS;

const boardSvg = `<svg width="${BOARD}" height="${BOARD}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${BOARD}" height="${BOARD}" rx="40" ry="40" fill="#1F2B49"/>
  <rect x="6" y="6" width="${BOARD-12}" height="${BOARD-12}" rx="34" ry="34" fill="#243152"/>
  ${Array.from({length: CELLS+1}).map((_,i)=>{
    const p = PAD + i*cell;
    return `<line x1="${PAD}" y1="${p}" x2="${BOARD-PAD}" y2="${p}" stroke="#33436b" stroke-width="2"/>`+
           `<line x1="${p}" y1="${PAD}" x2="${p}" y2="${BOARD-PAD}" stroke="#33436b" stroke-width="2"/>`;
  }).join('')}
</svg>`;

function cellXY(col, row){
  return { x: BX + PAD + col*cell, y: BY + PAD + row*cell };
}

const composites = [];

// Board panel
composites.push({ input: Buffer.from(boardSvg), left: BX, top: BY });

// Place glossy blue blocks to suggest near-complete rows (juicy "about to clear" vibe)
const blockBuf = await sharp(path.join(SPR,'block_b.webp')).resize(Math.round(cell), Math.round(cell)).png().toBuffer();
const filled = [
  // row 3 nearly full (a satisfying line about to clear)
  [0,3],[1,3],[2,3],[3,3],[4,3],[5,3],[6,3],
  // a column build
  [2,4],[2,5],[2,6],
  // scattered toy stacks
  [5,5],[6,5],[5,6],[6,6],
  [0,6],[1,6],[0,5],
  [4,1],[5,1],[4,2],[5,2],
];
for (const [c,r] of filled){
  const {x,y} = cellXY(c,r);
  composites.push({ input: blockBuf, left: Math.round(x), top: Math.round(y) });
}

// A couple of glossy gems sitting on cells (collect targets) — adds the gem highlight
const gemD = await sharp(path.join(SPR,'gem_diamond.webp')).resize(Math.round(cell*0.95), Math.round(cell*0.95)).png().toBuffer();
const gemS = await sharp(path.join(SPR,'gem_star6.webp')).resize(Math.round(cell*0.95), Math.round(cell*0.95)).png().toBuffer();
{
  const a = cellXY(3,1); composites.push({ input: gemD, left: Math.round(a.x+cell*0.02), top: Math.round(a.y+cell*0.02) });
  const b = cellXY(1,4); composites.push({ input: gemS, left: Math.round(b.x+cell*0.02), top: Math.round(b.y+cell*0.02) });
}

// A floating "next piece" cluster below the board (tray vibe) — three blue blocks
for (const [i,off] of [[0,-160],[1,0],[2,160]]){
  const tx = W/2 + off - cell/2;
  const ty = BY + BOARD + 70;
  composites.push({ input: blockBuf, left: Math.round(tx), top: Math.round(ty) });
}

await sharp(Buffer.from(bgSvg))
  .composite(composites)
  .png()
  .toFile(OUT);

console.log('OK seed:', OUT, `${W}x${H}`);
