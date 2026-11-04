// @vitest-environment jsdom
// Board ranking rules (SPEC §4, §6.4 "#/board", §6.5, §7.4, §7.15). Pure helpers + a DOM mount pass.
import { describe, it, expect } from 'vitest';
import type { Address, Hex } from 'viem';
import { CONFIG } from '../config';
import * as copy from '../copy';
import { genesisFrame } from '../frame';
import { Store, initialState } from '../state';
import type { TickOk } from '../rpc';
import type { JoinedEvent, PaintedLog, LogsSnapshot } from '../logs';
import { walletRows, sortWalletRows, crewRows, completeness, nightId, estimateBlockTime, nightsSeen, mount } from './board';

const A: Address = '0x00000000000000000000000000000000000000a1';
const B: Address = '0x00000000000000000000000000000000000000b2';
const C: Address = '0x00000000000000000000000000000000000000c3';
const ZERO_HASH = `0x${'00'.repeat(32)}` as Hex;

let logIndex = 0;
function joined(player: Address, playerId: number, crew: number, blockNumber: bigint, coreHeight = 8430n): JoinedEvent {
  return { kind: 'Joined', blockNumber, logIndex: logIndex++, txHash: ZERO_HASH, blockHash: ZERO_HASH, player, playerId, crew, coreHeight };
}
function painted(player: Address, playerId: number, cells: number[], blockNumber: bigint, color = 4): PaintedLog {
  return {
    kind: 'Painted',
    blockNumber,
    logIndex: logIndex++,
    txHash: ZERO_HASH,
    blockHash: ZERO_HASH,
    player,
    coreHeight: 8473n,
    playerId,
    cells,
    colors: cells.map(() => color),
    budgetLeft: 0,
  };
}
function crews(j: JoinedEvent[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const x of j) m.set(x.playerId, x.crew);
  return m;
}
const genesis = genesisFrame([], []);
const sameNight = () => 0;

function snapshot(j: JoinedEvent[], p: PaintedLog[], completeThrough: bigint | null, failedChunks = 0): LogsSnapshot {
  return { joined: j, painted: p, settled: [], crewByPlayerId: crews(j), completeThrough, canonicalThrough: completeThrough, incomplete: failedChunks > 0, failedChunks, provider: 'fake', at: 0 };
}

const tick: TickOk = {
  ok: true,
  at: Date.UTC(2026, 10, 4, 21, 42, 0),
  provider: 'https://sepolia.gateway.tenderly.co',
  providerIndex: 0,
  head: 12_061_055n,
  headHash: ZERO_HASH,
  headTimestamp: 1_762_292_520n,
  safe: 12_061_040n,
  finalized: 12_060_990n,
  finalityTags: true,
  state: { settledThroughRound: 1246n, cumulativeWork: 0n, cumulativeBlockUnits: 8473_000_000_000n, blockHeight: 8473n, blockProgress: 0n, workPerThousandBlocks: 0, authorizationNonce: 0n, paused: false },
  pit: { rawCells: new Array<bigint>(128).fill(0n), totalStrokes: 0n, playerCount: 0, crewScores: [5, 1, 0, 9], budget: null },
  wallet: null,
};

describe('wallet ranking (SPEC §4: surviving pixels > unique cells > total strokes)', () => {
  it('repainting your own cell 40 times moves nothing', () => {
    const j = [joined(A, 1, 0, 100n), joined(B, 2, 1, 100n), joined(C, 3, 2, 100n)];
    const base = [painted(A, 1, [5], 110n), painted(B, 2, [7], 111n), painted(C, 3, [20, 21], 112n)];
    const before = sortWalletRows(walletRows({ joined: j, painted: base, crewByPlayerId: crews(j), upTo: 1000n, genesis, nightOf: sameNight }));
    const repaints = Array.from({ length: 40 }, (_, k) => painted(B, 2, [7], 200n + BigInt(k), (k % 15) + 1));
    const after = sortWalletRows(walletRows({ joined: j, painted: [...base, ...repaints], crewByPlayerId: crews(j), upTo: 1000n, genesis, nightOf: sameNight }));

    const b0 = before.find((r) => r.playerId === 2)!;
    const b1 = after.find((r) => r.playerId === 2)!;
    expect(b1.strokes).toBe(41); // strokes do count...
    expect(b1.surviving).toBe(b0.surviving); // ...but neither surviving pixels
    expect(b1.unique).toBe(b0.unique); // ...nor unique cells moved
    expect(b1.surviving).toBe(1);
    expect(b1.unique).toBe(1);
    // C (2 unique cells, 2 strokes) stays above B (1 cell, 41 strokes) before and after
    expect(before.map((r) => r.playerId)[0]).toBe(3);
    expect(after.map((r) => r.playerId)[0]).toBe(3);
    expect(after.findIndex((r) => r.playerId === 3)).toBeLessThan(after.findIndex((r) => r.playerId === 2));
  });

  it('overpainting transfers the surviving pixel; unique cells stay with both painters', () => {
    const j = [joined(A, 1, 0, 100n), joined(B, 2, 1, 100n)];
    const p = [painted(A, 1, [5, 6], 110n), painted(B, 2, [5], 120n)];
    const rows = sortWalletRows(walletRows({ joined: j, painted: p, crewByPlayerId: crews(j), upTo: 1000n, genesis, nightOf: sameNight }));
    const a = rows.find((r) => r.playerId === 1)!;
    const b = rows.find((r) => r.playerId === 2)!;
    expect(a.surviving).toBe(1);
    expect(a.unique).toBe(2);
    expect(b.surviving).toBe(1);
    expect(b.unique).toBe(1);
    expect(rows[0]!.playerId).toBe(1); // tie on surviving, A wins on unique cells
  });

  it('events above the safe block are excluded (SETTLED view only)', () => {
    const j = [joined(A, 1, 0, 100n), joined(B, 2, 1, 2000n)];
    const p = [painted(A, 1, [5], 110n), painted(A, 1, [6], 1500n)];
    const rows = walletRows({ joined: j, painted: p, crewByPlayerId: crews(j), upTo: 1000n, genesis, nightOf: sameNight });
    expect(rows.map((r) => r.playerId)).toEqual([1]);
    expect(rows[0]!.unique).toBe(1);
    expect(rows[0]!.strokes).toBe(1);
  });

  it('ties fall through surviving -> unique -> strokes -> join order', () => {
    const j = [joined(A, 1, 0, 100n), joined(B, 2, 1, 100n), joined(C, 3, 2, 100n)];
    const p = [painted(A, 1, [1], 110n), painted(B, 2, [2], 111n), painted(B, 2, [2], 112n), painted(C, 3, [3], 113n)];
    const rows = sortWalletRows(walletRows({ joined: j, painted: p, crewByPlayerId: crews(j), upTo: 1000n, genesis, nightOf: sameNight }));
    expect(rows.map((r) => r.playerId)).toEqual([2, 1, 3]); // B by strokes, then A before C by join order
  });

  it('genesis cells never count as surviving pixels for anyone', () => {
    const j = [joined(A, 1, 0, 100n)];
    const g = genesisFrame([0, 1, 2], [13, 13, 13]);
    const rows = walletRows({ joined: j, painted: [], crewByPlayerId: crews(j), upTo: 1000n, genesis: g, nightOf: sameNight });
    expect(rows[0]!.surviving).toBe(0);
  });
});

describe('crew rows (SPEC §4: cells held from crewScores(), total strokes from logs)', () => {
  it('held comes from crewScores()@B, strokes are grouped by the painter crew, sorted by held', () => {
    const j = [joined(A, 1, 0, 100n), joined(B, 2, 3, 100n)];
    const p = [painted(A, 1, [1, 2, 3], 110n), painted(B, 2, [4], 111n), painted(B, 2, [4], 112n)];
    const rows = crewRows([5, 1, 0, 9], p, crews(j), 1000n);
    expect(rows.map((r) => r.crew)).toEqual([3, 0, 1, 2]);
    expect(rows[0]).toMatchObject({ name: 'Moon', held: 9, strokes: 2 });
    expect(rows[1]).toMatchObject({ name: 'Wheel', held: 5, strokes: 3 });
  });

  it('without a readable crewScores() held is null (UNKNOWN), never 0', () => {
    const rows = crewRows(null, [], new Map(), 1000n);
    expect(rows.every((r) => r.held === null)).toBe(true);
  });
});

describe('completeness line (SPEC §7.15) and nights', () => {
  it('complete when contiguous coverage reaches the safe block, else INCOMPLETE with a lower-bound chunk count', () => {
    const s1 = snapshot([], [], 12_061_050n);
    expect(completeness(s1, 12_061_040n, 100n)).toEqual({ kind: 'complete', from: 100n, through: 12_061_040n });
    const s2 = snapshot([], [], 12_061_000n, 2);
    expect(completeness(s2, 12_061_040n, 100n)).toEqual({ kind: 'incomplete', failed: 2, through: 12_061_000n });
    const s3 = snapshot([], [], null, 0);
    expect(completeness(s3, 12_061_040n, 100n).kind).toBe('incomplete');
    expect((completeness(s3, 12_061_040n, 100n) as { failed: number }).failed).toBeGreaterThanOrEqual(1);
  });

  it('nights roll over at 12:00 UTC', () => {
    const d = (h: number, m: number, day = 4) => BigInt(Math.floor(Date.UTC(2026, 10, day, h, m, 0) / 1000));
    expect(nightId(d(11, 59))).not.toBe(nightId(d(12, 1)));
    expect(nightId(d(12, 1))).toBe(nightId(d(11, 59, 5)));
    expect(nightId(d(21, 0))).toBe(nightId(d(7, 0, 5)));
    expect(estimateBlockTime(1000n, 1010n, 10_000n)).toBe(9_880n);
    const nightOf = (bn: bigint) => nightId(estimateBlockTime(bn, 20_000n, d(12, 30)));
    const p = [painted(A, 1, [1], 20_000n), painted(A, 1, [2], 19_000n), painted(A, 1, [3], 12_000n)]; // 12_000 is ~26 h earlier
    // 20_000 -> 12:30 UTC day 4 (night N), 19_000 -> 09:10 UTC day 4 (night N-1), 12_000 -> ~09:50 UTC day 3 (night N-2)
    expect(nightsSeen(p, 20_000n, nightOf)).toBe(3);
    expect(nightsSeen(p, 19_500n, nightOf)).toBe(2);
    expect(nightsSeen(p, 15_000n, nightOf)).toBe(1);
    expect(nightOf(20_000n)).toBe(nightOf(19_000n) + 1);
  });
});

describe('Board screen DOM (SPEC §6.4, §6.5)', () => {
  const j = [joined(A, 1, 0, 12_060_000n), joined(B, 2, 3, 12_060_001n)];
  const p = [painted(A, 1, [5, 6], 12_060_100n), painted(B, 2, [5], 12_060_200n)];
  const digitsOutsideClock = (text: string) => text.replace(/\d{2}:\d{2} UTC/g, '').replace(/\D/g, '');

  function mountWith(state: Partial<typeof initialState>, tab: 'crews' | 'wallets') {
    const store = new Store({ ...initialState, ...state });
    const root = document.createElement('main');
    mount(root, store, { path: '/board', query: new URLSearchParams(`tab=${tab}`) });
    return { root, store, body: root.querySelector('.board-body')! };
  }

  it('Crews tab: completeness line, labelled cells held / strokes, bots note, never "final"', () => {
    const { root, body } = mountWith({ tick, lastGood: tick, logs: snapshot(j, p, 12_061_055n) }, 'crews');
    const text = root.textContent ?? '';
    expect(text).toContain(copy.COMPLETE_LINE(CONFIG.PIT_DEPLOY_BLOCK.toLocaleString('en-US'), '12,061,040'));
    expect(text).toContain(copy.BOARD_BOTS_NOTE);
    expect(text).not.toMatch(/\bfinal\b/i);
    expect(root.querySelector('[aria-selected="true"]')?.textContent).toBe('Crews');
    const moon = body.querySelector('tr[data-crew="3"]')!;
    const cells = [...moon.querySelectorAll('td')];
    expect(cells[1]!.textContent).toBe('9'); // crewScores()[3]
    expect(cells[1]!.dataset.label).toBe('FRESH'); // head read, head > safe
    expect(cells[2]!.textContent).toBe('1'); // B's single stroke
    expect(cells[2]!.dataset.label).toBe('SETTLED');
    expect(body.querySelectorAll('.tag-settled').length).toBeGreaterThan(0);
    expect(body.querySelectorAll('.tag-fresh').length).toBeGreaterThan(0);
    expect(body.querySelector('button[disabled]')).toBeNull(); // Nights stub lives in the tab bar, not the body
    expect(root.querySelector('.board-tabs button[disabled]')?.textContent).toBe('Nights');
  });

  it('Wallets tab: rows ordered by surviving pixels, every number labelled SETTLED, filter off before 2 nights', () => {
    const { body } = mountWith({ tick, lastGood: tick, logs: snapshot(j, p, 12_061_055n) }, 'wallets');
    const rows = [...body.querySelectorAll('tbody tr')];
    expect(rows.map((r) => r.getAttribute('data-player'))).toEqual(['1', '2']); // tie on surviving (1 each), A wins on unique
    const nums = [...body.querySelectorAll('td.num')];
    expect(nums.length).toBeGreaterThan(0);
    expect(nums.every((td) => (td as HTMLElement).dataset.label === 'SETTLED')).toBe(true);
    const cb = body.querySelector<HTMLInputElement>('#board-filter-nights')!;
    expect(cb.checked).toBe(false);
    expect(cb.disabled).toBe(true);
    expect(body.textContent).toContain('active on ≥ 2 nights');
  });

  it('INCOMPLETE logs: grey-italic class, §7.15 incomplete line, no SETTLED tag on log numbers', () => {
    const { body } = mountWith({ tick, lastGood: tick, logs: snapshot(j, p, 12_060_500n, 3) }, 'wallets');
    expect(body.textContent).toContain(copy.INCOMPLETE_LINE('3'));
    expect(body.querySelector('table')!.classList.contains('board-incomplete')).toBe(true);
    expect(body.querySelectorAll('.tag-settled').length).toBe(0);
    expect(body.querySelectorAll('.tag-incomplete').length).toBeGreaterThan(0);
    // the only "final" on the page is the §7.15 line saying the numbers are NOT a final count
    expect((body.textContent ?? '').replace(copy.INCOMPLETE_LINE('3'), '')).not.toMatch(/\bfinal\b/i);
  });

  it('no tick / no logs: UNKNOWN with a clock and no other digits in the tables', () => {
    const { body } = mountWith({}, 'crews');
    const tableText = [...body.querySelectorAll('.board-line, table')].map((e) => e.textContent ?? '').join(' ');
    expect(tableText).toContain('UNKNOWN');
    expect(tableText).toMatch(/unknown as of \d{2}:\d{2} UTC/);
    expect(digitsOutsideClock(tableText)).toBe('');
    const { body: wb } = mountWith({}, 'wallets');
    expect(wb.querySelector('table')).toBeNull();
    expect(wb.textContent).toContain('UNKNOWN');
  });

  it('a failed tick keeps SETTLED log numbers but turns crewScores() UNKNOWN', () => {
    const fail = { ok: false as const, at: tick.at, reason: 'stale' as const, provider: null, head: null, headTimestamp: null, error: 'x' };
    const { body } = mountWith({ tick: fail, lastGood: tick, logs: snapshot(j, p, 12_061_055n) }, 'crews');
    const moon = body.querySelector('tr[data-crew="3"]')!;
    const cells = [...moon.querySelectorAll('td')];
    expect(cells[1]!.textContent).toBe('—');
    expect(cells[1]!.dataset.label).toBe('UNKNOWN');
    expect(cells[2]!.textContent).toBe('1');
    expect(cells[2]!.dataset.label).toBe('SETTLED');
  });

  it('re-renders on store changes and switches tabs by click', () => {
    const { root, store, body } = mountWith({ tick, lastGood: tick, logs: snapshot(j, p, 12_061_055n) }, 'crews');
    const walletsTab = [...root.querySelectorAll<HTMLButtonElement>('.board-tab')].find((b) => b.textContent === 'Wallets')!;
    walletsTab.click();
    expect(body.querySelectorAll('tbody tr[data-player]').length).toBe(2);
    store.set({ logs: snapshot(j, [...p, painted(C, 3, [9], 12_060_300n)], 12_061_055n) }); // C painted but never joined: no row
    expect(body.querySelectorAll('tbody tr[data-player]').length).toBe(2);
    store.set({ logs: snapshot([...j, joined(C, 3, 2, 12_060_002n)], [...p, painted(C, 3, [9], 12_060_300n)], 12_061_055n) });
    expect(body.querySelectorAll('tbody tr[data-player]').length).toBe(3);
  });
});
