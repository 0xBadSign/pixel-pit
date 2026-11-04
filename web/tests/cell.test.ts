import { describe, it, expect } from 'vitest';
import { decodeCell, encodeCell, decodeRawCells, encodeRawCells, genesisFrame, cellXY, cellIndex } from '../src/frame';

describe('cell record codec (SPEC §5.2)', () => {
  it('roundtrips every field through encode/decode', () => {
    const samples = [
      { color: 0, crew: 0, genesis: false, painterId: 0 },
      { color: 15, crew: 3, genesis: true, painterId: 0 },
      { color: 13, crew: 1, genesis: false, painterId: 1 },
      { color: 7, crew: 2, genesis: false, painterId: 0xffffff },
      { color: 9, crew: 3, genesis: false, painterId: 123456 },
    ];
    for (const s of samples) {
      const rec = encodeCell(s);
      expect(decodeCell(rec)).toEqual(s);
    }
  });

  it('matches the spec bit layout exactly', () => {
    // rec = (painterId << 8) | (genesis ? 0x40 : 0) | (crew << 4) | color
    expect(encodeCell({ color: 0xa, crew: 2, genesis: true, painterId: 0x0102 })).toBe((0x0102 << 8) | 0x40 | (2 << 4) | 0xa);
    const d = decodeCell(0xabcdef00 | 0x40 | 0x30 | 0x5);
    expect(d.color).toBe(5);
    expect(d.crew).toBe(3);
    expect(d.genesis).toBe(true);
    expect(d.painterId).toBe(0xabcdef);
  });

  it('spare bit 7 is ignored on decode and never set on encode', () => {
    expect(encodeCell({ color: 1, crew: 1, genesis: false, painterId: 1 }) & 0x80).toBe(0);
    expect(decodeCell(0x80 | 0x1).color).toBe(1);
  });

  it('rejects out-of-range values', () => {
    expect(() => encodeCell({ color: 16, crew: 0, genesis: false, painterId: 0 })).toThrow();
    expect(() => encodeCell({ color: 0, crew: 4, genesis: false, painterId: 0 })).toThrow();
    expect(() => encodeCell({ color: 0, crew: 0, genesis: false, painterId: 0x1000000 })).toThrow();
  });

  it('rawCells word packing roundtrips (8 cells per word, 32 bits per cell)', () => {
    const f = new Uint32Array(1024);
    for (let i = 0; i < 1024; i++) f[i] = encodeCell({ color: i & 15, crew: i & 3, genesis: i % 7 === 0, painterId: (i * 977) & 0xffffff });
    const words = encodeRawCells(f);
    expect(words).toHaveLength(128);
    const back = decodeRawCells(words);
    expect(Array.from(back)).toEqual(Array.from(f));
    // cell 9 lives in word 1, shift 32
    expect((words[1]! >> 32n) & 0xffffffffn).toBe(BigInt(f[9]!));
  });

  it('untouched storage (all-zero words) is a valid pit-black canvas', () => {
    const f = decodeRawCells(new Array(128).fill(0n));
    expect(f.every((r) => r === 0)).toBe(true);
    expect(decodeCell(0)).toEqual({ color: 0, crew: 0, genesis: false, painterId: 0 });
  });

  it('genesis frame marks cells with genesis bit, painterId 0, crew 0', () => {
    const g = genesisFrame([5, 1023], [13, 4]);
    expect(decodeCell(g[5]!)).toEqual({ color: 13, crew: 0, genesis: true, painterId: 0 });
    expect(decodeCell(g[1023]!)).toEqual({ color: 4, crew: 0, genesis: true, painterId: 0 });
    expect(g[6]).toBe(0);
  });

  it('cell index <-> xy', () => {
    expect(cellIndex(12, 7)).toBe(7 * 32 + 12);
    expect(cellXY(7 * 32 + 12)).toEqual({ x: 12, y: 7 });
  });
});
