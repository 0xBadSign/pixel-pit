import { describe, it, expect } from 'vitest';
import { frame, genesisFrame, decodeCell, sortPainted, type PaintedEvent } from '../src/frame';

const H = '0x' + '11'.repeat(32);
const T = '0x' + '22'.repeat(32);

function painted(p: Partial<PaintedEvent> & { blockNumber: bigint; logIndex: number; cells: number[]; colors: number[] }): PaintedEvent {
  return {
    txHash: T as `0x${string}`,
    blockHash: H as `0x${string}`,
    player: '0x0000000000000000000000000000000000000001',
    coreHeight: 1n,
    playerId: 1,
    budgetLeft: 0,
    ...p,
  };
}

describe('frame(h) (SPEC §6.3)', () => {
  const genesis = genesisFrame([0, 1], [13, 13]);
  const crews = new Map<number, number>([
    [1, 3],
    [2, 0],
  ]);

  it('applies Painted events in (blockNumber, logIndex) order regardless of input order', () => {
    const events = [
      painted({ blockNumber: 20n, logIndex: 0, cells: [5], colors: [4], playerId: 2 }),
      painted({ blockNumber: 10n, logIndex: 7, cells: [5], colors: [6], playerId: 1 }),
      painted({ blockNumber: 10n, logIndex: 2, cells: [5], colors: [9], playerId: 1 }),
    ];
    const f = frame(null, events, crews, genesis);
    const c = decodeCell(f[5]!);
    expect(c.color).toBe(4); // last writer: block 20
    expect(c.painterId).toBe(2);
    expect(c.crew).toBe(0);
    // same block, higher logIndex wins
    const f2 = frame(null, events.filter((e) => e.blockNumber === 10n), crews, genesis);
    expect(decodeCell(f2[5]!)).toEqual({ color: 6, crew: 3, genesis: false, painterId: 1 });
  });

  it('includes only events with coreHeight <= h', () => {
    const events = [
      painted({ blockNumber: 1n, logIndex: 0, cells: [3], colors: [1], coreHeight: 100n }),
      painted({ blockNumber: 2n, logIndex: 0, cells: [3], colors: [2], coreHeight: 143n }),
    ];
    expect(decodeCell(frame(100n, events, crews, genesis)[3]!).color).toBe(1);
    expect(decodeCell(frame(142n, events, crews, genesis)[3]!).color).toBe(1);
    expect(decodeCell(frame(143n, events, crews, genesis)[3]!).color).toBe(2);
    expect(frame(99n, events, crews, genesis)[3]).toBe(0);
  });

  it('frame 0 keeps genesis strokes, which can be overpainted', () => {
    const f0 = frame(0n, [], crews, genesis);
    expect(decodeCell(f0[0]!).genesis).toBe(true);
    const f1 = frame(null, [painted({ blockNumber: 1n, logIndex: 0, cells: [0], colors: [4] })], crews, genesis);
    expect(decodeCell(f1[0]!)).toEqual({ color: 4, crew: 3, genesis: false, painterId: 1 });
  });

  it('does not mutate the genesis frame', () => {
    const before = Array.from(genesis);
    frame(null, [painted({ blockNumber: 1n, logIndex: 0, cells: [0, 1], colors: [4, 4] })], crews, genesis);
    expect(Array.from(genesis)).toEqual(before);
  });

  it('sortPainted is stable and by (blockNumber, logIndex)', () => {
    const s = sortPainted([
      { blockNumber: 2n, logIndex: 0 },
      { blockNumber: 1n, logIndex: 9 },
      { blockNumber: 1n, logIndex: 3 },
    ]);
    expect(s.map((e) => `${e.blockNumber}:${e.logIndex}`)).toEqual(['1:3', '1:9', '2:0']);
  });
});
