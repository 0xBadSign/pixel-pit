// genesis/hamster.txt (ASCII) -> genesis/hamster.png. '#'=13 brown, 'e'=1 white, 'n'=4 red, '.'=transparent.
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { PALETTE_RGB, W } from './palette.ts';

const MAP: Record<string, number> = { '#': 13, e: 1, n: 4 };
const rows = readFileSync(new URL('../genesis/hamster.txt', import.meta.url), 'utf8').trimEnd().split('\n');
if (rows.length !== W || rows.some((r) => r.length !== W)) throw new Error('hamster.txt must be 32x32');
const png = new PNG({ width: W, height: W });
let n = 0;
for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
  const i = (y * W + x) * 4, c = rows[y][x];
  if (c === '.') { png.data.fill(0, i, i + 4); continue; }
  const idx = MAP[c]; if (idx === undefined) throw new Error(`bad char ${c} at ${x},${y}`);
  const [r, g, b] = PALETTE_RGB[idx];
  png.data[i] = r; png.data[i + 1] = g; png.data[i + 2] = b; png.data[i + 3] = 255; n++;
}
writeFileSync(new URL('../genesis/hamster.png', import.meta.url), PNG.sync.write(png));
console.log(`hamster.png written, ${n} cells`);
