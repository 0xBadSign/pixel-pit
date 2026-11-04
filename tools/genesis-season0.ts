// ~30-cell subset (evenly strided over the full genesis) -> script/genesis-season0.json
import { pngToGenesis, writeJson } from './genesis.ts';

const full = pngToGenesis(new URL('../genesis/hamster.png', import.meta.url));
const TARGET = 30;
const step = full.cells.length / TARGET;
const pick = Array.from({ length: TARGET }, (_, k) => Math.floor(k * step));
const out = { cells: pick.map((i) => full.cells[i]), colors: pick.map((i) => full.colors[i]) };
writeJson('../script/genesis-season0.json', out);
console.log(`season0 genesis: ${out.cells.length} cells`);
