// Cell record codec (SPEC §5.2 bit map) and frame(h) replay (SPEC §6.3).
import { CELLS } from './config';
import type { Hex } from 'viem';

export type Cell = {
  color: number; // 0..15
  crew: number; // 0..3
  genesis: boolean;
  painterId: number; // 24-bit; 0 = genesis or unpainted
};

/** color = rec & 0xF, crew = (rec >> 4) & 3, genesis = (rec >> 6) & 1, painterId = rec >> 8 */
export function decodeCell(rec: number): Cell {
  const r = rec >>> 0;
  return {
    color: r & 0xf,
    crew: (r >>> 4) & 3,
    genesis: ((r >>> 6) & 1) === 1,
    painterId: r >>> 8,
  };
}

/** rec = (painterId << 8) | (genesis ? 0x40 : 0) | (crew << 4) | color */
export function encodeCell(c: Cell): number {
  if (c.color < 0 || c.color > 15) throw new RangeError(`color ${c.color}`);
  if (c.crew < 0 || c.crew > 3) throw new RangeError(`crew ${c.crew}`);
  if (c.painterId < 0 || c.painterId > 0xffffff) throw new RangeError(`painterId ${c.painterId}`);
  return (((c.painterId << 8) | (c.genesis ? 0x40 : 0) | (c.crew << 4) | c.color) >>> 0);
}

/** rawCells(): 128 words, 8 cells per word, 32 bits per cell. word = cell >> 3, shift = (cell & 7) << 5. */
export function decodeRawCells(words: readonly bigint[]): Uint32Array {
  if (words.length !== 128) throw new RangeError(`rawCells: expected 128 words, got ${words.length}`);
  const out = new Uint32Array(CELLS);
  for (let cell = 0; cell < CELLS; cell++) {
    const w = words[cell >> 3]!;
    const shift = BigInt((cell & 7) << 5);
    out[cell] = Number((w >> shift) & 0xffffffffn);
  }
  return out;
}

export function encodeRawCells(frame: Uint32Array): bigint[] {
  const words: bigint[] = new Array(128).fill(0n);
  for (let cell = 0; cell < CELLS; cell++) {
    const shift = BigInt((cell & 7) << 5);
    words[cell >> 3] = words[cell >> 3]! | (BigInt(frame[cell]! >>> 0) << shift);
  }
  return words;
}

export type PaintedEvent = {
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  blockHash: Hex;
  player: Hex;
  coreHeight: bigint;
  playerId: number;
  cells: number[];
  colors: number[];
  budgetLeft: number;
};

/** Genesis frame: pit black everywhere, GENESIS_CELLS painted with painterId 0, genesis bit 1, crew 0. */
export function genesisFrame(cells: readonly number[], colors: readonly number[]): Uint32Array {
  const f = new Uint32Array(CELLS);
  for (let i = 0; i < cells.length; i++) {
    const c = cells[i]!;
    const col = colors[i] ?? 0;
    if (c < CELLS) f[c] = encodeCell({ color: col, crew: 0, genesis: true, painterId: 0 });
  }
  return f;
}

export function sortPainted<T extends { blockNumber: bigint; logIndex: number }>(events: readonly T[]): T[] {
  return [...events].sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
    return a.logIndex - b.logIndex;
  });
}

/**
 * frame(h) = GENESIS_CELLS + every Painted event with coreHeight <= h, applied in (blockNumber, logIndex) order.
 * `crewByPlayerId` comes from Joined events (the cell record stores the painter's crew).
 * h = null means "no height filter" (current frame).
 */
export function frame(
  h: bigint | null,
  painted: readonly PaintedEvent[],
  crewByPlayerId: ReadonlyMap<number, number>,
  genesis: Uint32Array,
): Uint32Array {
  const f = new Uint32Array(genesis);
  const ordered = sortPainted(h === null ? painted : painted.filter((e) => e.coreHeight <= h));
  for (const e of ordered) {
    const crew = crewByPlayerId.get(e.playerId) ?? 0;
    const n = Math.min(e.cells.length, e.colors.length);
    for (let i = 0; i < n; i++) {
      const cell = e.cells[i]!;
      if (cell >= CELLS) continue;
      f[cell] = encodeCell({ color: e.colors[i]! & 0xf, crew, genesis: false, painterId: e.playerId });
    }
  }
  return f;
}

export function framesEqual(a: Uint32Array, b: Uint32Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function cellXY(index: number): { x: number; y: number } {
  return { x: index & 31, y: index >> 5 };
}

export function cellIndex(x: number, y: number): number {
  return (y << 5) | x;
}
