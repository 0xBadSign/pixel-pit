// @vitest-environment jsdom
// Play screen + Join sheet (SPEC §2.2-§2.5, §6.4, §6.5, §7.3, §7.6, §7.12, §7.14).
import { describe, it, expect, beforeAll, vi } from 'vitest';
import type { Hex } from 'viem';
import { Store, initialState, type AppState, type Budget } from '../state';
import type { TickOk } from '../rpc';
import type { LogsSnapshot, PaintedLog, JoinedEvent, BatchSettledEvent } from '../logs';
import type { DiscoveredProvider } from '../wallet';
import * as copy from '../copy';
import { CONFIG } from '../config';
import { mount, encodePaintArgs, enqueue, paintDisabledReason, feedItems, flashText, settlementFor, type PlayDeps } from './play';
import { joinDisabledReason, createJoinBody, budgetOf, openJoinSheet, type PitActions } from './join';
import { statusOf, summarizeStatus } from '../api';

// ---------- jsdom shims: 2d context, pointer capture ----------
beforeAll(() => {
  const noop = () => {};
  const ctx = new Proxy({} as CanvasRenderingContext2D, {
    get: (_t, k) => (k === 'canvas' ? undefined : typeof k === 'string' && /^(fill|stroke|set|save|restore|translate|clear|begin|close|move|line|rect|arc)/.test(k) ? noop : noop),
    set: () => true,
  });
  HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as HTMLCanvasElement['getContext'];
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  if (typeof proto.setPointerCapture !== 'function') proto.setPointerCapture = noop;
  if (typeof proto.releasePointerCapture !== 'function') proto.releasePointerCapture = noop;
});

// ---------- fixtures (SPEC §3.5 worked example heights) ----------
const T = Date.UTC(2026, 10, 4, 21, 42, 0); // device time for every test
const ADDR = '0x1111111111111111111111111111111111111111' as const;
const OTHER = '0x2222222222222222222222222222222222222222' as const;
const h = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;

const tick: TickOk = {
  ok: true,
  at: T,
  provider: CONFIG.RPC[0]!,
  providerIndex: 0,
  head: 12_061_055n,
  headHash: h(1),
  headTimestamp: BigInt(Math.floor(T / 1000) - 5),
  safe: 12_061_040n,
  finalized: 12_060_990n,
  finalityTags: true,
  state: { settledThroughRound: 1246n, cumulativeWork: 0n, cumulativeBlockUnits: 8473_000_000_000n, blockHeight: 8473n, blockProgress: 0n, workPerThousandBlocks: 0, authorizationNonce: 0n, paused: false },
  pit: { rawCells: new Array<bigint>(128).fill(0n), totalStrokes: 0n, playerCount: 2, crewScores: [3, 0, 12, 7], budget: null },
  wallet: ADDR,
};
const budgetOk: Budget = { joined: true, coreOk: true, coreHeight: 8473n, ready: 27, banked: 10, fresh: 17, arrived: 57n, forfeited: 30n };
const budgetUnknown: Budget = { joined: true, coreOk: false, coreHeight: 0n, ready: 0, banked: 0, fresh: 0, arrived: 0n, forfeited: 0n };
const budgetNotJoined: Budget = { ...budgetOk, joined: false, ready: 0, banked: 0, fresh: 0, arrived: 0n, forfeited: 0n };

function tickWith(budget: Budget | null, patch: Partial<TickOk> = {}): TickOk {
  return { ...tick, ...patch, pit: { ...tick.pit!, budget } };
}

function settled(blockNumber: bigint, height: bigint, round: bigint, logIndex = 0): BatchSettledEvent {
  return { kind: 'BatchSettled', blockNumber, logIndex, txHash: h(Number(blockNumber)), blockHash: h(9), digest: h(2), reporter: OTHER, settledThroughRound: round, nonce: 0n, previousSettledThroughRound: round - 1n, activeRoundCount: 1, cumulativeWork: 0n, cumulativeBlockUnits: height * 1_000_000_000n, height };
}
function painted(blockNumber: bigint, player: Hex, playerId: number, cells: number[], coreHeight = 8473n, logIndex = 0): PaintedLog {
  return { kind: 'Painted', blockNumber, logIndex, txHash: h(Number(blockNumber) + logIndex), blockHash: h(9), player, coreHeight, playerId, cells, colors: cells.map(() => 4), budgetLeft: 10 };
}
function joined(blockNumber: bigint, player: Hex, playerId: number, crew: number, coreHeight = 8430n): JoinedEvent {
  return { kind: 'Joined', blockNumber, logIndex: 0, txHash: h(Number(blockNumber)), blockHash: h(9), player: player as `0x${string}`, playerId, crew, coreHeight };
}
function logsWith(p: Partial<LogsSnapshot> = {}): LogsSnapshot {
  const base: LogsSnapshot = {
    joined: [joined(12_060_000n, ADDR, 1, 3), joined(12_060_001n, OTHER, 2, 2)],
    painted: [painted(12_061_050n, OTHER, 2, [5, 6, 7])],
    settled: [settled(12_060_500n, 8430n, 1245n), settled(12_061_000n, 8473n, 1246n)],
    crewByPlayerId: new Map([
      [1, 3],
      [2, 2],
    ]),
    completeThrough: 12_061_055n,
    canonicalThrough: 12_060_990n,
    incomplete: false,
    failedChunks: 0,
    provider: CONFIG.RPC[0]!,
    at: T,
  };
  return { ...base, ...p };
}

const providerA: DiscoveredProvider = { info: { uuid: 'a', name: 'Wallet A', icon: '', rdns: 'a.wallet' }, provider: { request: async () => null } as unknown as DiscoveredProvider['provider'] };
const providerB: DiscoveredProvider = { info: { uuid: 'b', name: 'Wallet B', icon: '', rdns: 'b.wallet' }, provider: { request: async () => null } as unknown as DiscoveredProvider['provider'] };

function connected(extra: Partial<Extract<AppState['wallet'], { status: 'connected' }>> = {}): AppState['wallet'] {
  return { status: 'connected', providers: [providerA, providerB], selected: providerA, address: ADDR, chainId: CONFIG.chainId, wrongNetwork: false, balanceWei: 10n ** 17n, lowBalance: false, ...extra };
}

const depOk: AppState['deployment'] = { status: 'ok', pitCore: CONFIG.CORE, impl: CONFIG.EXPECTED_IMPL, runtimeHash: CONFIG.EXPECTED_RUNTIME_HASH, streamId: CONFIG.EXPECTED_STREAM_ID, genesisTimestamp: CONFIG.EXPECTED_GENESIS_TS, targetBlocks: 40n, mismatches: [], apiCore: null, apiMismatch: false, checkedAt: T };

function stateWith(p: Partial<AppState>): AppState {
  const t = p.lastGood ?? tickWith(budgetOk);
  return { ...initialState, tick: t, lastGood: t, logs: logsWith(), wallet: connected(), deployment: depOk, lastKnownHeight: 8473n, heightSettledAtBlock: 12_061_000n, ...p };
}

function fakeActions(): PitActions & { connectWallet: ReturnType<typeof vi.fn> } {
  return { connectWallet: vi.fn(async () => {}), disconnectWallet: () => {}, switchChain: async () => {}, kick: () => {}, clients: [] };
}

function mountPlay(state: AppState, deps: PlayDeps = {}) {
  document.body.innerHTML = '';
  const root = document.createElement('main');
  document.body.append(root);
  const store = new Store(state);
  const actions = fakeActions();
  const cleanup = mount(root, store, { path: '/', query: new URLSearchParams() }, {
    actions,
    now: () => T,
    blockTimestamp: async (_c, block) => (block === 12_061_000n ? BigInt(Math.floor(T / 1000) - (3 * 3600 + 12 * 60)) : null),
    configuration: async () => null,
    ...deps,
  });
  return { root, store, actions, cleanup, text: () => root.textContent ?? '', q: <E extends Element>(sel: string) => root.querySelector<E>(sel), qa: (sel: string) => [...root.querySelectorAll(sel)] };
}

const flushAsync = () => new Promise((r) => setTimeout(r, 0));

function pointer(type: string, x: number, y: number): Event {
  const Ctor = (window as unknown as { PointerEvent?: typeof MouseEvent }).PointerEvent ?? MouseEvent;
  return new Ctor(type, { clientX: x, clientY: y, button: 0, bubbles: true });
}

// ---------- pure helpers ----------
describe('paint() encoding (SPEC §5.5)', () => {
  it('sorts cells ascending and keeps one entry per cell (last colour wins)', () => {
    const a = encodePaintArgs({ cells: [40, 3, 1023, 3, 0], colors: [1, 2, 3, 9, 15] });
    expect(a.cells).toEqual([0, 3, 40, 1023]);
    expect(a.colors).toEqual([15, 9, 1, 3]);
    expect(a.cells.length).toBe(a.colors.length);
  });
  it('enqueue respects the limit, recolours in place and reports no-ops', () => {
    let q = { cells: [], colors: [] } as { cells: number[]; colors: number[] };
    q = enqueue(q, 7, 4, 2)!;
    q = enqueue(q, 8, 4, 2)!;
    expect(enqueue(q, 9, 4, 2)).toBeNull(); // limit
    expect(enqueue(q, 7, 4, 2)).toBeNull(); // same colour
    q = enqueue(q, 7, 5, 2)!;
    expect(q.cells).toEqual([8, 7]);
    expect(q.colors).toEqual([4, 5]);
  });
});

describe('PAINT disabled reasons are always written (SPEC §6.4)', () => {
  it('walks the reason ladder', () => {
    const base = stateWith({ queue: { cells: [1, 2], colors: [4, 4] } });
    expect(paintDisabledReason(base, 2)).toBeNull();
    expect(paintDisabledReason({ ...base, practice: true }, 2)).toBe(copy.PRACTICE_TITLE);
    expect(paintDisabledReason({ ...base, wallet: { status: 'disconnected', providers: [] } }, 2)).toBe(copy.REASON_NO_WALLET);
    expect(paintDisabledReason({ ...base, wallet: connected({ wrongNetwork: true }) }, 2)).toBe(copy.REASON_WRONG_NETWORK);
    const changed = { ...depOk, status: 'changed' as const, mismatches: ['implementation 0x…'] };
    expect(paintDisabledReason({ ...base, deployment: changed }, 2)).toBe(copy.REASON_DEPLOYMENT_CHANGED);
    expect(paintDisabledReason({ ...base, deployment: changed, deploymentAcknowledged: true }, 2)).toBeNull(); // "I understand" unlocks Paint only
    const fail = { ok: false as const, at: T, reason: 'unreachable' as const, provider: null, head: null, headTimestamp: null, error: 'x' };
    expect(paintDisabledReason({ ...base, tick: fail }, 2)).toBe(copy.REASON_CORE_UNREACHABLE);
    expect(paintDisabledReason(stateWith({ lastGood: tickWith(budgetUnknown), queue: base.queue }), 2)).toBe(copy.REASON_CORE_UNREACHABLE);
    expect(paintDisabledReason(stateWith({ lastGood: tickWith(budgetNotJoined) }), 2)).toBe(copy.REASON_NOT_JOINED);
    expect(paintDisabledReason({ ...base, pendingTx: { hash: h(0xabc), cells: [1], colors: [1], sentAt: T } }, 2)).toBe(copy.REASON_WAITING_TX('0x0000…0abc'));
    expect(paintDisabledReason(stateWith({ lastGood: tickWith({ ...budgetOk, ready: 0, banked: 0, fresh: 0 }) }), 2)).toBe(copy.REASON_BRUSH_EMPTY);
    expect(paintDisabledReason(base, 0)).toBe(copy.ERR_SENTENCES.EmptyStroke);
    expect(paintDisabledReason(base, 30)).toBe(copy.ERR_INSUFFICIENT_BUDGET('27', '30'));
    // §6.2: the impl/runtime-hash check must have run before the first paint
    expect(paintDisabledReason({ ...base, deployment: { status: 'checking' } }, 2)).toBe(copy.DEPCHECK_CHECKING);
    expect(paintDisabledReason({ ...base, deployment: { status: 'unreachable', error: 'x', checkedAt: T } }, 2)).toBe(copy.REASON_CORE_UNREACHABLE);
  });

  it('budget numbers belong to the connected account only: a tick read for another address is UNKNOWN', () => {
    const base = stateWith({ queue: { cells: [1], colors: [4] } });
    const other = { ...base, lastGood: tickWith(budgetOk, { wallet: OTHER }), tick: tickWith(budgetOk, { wallet: OTHER }) };
    expect(budgetOf(base)?.ready).toBe(27);
    expect(budgetOf(other)).toBeNull();
    expect(paintDisabledReason(other, 1)).toBe(copy.REASON_CORE_UNREACHABLE);
    expect(joinDisabledReason({ ...other, lastGood: tickWith(budgetNotJoined, { wallet: OTHER }) }, 1)).toBe(copy.REASON_CORE_UNREACHABLE);
    const m = mountPlay(other);
    expect(m.q<HTMLElement>('.battery')?.dataset.state).toBe('unknown');
    expect((m.q('.battery')?.textContent ?? '').replace(/\d{2}:\d{2} UTC/g, '').replace(/\D/g, '')).toBe('');
    m.cleanup();
  });
  it('JOIN stays closed on deployment changed even after "I understand"; AlreadyJoined is a sentence', () => {
    const changed = { ...depOk, status: 'changed' as const };
    expect(joinDisabledReason(stateWith({ deployment: changed, deploymentAcknowledged: true, lastGood: tickWith(budgetNotJoined) }), 1)).toBe(copy.REASON_DEPLOYMENT_CHANGED);
    expect(joinDisabledReason(stateWith({}), 1)).toBe(copy.ERR_SENTENCES.AlreadyJoined);
    expect(joinDisabledReason(stateWith({ lastGood: tickWith(budgetNotJoined) }), null)).toBe('choose a crew');
    expect(joinDisabledReason(stateWith({ lastGood: tickWith(budgetNotJoined) }), 3)).toBeNull();
    expect(joinDisabledReason(stateWith({ lastGood: tickWith(budgetUnknown) }), 3)).toBe(copy.REASON_CORE_UNREACHABLE);
  });
});

describe('feed + flash helpers', () => {
  it('keeps the last 50 records newest first', () => {
    const many = Array.from({ length: 70 }, (_, i) => painted(12_060_100n + BigInt(i), OTHER, 2, [i]));
    const items = feedItems(logsWith({ painted: many }));
    expect(items.length).toBe(50);
    expect(items[0]!.blockNumber).toBe(12_061_000n); // the BatchSettled at 12,061,000 is newer than painted 12,060,169
    expect(items[0]!.text).toContain('BatchSettled: Squeek block 8,473 (+43) · round 1,246');
  });
  it('flash text drops the brush sentence when no budget number exists', () => {
    expect(flashText(8473n, 43n, 'fresh', 40)).toBe('Block 8,473 settled: +43 · fresh. Your brush is 40/40.');
    expect(flashText(8473n, 43n, 'settled', null)).toBe('Block 8,473 settled: +43 · settled.');
    expect(settlementFor(logsWith().settled, 8473n)?.log.blockNumber).toBe(12_061_000n);
    expect(settlementFor(logsWith().settled, 9000n)).toBeNull();
  });
});

// ---------- mounted screen ----------
describe('Play screen (mounted)', () => {
  it('coreOk=false: battery shows UNKNOWN with no digits other than the clock; queue reason says Core unreachable', () => {
    const m = mountPlay(stateWith({ lastGood: tickWith(budgetUnknown) }));
    const battery = m.q<HTMLElement>('.battery')!;
    const text = battery.textContent ?? '';
    expect(text).toContain('UNKNOWN');
    expect(text.replace(/\d{2}:\d{2} UTC/g, '').replace(/\D/g, '')).toBe('');
    expect(m.q('.paint-btn')).toHaveProperty('disabled', true);
    expect(m.q('.queue .reason')?.textContent).toBe(copy.REASON_CORE_UNREACHABLE);
    expect(m.q('.queue')?.textContent).toContain(`queued 0 / ${copy.LABEL_UNKNOWN}`);
    m.cleanup();
  });

  it('coreOk=true: READY line, FRESH/SETTLED sub-line, hold line, idle status card with measured facts', async () => {
    const m = mountPlay(stateWith({ lastGood: tickWith({ ...budgetOk, fresh: 0, banked: 27 }) }));
    await flushAsync(); // block timestamp fetch
    const t = m.text();
    expect(t).toContain('READY 27 = banked 27 + fresh 0 (cap 40)');
    expect(t).toContain('as of ETH block 12,061,055 (head) · SETTLED'); // settlement block 12,061,000 <= safe
    expect(m.q('.battery-extra')?.textContent).toBe(copy.BATTERY_HOLD('27'));
    const card = m.q('.status-card')!.textContent!;
    expect(card).toContain('No new Squeek blocks settled since block 8,473 (3h 12m ago, ETH block 12,061,000)');
    expect(card).toContain('history, not a promise');
    expect(card).toContain(copy.IDLE_HOLD('27'));
    expect(card).not.toMatch(/asleep|running/); // those words live only next to the PROVISIONAL light
    expect(m.q('.season-line')?.textContent ?? '').toBe(''); // a height-increasing settlement exists: no "first night pending"
    m.cleanup();
  });

  it('stale RPC replaces the status card with the §7.6 unknown sentence', () => {
    const stale = { ok: false as const, at: T, reason: 'stale' as const, provider: null, head: 12_061_000n, headTimestamp: null, error: 'x' };
    const m = mountPlay(stateWith({ tick: stale }));
    expect(m.q('.status-card')?.textContent).toContain(copy.IDLE_STALE('21:42', '12,061,000'));
    expect(m.q<HTMLElement>('.battery')?.dataset.state).toBe('unknown');
    m.cleanup();
  });

  it('failed tick -> strip/crews show no digits (UNKNOWN + clock, §6.5), while the canvas keeps the last good frame', () => {
    const fail = { ok: false as const, at: T, reason: 'unreachable' as const, provider: null, head: null, headTimestamp: null, error: 'x' };
    const m = mountPlay(stateWith({ tick: fail }));
    const noDigits = (t: string) => t.replace(/\d{2}:\d{2} UTC/g, '').replace(/\D/g, '');
    const stripLine = m.q('.strip .strip-line')!.textContent!;
    expect(stripLine).toContain('UNKNOWN');
    expect(stripLine).toContain(copy.WORD_UNKNOWN('21:42'));
    expect(noDigits(stripLine)).toBe('');
    expect(m.q('.strip')!.textContent).not.toMatch(/Core height|settledThroughRound|last settlement/);
    const crews = m.q('.crews')!.textContent!;
    expect(crews).toContain('UNKNOWN');
    expect(noDigits(crews)).toBe('');
    expect(m.q('.crew-table')).toBeNull();
    expect(m.q('canvas')).not.toBeNull();
    m.cleanup();
  });

  it('no BatchSettled for H in the logs: the idle card is a lower bound (INCOMPLETE, ≤ deploy block, ≥ age), never SETTLED', async () => {
    // GENESIS reached before the Pit deploy: H has no settlement log; PIT_DEPLOY_BLOCK is the only (upper) bound on the block
    const deploy = CONFIG.PIT_DEPLOY_BLOCK;
    const m = mountPlay(stateWith({ logs: logsWith({ settled: [] }) }), {
      blockTimestamp: async (_c, block) => (block === deploy ? BigInt(Math.floor(T / 1000) - 2 * 3600) : null),
    });
    if (deploy > 0n) {
      await flushAsync();
      const card = m.q('.status-card')!.textContent!;
      expect(card).toContain('INCOMPLETE');
      expect(card).toContain(`(≥ 2h 0m ago, ETH block ≤ ${CONFIG.PIT_DEPLOY_BLOCK.toLocaleString('en-US')})`);
      expect(card).not.toContain('SETTLED');
    } else {
      // placeholder deploy block 0: no bound at all => UNKNOWN with a clock, no digits
      const card = m.q('.status-card')!.textContent!;
      expect(card).toContain('UNKNOWN');
      expect(card.replace(/\d{2}:\d{2} UTC/g, '').replace(/\D/g, '')).toBe('');
    }
    m.cleanup();
  });

  it('leaving Play discards Practice (store flag reset with the local copy)', () => {
    const m = mountPlay(stateWith({}));
    (m.q('.mode-btn[data-mode="practice"]') as HTMLButtonElement).click();
    expect(m.store.get().practice).toBe(true);
    m.cleanup();
    expect(m.store.get().practice).toBe(false);
  });

  it('first night pending line when no settlement raised the height above genesis', () => {
    const m = mountPlay(stateWith({ logs: logsWith({ settled: [] }) }));
    expect(m.q('.season-line')?.textContent).toContain(copy.SEASON_STARTED(CONFIG.GENESIS_HEIGHT.toLocaleString('en-US')));
    m.cleanup();
  });

  it('palette: click and keyboard 0-9/a-f select a swatch', () => {
    const m = mountPlay(stateWith({}));
    expect(m.qa('.swatch').length).toBe(16);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(m.q('.swatch[aria-selected="true"]')?.getAttribute('data-index')).toBe('10');
    (m.qa('.swatch')[2] as HTMLButtonElement).click();
    expect(m.q('.swatch[aria-selected="true"]')?.getAttribute('data-index')).toBe('2');
    m.cleanup();
  });

  it('Live click queues (PENDING, not sent) up to READY; Undo/Clear work', () => {
    const m = mountPlay(stateWith({}));
    const canvas = m.q<HTMLCanvasElement>('canvas')!;
    canvas.dispatchEvent(pointer('pointerdown', 4, 4)); // cell 0 at 8px cells
    canvas.dispatchEvent(pointer('pointerup', 4, 4));
    expect(m.store.get().queue.cells).toEqual([0]);
    expect(m.q('.queue')?.textContent).toContain('queued 1 / 27');
    expect(m.q('.queue')?.textContent).toContain(copy.WORD_PENDING_NOT_SENT);
    expect(m.q<HTMLButtonElement>('.paint-btn')?.disabled).toBe(false);
    expect(m.q<HTMLButtonElement>('.paint-btn')?.textContent).toBe('Paint 1');
    // limit = READY: fill to 27, the 28th is ignored
    for (let c = 1; c < 40; c++) m.store.set((s) => ({ queue: enqueue(s.queue, c, 4, 27) ?? s.queue }));
    expect(m.store.get().queue.cells.length).toBe(27);
    const buttons = m.qa('.queue-actions .btn') as HTMLButtonElement[];
    buttons.find((b) => b.textContent === 'Undo')!.click();
    expect(m.store.get().queue.cells.length).toBe(26);
    buttons.find((b) => b.textContent === 'Clear')!.click();
    expect(m.store.get().queue.cells.length).toBe(0);
    expect(m.q('.queue .reason')?.textContent).toBe(copy.ERR_SENTENCES.EmptyStroke);
    m.cleanup();
  });

  it('Practice: §7.14 title, local copy only, nothing in the store queue, discarded on Live', () => {
    const m = mountPlay(stateWith({}));
    expect(m.q<HTMLElement>('.practice-title')?.hidden).toBe(true);
    (m.q('.mode-btn[data-mode="practice"]') as HTMLButtonElement).click();
    expect(m.store.get().practice).toBe(true);
    expect(m.q<HTMLElement>('.practice-title')?.hidden).toBe(false);
    expect(m.q('.practice-title')?.textContent).toContain(copy.PRACTICE_TITLE);
    const canvas = m.q<HTMLCanvasElement>('canvas')!;
    canvas.dispatchEvent(pointer('pointerdown', 4, 4));
    canvas.dispatchEvent(pointer('pointerup', 4, 4));
    expect(m.store.get().queue.cells).toEqual([]);
    expect(m.q('.queue')?.textContent).toContain('PRACTICE 1 cells');
    expect(m.q<HTMLButtonElement>('.paint-btn')).toBeNull();
    expect(m.q('.queue .reason')?.textContent).toBe(copy.PRACTICE_TITLE);
    (m.q('.mode-btn[data-mode="live"]') as HTMLButtonElement).click();
    expect(m.store.get().practice).toBe(false);
    (m.q('.mode-btn[data-mode="practice"]') as HTMLButtonElement).click();
    expect(m.q('.queue')?.textContent).toContain('PRACTICE 0 cells'); // fresh copy, the earlier stroke was discarded
    m.cleanup();
  });

  it('confirm sheet: count, gas estimate, destination; confirm sends sorted cells, sets the pending lock and clears the queue', async () => {
    const send = vi.fn<(s: AppState, a: { cells: number[]; colors: number[] }) => Promise<Hex>>(async () => h(0xbeef));
    const estimateGas = vi.fn(async () => 61_234n);
    const m = mountPlay(stateWith({ queue: { cells: [40, 3, 3], colors: [1, 2, 9] } }), { send, estimateGas });
    (m.q('.paint-btn') as HTMLButtonElement).click();
    const sheet = document.querySelector('.paint-sheet')!;
    expect(sheet.textContent).toContain('Paint 2');
    expect(sheet.textContent).toContain(`2 cells`);
    expect(sheet.textContent).toContain(copy.PAINT_SHEET_DESTINATION);
    await flushAsync();
    expect(sheet.textContent).toContain('gas estimate: ~61,234');
    const confirm = [...sheet.querySelectorAll('button')].find((b) => b.textContent === 'Confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    confirm.click();
    await flushAsync();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]![1]).toEqual({ cells: [3, 40], colors: [9, 1] });
    expect(document.querySelector('.paint-sheet')).toBeNull();
    const s = m.store.get();
    expect(s.pendingTx?.hash).toBe(h(0xbeef));
    expect(s.queue.cells).toEqual([]);
    expect(m.q('.queue .reason')?.textContent).toBe(copy.REASON_WAITING_TX('0x0000…beef'));
    expect(m.q('.battery')?.textContent).toContain('PENDING 2');
    expect(m.q('.feed')?.textContent).toContain(copy.WORD_PENDING_SENT);
    m.cleanup();
  });

  it('a failed send is translated into a plain sentence', async () => {
    const send = vi.fn(async () => {
      throw { code: 4001, message: 'User rejected' };
    });
    const m = mountPlay(stateWith({ queue: { cells: [1], colors: [1] } }), { send, estimateGas: async () => 1n });
    (m.q('.paint-btn') as HTMLButtonElement).click();
    await flushAsync();
    const confirm = [...document.querySelectorAll('.paint-sheet button')].find((b) => b.textContent === 'Confirm') as HTMLButtonElement;
    confirm.click();
    await flushAsync();
    expect(document.querySelector('.paint-sheet .error')?.textContent).toBe(copy.ERR_USER_REJECTED);
    expect(m.store.get().pendingTx).toBeNull();
    m.cleanup();
  });

  it('settlement flash fires only from a confirmed BatchSettled and flips fresh -> settled once <= safe', () => {
    const m = mountPlay(stateWith({}));
    const next = tickWith({ ...budgetOk, ready: 40, banked: 10, fresh: 30 }, { head: 12_061_120n, safe: 12_061_100n, state: { ...tick.state, blockHeight: 8530n, settledThroughRound: 1247n } });
    const logs = logsWith({ settled: [...logsWith().settled, settled(12_061_110n, 8530n, 1247n)] });
    m.store.set({ tick: next, lastGood: next, logs, lastKnownHeight: 8530n, heightSettledAtBlock: 12_061_110n });
    const flash = document.querySelector('.flash');
    expect(flash?.textContent).toContain('FRESH');
    expect(flash?.textContent).toContain('Block 8,530 settled: +57 · fresh. Your brush is 40/40.');
    const later = { ...next, head: 12_061_140n, safe: 12_061_115n };
    m.store.set({ tick: later, lastGood: later });
    expect(document.querySelector('.flash')?.textContent).toContain('Block 8,530 settled: +57 · settled.');
    expect(document.querySelectorAll('.flash').length).toBe(1); // no second flash
    // state() disagreeing with the log => no flash
    m.cleanup();
    const m2 = mountPlay(stateWith({}));
    const bad = tickWith(budgetOk, { state: { ...tick.state, blockHeight: 8473n } });
    m2.store.set({ tick: bad, lastGood: bad, logs, lastKnownHeight: 8530n });
    expect(document.querySelector('.flash')).toBeNull();
    m2.cleanup();
  });

  it('feed: last 50 with labels + tx links, completeness line; status strip carries SETTLED facts and the PROVISIONAL light', () => {
    const apiBody = { installationId: 'stream-game-sepolia-test-20261025-01', measurement: { freshness: 'online', coreStatus: 'RUNNING', rpmMilli: 42_000, staleAfterSeconds: 120 }, builder: { status: 'available' }, settlementQueue: { status: 'available' } };
    const m = mountPlay(stateWith({ api: { status: 'ok', body: apiBody, summary: summarizeStatus(apiBody), coreAddress: null, implAddress: null, at: T, etag: null, retryAfterMs: null } }));
    const items = m.qa('.feed-item');
    expect(items.length).toBe(5);
    expect(items[0]!.textContent).toContain('FRESH'); // painted at 12,061,050 > safe
    expect(items[0]!.querySelector('a')?.getAttribute('href')).toContain(`${CONFIG.EXPLORER}/tx/`);
    expect(items[1]!.textContent).toContain('SETTLED');
    expect(m.q('.complete-line')?.textContent).toBe(copy.COMPLETE_LINE(CONFIG.PIT_DEPLOY_BLOCK.toLocaleString('en-US'), '12,061,040'));
    const strip = m.q('.strip')!.textContent!;
    expect(strip).toContain('Core height 8,473 · settledThroughRound 1,246');
    expect(strip).toContain('last settlement: Squeek block 8,473 (+43) · round 1,246 · ETH block 12,061,000');
    expect(strip).toContain('PROVISIONAL api.squeekchain.com: online · running · 42 rpm');
    expect(strip).toContain(copy.PROVISIONAL_NOTE);
    // a stale measurement or an unavailable component is UNKNOWN, never "ok"
    const staleBody = { ...apiBody, measurement: { ...apiBody.measurement, freshness: 'stale' } };
    m.store.set({ api: { status: statusOf(staleBody), body: staleBody, summary: summarizeStatus(staleBody), coreAddress: null, implAddress: null, at: T, etag: null, retryAfterMs: null } });
    expect(m.q('.strip .provisional')?.textContent).toContain(copy.WORD_UNKNOWN('21:42'));
    expect(m.q('.strip .provisional')?.textContent).not.toMatch(/running|42 rpm|: ok/);
    // INCOMPLETE logs
    m.store.set({ logs: logsWith({ incomplete: true, failedChunks: 3 }) });
    expect(m.q('.complete-line')?.textContent).toContain(copy.INCOMPLETE_LINE('3'));
    m.cleanup();
  });

  it('top crews mini table is sorted by cells held and labelled as of head', () => {
    const m = mountPlay(stateWith({}));
    const rows = m.qa('.crew-table tbody tr');
    expect(rows.map((r) => r.getAttribute('data-crew'))).toEqual(['2', '3', '0', '1']);
    expect(rows[0]!.textContent).toContain('Seed');
    expect(rows[0]!.textContent).toContain('12');
    expect(m.q('.crews')?.textContent).toContain('FRESH as of ETH block 12,061,055 (head)');
    m.cleanup();
  });

  it('cleanup removes listeners, canvas and style stays idempotent', () => {
    const m = mountPlay(stateWith({}));
    m.cleanup();
    expect(m.root.querySelector('canvas')).toBeNull();
    expect(document.querySelectorAll('#play-style').length).toBe(1);
  });
});

// ---------- Join card / sheet ----------
describe('Join card (SPEC §2.2, §2.3, §7.3)', () => {
  function mountJoin(state: AppState, send?: (s: AppState, crew: number) => Promise<Hex>) {
    document.body.innerHTML = '';
    const el = document.createElement('div');
    document.body.append(el);
    const store = new Store(state);
    const actions = fakeActions();
    const body = createJoinBody(el, { store, actions, send });
    body.render(store.get());
    store.subscribe((s) => body.render(s));
    return { el, store, actions, body };
  }

  it('disconnected: lists EIP-6963 providers and connects the chosen one', () => {
    const j = mountJoin(stateWith({ wallet: { status: 'disconnected', providers: [providerA, providerB] }, lastGood: tickWith(null) }));
    const btns = [...j.el.querySelectorAll('.provider-btn')] as HTMLButtonElement[];
    expect(btns.map((b) => b.textContent)).toEqual(['Wallet A', 'Wallet B']);
    btns[1]!.click();
    expect(j.actions.connectWallet).toHaveBeenCalledWith(providerB);
    expect(j.el.querySelector('.join-btn')).toHaveProperty('disabled', true);
    expect(j.el.querySelector('.reason')?.textContent).toBe(copy.REASON_NO_WALLET);
    expect(j.el.textContent).toContain(copy.JOIN_BUDGET_P1);
    expect(j.el.textContent).toContain(copy.JOIN_BUDGET_P2);
    expect(j.el.textContent).not.toMatch(/Tester/);
  });

  it('no provider at all: §6.4 sentence', () => {
    const j = mountJoin(stateWith({ wallet: { status: 'disconnected', providers: [] }, lastGood: tickWith(null) }));
    expect(j.el.textContent).toContain(copy.ERR_NO_WALLET);
  });

  it('wrong network and low balance show the switch button and faucet links', () => {
    const j = mountJoin(stateWith({ wallet: connected({ wrongNetwork: true, lowBalance: true, balanceWei: 1n }), lastGood: tickWith(budgetNotJoined) }));
    expect(j.el.textContent).toContain(copy.WALLET_SWITCH);
    expect(j.el.textContent).toContain(copy.WALLET_LOW_BALANCE);
    expect(j.el.querySelectorAll('.faucets a').length).toBe(copy.FAUCETS.length);
    expect(j.el.querySelector('.reason')?.textContent).toBe(copy.REASON_WRONG_NETWORK);
  });

  it('FORFEITED label appears next to "+N arrived, M forfeited above cap" when M > 0; FRESH carries the not-yet-safe tooltip', () => {
    const m = mountPlay(stateWith({}));
    const battery = m.q('.battery')!;
    expect(battery.textContent).toContain(copy.BATTERY_ARRIVED('57', '30'));
    expect(battery.querySelector('.tag-forfeited')?.textContent).toBe(copy.LABEL_FORFEITED);
    const fresh = m.root.querySelector('.tag-fresh');
    expect(fresh?.getAttribute('title')).toBe(copy.TOOLTIP_NOT_YET_SAFE);
    m.store.set({ lastGood: tickWith({ ...budgetOk, forfeited: 0n }), tick: tickWith({ ...budgetOk, forfeited: 0n }) });
    expect(m.q('.battery .tag-forfeited')).toBeNull();
    m.cleanup();
  });

  it('Join sheet (modal, any route): lists the wallets, connects the chosen one, Esc closes', () => {
    document.body.innerHTML = '';
    const store = new Store(stateWith({ wallet: { status: 'disconnected', providers: [providerA, providerB] }, lastGood: tickWith(null) }));
    const actions = fakeActions();
    const close = openJoinSheet({ store, actions });
    const sheet = document.querySelector('.join-sheet')!;
    expect(sheet.getAttribute('role')).toBe('dialog');
    const btns = [...sheet.querySelectorAll('.provider-btn')] as HTMLButtonElement[];
    expect(btns.map((b) => b.textContent)).toEqual(['Wallet A', 'Wallet B']);
    btns[1]!.click();
    expect(actions.connectWallet).toHaveBeenCalledWith(providerB);
    expect(sheet.textContent).toContain(copy.JOIN_BUDGET_P1);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.join-sheet')).toBeNull();
    close(); // idempotent
  });

  it('crew pick -> JOIN -> pending -> Joined line with tx link', async () => {
    const send = vi.fn(async () => h(0xd00d));
    const j = mountJoin(stateWith({ lastGood: tickWith(budgetNotJoined), logs: logsWith({ joined: [] }) }), send);
    expect(j.el.querySelector('.reason')?.textContent).toBe('choose a crew');
    (j.el.querySelector('.crew-btn[data-crew="3"]') as HTMLButtonElement).click();
    expect(j.el.querySelector('.crew-btn[data-crew="3"]')?.getAttribute('aria-pressed')).toBe('true');
    const btn = j.el.querySelector('.join-btn') as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    btn.click();
    await flushAsync();
    expect(send).toHaveBeenCalledWith(expect.anything(), 3);
    expect(j.store.get().pendingTx?.hash).toBe(h(0xd00d));
    expect(j.el.dataset.state).toBe('pending');
    expect(j.el.textContent).toContain(copy.WORD_PENDING_SENT);
    // mined: pendingTx cleared by the tick, budgetOf says joined, the Joined log is in
    const mined = tickWith({ ...budgetOk, ready: 0, banked: 0, fresh: 0 });
    j.store.set({ pendingTx: null, tick: mined, lastGood: mined, logs: logsWith({ joined: [joined(12_061_054n, ADDR, 1, 3)] }) });
    expect(j.el.dataset.state).toBe('joined');
    expect(j.el.textContent).toContain('Joined at Squeek block 8,430 as Moon.');
    expect(j.el.textContent).toContain('FRESH'); // 12,061,054 > safe
    expect(j.el.querySelector('a')?.getAttribute('href')).toBe(`${CONFIG.EXPLORER}/tx/${h(12_061_054)}`);
  });
});
