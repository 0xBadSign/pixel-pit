// Timeline screen (SPEC §6.4 "#/timeline?h=N", §6.3 frame(h)). Day-4 exit test: frame(current) == rawCells()
// on a synthetic log set, plus step building, the CONFIRMED/RECENT stamp, copy link and a jsdom mount.
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Address, Hex } from 'viem';
import { CONFIG, type Config } from '../config';
import * as copy from '../copy';
import { Store, initialState } from '../state';
import { encodeCell, encodeRawCells, decodeRawCells, framesEqual, decodeCell } from '../frame';
import { fmtInt } from '../format';
import type { LogsSnapshot, JoinedEvent, PaintedLog, BatchSettledEvent } from '../logs';
import type { TickOk } from '../rpc';
import { parseHash } from '../router';
import { buildSteps, stepForHeight, stepView, frameStamp, nightMarkers, timelineHref, mount, TL } from './timeline';

// ---------- synthetic log set ----------

const GENESIS_HEIGHT = 8430n;
const DEPLOY = 12_000_000n;
const cfg: Config = { ...CONFIG, GENESIS_HEIGHT, PIT_DEPLOY_BLOCK: DEPLOY, GENESIS_CELLS: [0, 1, 33], GENESIS_COLORS: [13, 13, 14] };

const hash = (n: number | bigint): Hex => `0x${BigInt(n).toString(16).padStart(64, '0')}` as Hex;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, '0')}` as Address;

function joined(p: { block: bigint; logIndex: number; playerId: number; crew: number; coreHeight: bigint }): JoinedEvent {
  return { kind: 'Joined', blockNumber: p.block, logIndex: p.logIndex, txHash: hash(p.block * 10n + BigInt(p.logIndex)), blockHash: hash(p.block), player: addr(p.playerId), playerId: p.playerId, crew: p.crew, coreHeight: p.coreHeight };
}
function painted(p: { block: bigint; logIndex: number; playerId: number; coreHeight: bigint; cells: number[]; colors: number[] }): PaintedLog {
  return { kind: 'Painted', blockNumber: p.block, logIndex: p.logIndex, txHash: hash(p.block * 10n + BigInt(p.logIndex)), blockHash: hash(p.block), player: addr(p.playerId), coreHeight: p.coreHeight, playerId: p.playerId, cells: p.cells, colors: p.colors, budgetLeft: 0 };
}
function settled(p: { block: bigint; logIndex?: number; height: bigint; round: bigint }): BatchSettledEvent {
  return {
    kind: 'BatchSettled',
    blockNumber: p.block,
    logIndex: p.logIndex ?? 0,
    txHash: hash(p.block * 10n),
    blockHash: hash(p.block),
    digest: hash(1),
    reporter: addr(99),
    settledThroughRound: p.round,
    nonce: 1n,
    previousSettledThroughRound: p.round - 1n,
    activeRoundCount: 1,
    cumulativeWork: 0n,
    cumulativeBlockUnits: p.height * 1_000_000_000n,
    height: p.height,
  };
}

// Heights: 8430 (genesis) -> 8473 (+43, round 1246) -> 8473 again (no raise) -> 8530 (+57, round 1247) -> 8520 (lower, ignored) -> 8600 (+70, round 1249)
const settledEvents = [
  settled({ block: DEPLOY + 100n, height: 8473n, round: 1246n }),
  settled({ block: DEPLOY + 150n, height: 8473n, round: 1246n, logIndex: 3 }),
  settled({ block: DEPLOY + 200n, height: 8530n, round: 1247n }),
  settled({ block: DEPLOY + 250n, height: 8520n, round: 1248n }),
  settled({ block: DEPLOY + 400n, height: 8600n, round: 1249n }),
];
const joinedEvents = [
  joined({ block: DEPLOY + 10n, logIndex: 0, playerId: 1, crew: 3, coreHeight: GENESIS_HEIGHT }),
  joined({ block: DEPLOY + 11n, logIndex: 0, playerId: 2, crew: 0, coreHeight: GENESIS_HEIGHT }),
  joined({ block: DEPLOY + 12n, logIndex: 0, playerId: 3, crew: 2, coreHeight: GENESIS_HEIGHT }),
];
// deliberately out of order
const paintedEvents = [
  painted({ block: DEPLOY + 210n, logIndex: 1, playerId: 2, coreHeight: 8530n, cells: [5, 6, 0], colors: [4, 4, 1] }), // overpaints genesis cell 0
  painted({ block: DEPLOY + 101n, logIndex: 0, playerId: 1, coreHeight: 8473n, cells: [5, 70, 71], colors: [9, 10, 10] }),
  painted({ block: DEPLOY + 101n, logIndex: 4, playerId: 3, coreHeight: 8473n, cells: [5], colors: [12] }), // same block, later logIndex wins
  painted({ block: DEPLOY + 205n, logIndex: 0, playerId: 1, coreHeight: 8530n, cells: [100, 101], colors: [7, 7] }),
  painted({ block: DEPLOY + 401n, logIndex: 0, playerId: 3, coreHeight: 8600n, cells: [1023, 100], colors: [15, 0] }), // colour 0 still a stroke
];

function snapshot(o: Partial<LogsSnapshot> = {}): LogsSnapshot {
  const crewByPlayerId = new Map<number, number>();
  for (const j of joinedEvents) crewByPlayerId.set(j.playerId, j.crew);
  return { joined: joinedEvents, painted: paintedEvents, settled: settledEvents, crewByPlayerId, completeThrough: DEPLOY + 500n, canonicalThrough: DEPLOY + 450n, incomplete: false, failedChunks: 0, provider: 'fake', at: 0, ...o };
}

/** Independent model of the contract's cells: apply strokes in (blockNumber, logIndex) order, then rawCells() words. */
function syntheticRawCells(upToHeight: bigint): bigint[] {
  const cells = new Uint32Array(1024);
  cfg.GENESIS_CELLS.forEach((c, i) => (cells[c] = encodeCell({ color: cfg.GENESIS_COLORS[i]!, crew: 0, genesis: true, painterId: 0 })));
  const crew = new Map(joinedEvents.map((j) => [j.playerId, j.crew]));
  const ordered = paintedEvents.filter((p) => p.coreHeight <= upToHeight).sort((a, b) => (a.blockNumber !== b.blockNumber ? Number(a.blockNumber - b.blockNumber) : a.logIndex - b.logIndex));
  for (const p of ordered) p.cells.forEach((c, i) => (cells[c] = encodeCell({ color: p.colors[i]!, crew: crew.get(p.playerId) ?? 0, genesis: false, painterId: p.playerId })));
  return encodeRawCells(cells);
}

function tick(o: Partial<TickOk> = {}): TickOk {
  const head = DEPLOY + 500n;
  return {
    ok: true,
    at: Date.UTC(2026, 10, 4, 21, 42),
    provider: 'fake',
    providerIndex: 0,
    head,
    headHash: hash(head),
    headTimestamp: BigInt(Math.floor(Date.UTC(2026, 10, 4, 21, 42) / 1000)),
    safe: head - 12n,
    finalized: head - 64n,
    finalityTags: true,
    state: { settledThroughRound: 1249n, cumulativeWork: 0n, cumulativeBlockUnits: 8600n * 1_000_000_000n, blockHeight: 8600n, blockProgress: 0n, workPerThousandBlocks: 0, authorizationNonce: 0n, paused: false },
    pit: null,
    wallet: null,
    ...o,
  };
}

// ---------- model ----------

describe('timeline steps (SPEC §6.4)', () => {
  it('genesis + only height-raising settlements, in block order', () => {
    const steps = buildSteps(snapshot(), null, cfg);
    expect(steps.map((s) => [s.source, s.height, s.delta, s.round])).toEqual([
      ['genesis', 8430n, 0n, null],
      ['log', 8473n, 43n, 1246n],
      ['log', 8530n, 57n, 1247n],
      ['log', 8600n, 70n, 1249n],
    ]);
    expect(steps[0]!.blockNumber).toBe(DEPLOY);
    expect(steps[3]!.blockNumber).toBe(DEPLOY + 400n);
  });

  it('adds a state() step only when head height is above the last logged settlement', () => {
    const same = buildSteps(snapshot(), { height: 8600n, round: 1249n, head: DEPLOY + 500n }, cfg);
    expect(same.length).toBe(4);
    const ahead = buildSteps(snapshot(), { height: 8640n, round: 1250n, head: DEPLOY + 500n }, cfg);
    expect(ahead.length).toBe(5);
    expect(ahead[4]).toMatchObject({ source: 'state', height: 8640n, delta: 40n, round: 1250n, blockNumber: DEPLOY + 500n });
    // no logs at all: genesis only (works with no wallet and no new blocks)
    expect(buildSteps(null, null, cfg).length).toBe(1);
  });

  it('?h=N resolves to the last step with height <= N', () => {
    const steps = buildSteps(snapshot(), null, cfg);
    expect(stepForHeight(steps, 8473n)).toBe(1);
    expect(stepForHeight(steps, 8529n)).toBe(1);
    expect(stepForHeight(steps, 8530n)).toBe(2);
    expect(stepForHeight(steps, 99999n)).toBe(3);
    expect(stepForHeight(steps, 1n)).toBe(0);
  });
});

describe('frame(current) == rawCells() on a synthetic log set (SPEC §6.3 day-4 exit test)', () => {
  const snap = snapshot();
  const steps = buildSteps(snap, null, cfg);

  it('the last frame equals the decoded rawCells() words', () => {
    const view = stepView(steps, steps.length - 1, snap, null, cfg);
    const onchain = decodeRawCells(syntheticRawCells(8600n));
    expect(framesEqual(view.frame, onchain)).toBe(true);
    expect(decodeCell(view.frame[5]!)).toEqual({ color: 4, crew: 0, genesis: false, painterId: 2 });
    expect(decodeCell(view.frame[0]!).genesis).toBe(false); // genesis cell overpainted
    expect(decodeCell(view.frame[1]!).genesis).toBe(true);
  });

  it('every intermediate frame equals rawCells() at that height and excludes later strokes', () => {
    for (let i = 0; i < steps.length; i++) {
      const view = stepView(steps, i, snap, null, cfg);
      expect(framesEqual(view.frame, decodeRawCells(syntheticRawCells(steps[i]!.height))), `step ${i}`).toBe(true);
    }
    const f1 = stepView(steps, 1, snap, null, cfg).frame;
    expect(decodeCell(f1[5]!)).toEqual({ color: 12, crew: 2, genesis: false, painterId: 3 }); // same block: higher logIndex wins
    expect(f1[100]).toBe(0);
    expect(decodeCell(f1[0]!).genesis).toBe(true);
  });

  it('frame 0 is genesis only', () => {
    const v0 = stepView(steps, 0, snap, null, cfg);
    expect(v0.strokes).toBe(0);
    expect(v0.filled).toBe(3);
    for (let c = 0; c < 1024; c++) if (v0.frame[c] !== 0) expect(decodeCell(v0.frame[c]!).genesis).toBe(true);
  });

  it('panel numbers: strokes/wallets at that height, cells filled, last event block', () => {
    const v1 = stepView(steps, 1, snap, null, cfg);
    expect(v1).toMatchObject({ strokes: 4, wallets: 2, filled: 3 + 3, lastEventBlock: DEPLOY + 101n });
    const v2 = stepView(steps, 2, snap, null, cfg);
    expect(v2).toMatchObject({ strokes: 5, wallets: 2, filled: 3 + 3 + 3, lastEventBlock: DEPLOY + 210n });
    const v3 = stepView(steps, 3, snap, null, cfg);
    expect(v3).toMatchObject({ strokes: 2, wallets: 1, filled: 10, lastEventBlock: DEPLOY + 401n });
  });

  it('fresh cells are those whose last stroke is in a block > safe', () => {
    const v = stepView(steps, 3, snap, DEPLOY + 300n, cfg);
    expect([...v.fresh].sort((a, b) => a - b)).toEqual([100, 1023]);
    expect(stepView(steps, 3, snap, DEPLOY + 500n, cfg).fresh.size).toBe(0);
  });
});

describe('stamp, nights, link', () => {
  it('CONFIRMED when last event block <= safe, RECENT otherwise, UNKNOWN without safe', () => {
    expect(frameStamp(100n, 100n)).toBe('CONFIRMED');
    expect(frameStamp(101n, 100n)).toBe('RECENT');
    expect(frameStamp(1n, null)).toBe('UNKNOWN');
  });

  it('night separators at 12:00 UTC between steps (estimated), none without a tick', () => {
    const steps = buildSteps(snapshot(), null, cfg);
    expect(nightMarkers(steps, null)).toEqual([]);
    // head at 21:42 UTC, 2,700 blocks (9 h) after the last settlement: genesis 11:22, 8473 at 11:42, 8530 at 12:02, 8600 at 12:42
    const t = tick({ head: DEPLOY + 400n + 2700n });
    const m = nightMarkers(steps, { head: t.head, headTimestamp: t.headTimestamp });
    expect(m.length).toBe(1);
    expect(m[0]!.day).toBe('2026-11-04');
    expect(m[0]!.height).toBeCloseTo(8473 + 57 * 0.9, 6); // 18 of the 20 minutes between the two settlements
    // head within the same hour as the settlements: no crossing
    expect(nightMarkers(steps, { head: DEPLOY + 500n, headTimestamp: t.headTimestamp })).toEqual([]);
  });

  it('copy link target is #/timeline?h=N', () => {
    expect(timelineHref(8473n)).toBe('#/timeline?h=8473');
  });
});

// ---------- jsdom mount ----------

describe('timeline screen mount (jsdom)', () => {
  const cleanups: (() => void)[] = [];
  beforeAll(() => {
    // jsdom has no 2d context: a recording stub keeps PitCanvas happy
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'canvas' ? null : () => undefined), set: () => true });
    HTMLCanvasElement.prototype.getContext = (() => ctx) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  });
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    document.body.replaceChildren();
  });

  function mountWith(state: Partial<typeof initialState>, hashStr = '#/timeline') {
    const root = document.createElement('main');
    document.body.append(root);
    const store = new Store({ ...initialState, ...state });
    cleanups.push(mount(root, store, parseHash(hashStr)));
    return { root, store };
  }

  it('with logs + tick: slider over GENESIS..current, panel line from copy.TIMELINE_PANEL, CONFIRMED + SETTLED labels, §7.15 line', () => {
    const t = tick();
    const { root } = mountWith({ logs: snapshot(), tick: t, lastGood: t });
    const slider = root.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(slider.min).toBe(String(CONFIG.GENESIS_HEIGHT)); // mount uses the pinned CONFIG, snapshot heights are above it
    expect(slider.max).toBe('8600');
    expect(slider.value).toBe('8600'); // follows the newest step when ?h is absent
    const ticks = root.querySelectorAll('.tl-tick');
    expect(ticks.length).toBe(3); // one per height-raising settlement
    const panel = root.querySelector('.tl-panel')!.textContent!;
    const completeN = t.safe; // min(completeThrough, safe)
    // expected numbers from the pure model with the pinned CONFIG (its genesis cells differ from `cfg`)
    const steps = buildSteps(snapshot(), { height: 8600n, round: 1249n, head: t.head }, CONFIG);
    const v = stepView(steps, steps.length - 1, snapshot(), t.safe, CONFIG);
    expect(v.strokes).toBe(2);
    expect(v.wallets).toBe(1);
    expect(panel).toBe(copy.TIMELINE_PANEL('8,600', '70', '1,249', '2', '1', fmtInt(v.filled), fmtInt(completeN)));
    expect(root.querySelector('.tl-stamp')!.textContent).toBe(copy.LABEL_CONFIRMED);
    expect(root.querySelector('.tl-head .tag')!.textContent).toBe(copy.LABEL_SETTLED);
    expect(root.querySelector('.tl-complete')!.textContent).toContain(copy.COMPLETE_LINE(fmtInt(CONFIG.PIT_DEPLOY_BLOCK), fmtInt(completeN)));
    expect(root.querySelector('.tl-copy')!.textContent).toBe(TL.COPY_LINK);
    expect(root.querySelector('.tl-play')!.textContent).toBe(TL.PLAY);
  });

  it('?h=N selects that frame, arrow keys step one settlement, frame 0 is labelled genesis', () => {
    const t = tick();
    const { root } = mountWith({ logs: snapshot(), tick: t, lastGood: t }, '#/timeline?h=8500');
    const slider = root.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(slider.value).toBe('8473');
    expect(slider.getAttribute('aria-valuetext')).toBe(TL.SQUEEK_BLOCK('8,473'));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    expect(slider.value).toBe('8530');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    expect(slider.value).toBe(String(CONFIG.GENESIS_HEIGHT));
    expect(root.querySelector('.tl-frame0')!.textContent).toContain(copy.GENESIS_FRAME0);
    expect(root.querySelector('.tl-panel')!.textContent).toContain(copy.GENESIS_FRAME0);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true })); // clamps at genesis
    expect(slider.value).toBe(String(CONFIG.GENESIS_HEIGHT));
  });

  it('RECENT when the frame has events after safe; Copy link writes #/timeline?h=N', async () => {
    const t = tick({ safe: DEPLOY + 300n });
    const { root } = mountWith({ logs: snapshot(), tick: t, lastGood: t }, '#/timeline?h=8600');
    expect(root.querySelector('.tl-stamp')!.textContent).toBe(copy.LABEL_RECENT);
    expect(root.querySelector('.tl-head .tag')!.textContent).toBe(copy.LABEL_FRESH);
    const writeText = vi.fn((_url: string) => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    root.querySelector<HTMLButtonElement>('.tl-copy')!.click();
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(String(writeText.mock.calls[0]![0])).toMatch(/#\/timeline\?h=8600$/);
    await Promise.resolve();
    expect(root.querySelector('.tl-copied')!.textContent).toContain(TL.COPIED);
  });

  it('INCOMPLETE logs: INCOMPLETE tag and §7.15 incomplete line', () => {
    const t = tick();
    const { root } = mountWith({ logs: snapshot({ incomplete: true, failedChunks: 2 }), tick: t, lastGood: t });
    expect(root.querySelector('.tl-head .tag-incomplete')!.textContent).toBe(copy.LABEL_INCOMPLETE);
    expect(root.querySelector('.tl-complete')!.textContent).toContain(copy.INCOMPLETE_LINE('2'));
    expect(root.querySelector('.timeline')!.classList.contains('tl-incomplete')).toBe(true);
  });

  it('no logs and no tick: canvas shows genesis frame 0, UNKNOWN with a clock, no stroke numbers', () => {
    const { root } = mountWith({});
    expect(root.querySelector('canvas')).not.toBeNull();
    expect(root.querySelector('.tl-stamp')!.textContent).toBe(copy.LABEL_UNKNOWN);
    const panel = root.querySelector('.tl-panel')!.textContent!;
    expect(panel).toMatch(/^unknown as of \d{2}:\d{2} UTC$/);
    expect(root.querySelector('.tl-complete')!.textContent).toContain(copy.LABEL_UNKNOWN);
    expect(root.querySelector<HTMLInputElement>('input[type=range]')!.disabled).toBe(true);
    expect(root.querySelector('.tl-frame0')!.textContent).toContain(copy.GENESIS_FRAME0);
  });

  it('a shared #/timeline?h=N link opened before the first tick lands on N once logs + tick arrive (not on the newest frame)', () => {
    const { root, store } = mountWith({}, '#/timeline?h=8500');
    const slider = root.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(slider.disabled).toBe(true); // nothing loaded yet: genesis only, link still pending
    const t = tick();
    store.set({ logs: snapshot(), tick: t, lastGood: t });
    expect(slider.max).toBe('8600');
    expect(slider.value).toBe('8473'); // last step <= 8500, not the newest
    expect(root.querySelector('.tl-panel')!.textContent).toContain('at block 8,473');
    // and a later tick does not drag the user off the linked frame
    const t2 = tick({ at: t.at + 12_000, state: { ...t.state, blockHeight: 8641n, settledThroughRound: 1250n } });
    store.set({ tick: t2, lastGood: t2 });
    expect(slider.value).toBe('8473');
  });

  it('a later store update with a higher head height appends a state() step and follows it', () => {
    const t = tick();
    const { root, store } = mountWith({ logs: snapshot(), tick: t, lastGood: t });
    const slider = root.querySelector<HTMLInputElement>('input[type=range]')!;
    expect(slider.value).toBe('8600');
    const t2 = tick({ at: t.at + 12_000, state: { ...t.state, blockHeight: 8641n, settledThroughRound: 1250n } });
    store.set({ tick: t2, lastGood: t2 });
    expect(slider.max).toBe('8641');
    expect(slider.value).toBe('8641');
    expect(root.querySelector('.tl-stamp')!.textContent).toBe(copy.LABEL_RECENT); // head > safe
    expect(root.querySelector('.tl-panel')!.textContent).toContain('+41');
  });
});
