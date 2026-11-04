// genesis/hamster.png -> {cells,colors} by nearest palette match (cell = y*32+x, ascending).
// Writes test/fixtures/genesis.json and web/src/genesis.json.
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PALETTE_RGB, W } from './palette.ts';

export function pngToGenesis(path: URL): { cells: number[]; colors: number[] } {
  const png = PNG.sync.read(readFileSync(path));
  if (png.width !== W || png.height !== W) throw new Error('PNG must be 32x32');
  const cells: number[] = [], colors: number[] = [];
  for (let cell = 0; cell < W * W; cell++) {
    const i = cell * 4;
    if (png.data[i + 3] < 128) continue;
    let best = 0, bd = Infinity;
    PALETTE_RGB.forEach(([r, g, b], k) => {
      const d = (r - png.data[i]) ** 2 + (g - png.data[i + 1]) ** 2 + (b - png.data[i + 2]) ** 2;
      if (d < bd) { bd = d; best = k; }
    });
    cells.push(cell); colors.push(best);
  }
  return { cells, colors };
}

export function writeJson(rel: string, data: unknown) {
  const u = new URL(rel, import.meta.url);
  mkdirSync(dirname(u.pathname.replace(/^\/([A-Za-z]:)/, '$1')), { recursive: true });
  writeFileSync(u, JSON.stringify(data) + '\n');
}

if (/genesis.ts$/.test(process.argv[1] ?? '')) {
  const out = pngToGenesis(new URL('../genesis/hamster.png', import.meta.url));
  writeJson('../test/fixtures/genesis.json', out);
  writeJson('../web/src/genesis.json', out);
  console.log(`genesis: ${out.cells.length} cells`);
}
