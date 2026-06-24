// Bake CSS `filter: saturate(1.5) contrast(1.12)` into block sprites.
// CSS filter pipeline (per spec) operates on gamma-encoded sRGB [0..1], in ORDER:
//   1) saturate(S): the W3C saturate matrix (a 3x3 applied to RGB).
//   2) contrast(C): out = (in - 0.5)*C + 0.5, per channel, clamped.
// Alpha is untouched. This reproduces what Safari/Chrome show on screen.
import sharp from '/Users/supercent/nanoclo/나노클로-B/node_modules/sharp/lib/index.js';

const S = 1.5;     // saturate(1.5)
const C = 1.12;    // contrast(1.12)
const SRC_DIR = '/Users/supercent/nanoclo/나노클로-B/games/block-blast/assets/_raw/sprites_prefilter';
const OUT_DIR = '/Users/supercent/nanoclo/나노클로-B/games/block-blast/assets/sprites';
const FILES = ['block_b','block_r','block_g','block_y','block_o','block_p','block_c'];

// W3C saturate matrix coefficients (https://www.w3.org/TR/filter-effects-1/#saturateEquivalent)
// R' = (0.213 + 0.787s)R + (0.715 - 0.715s)G + (0.072 - 0.072s)B
// G' = (0.213 - 0.213s)R + (0.715 + 0.285s)G + (0.072 - 0.072s)B
// B' = (0.213 - 0.213s)R + (0.715 - 0.715s)G + (0.072 + 0.928s)B
function satMatrix(s){
  return [
    0.213+0.787*s, 0.715-0.715*s, 0.072-0.072*s,
    0.213-0.213*s, 0.715+0.285*s, 0.072-0.072*s,
    0.213-0.213*s, 0.715-0.715*s, 0.072+0.928*s,
  ];
}
const M = satMatrix(S);
const clamp = v => v<0?0:(v>255?255:v);

for (const name of FILES){
  const src = `${SRC_DIR}/${name}.webp`;
  const out = `${OUT_DIR}/${name}.webp`;
  const img = sharp(src);
  const { width, height } = await img.metadata();
  const { data } = await img.raw().toBuffer({ resolveWithObject:true });
  // data is RGBA (4 ch) — sharp raw on RGBA webp
  const ch = data.length/(width*height);
  for (let i=0;i<data.length;i+=ch){
    const r=data[i], g=data[i+1], b=data[i+2];
    // 1) saturate (operates on 0..255 directly — matrix is linear in value space)
    let r1 = M[0]*r + M[1]*g + M[2]*b;
    let g1 = M[3]*r + M[4]*g + M[5]*b;
    let b1 = M[6]*r + M[7]*g + M[8]*b;
    // 2) contrast: out = (in/255 - 0.5)*C + 0.5, back to 0..255
    r1 = ((r1/255 - 0.5)*C + 0.5)*255;
    g1 = ((g1/255 - 0.5)*C + 0.5)*255;
    b1 = ((b1/255 - 0.5)*C + 0.5)*255;
    data[i]   = clamp(Math.round(r1));
    data[i+1] = clamp(Math.round(g1));
    data[i+2] = clamp(Math.round(b1));
    // alpha (data[i+3]) unchanged
  }
  await sharp(data, { raw:{ width, height, channels:ch } })
    .webp({ quality:92, alphaQuality:100, effort:6 })
    .toFile(out);
  console.error(`baked ${name} (${width}x${height}, ch=${ch})`);
}
console.error('done');
