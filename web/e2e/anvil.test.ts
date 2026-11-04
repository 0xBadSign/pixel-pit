// @vitest-environment node
// Local end-to-end against anvil + MockCore + the dev Pit (see e2e/README.md). Runs the page's own
// modules (CONFIG dev branch, rpc.runTick, LogStore, frame(), batteryModel, renderBattery, describeError)
// against a real chain, never mocks. Requires: anvil on 127.0.0.1:8545 with script/DeployDev.s.sol
// broadcast and src/deployment.dev.json written (npm run dev-deployment). The whole suite runs inside an
// anvil snapshot and reverts it afterwards, so `npm run e2e` is repeatable.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createPublicClient, createWalletClient, http, parseAbi, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { CONFIG } from '../src/config';
import { pixelPitAbi } from '../src/abi';
import { makeHttpClients, runTick, type RpcClient, type TickOk } from '../src/rpc';
import { LogStore } from '../src/logs';
import { frame, genesisFrame, decodeRawCells, framesEqual, encodeCell } from '../src/frame';
import { batteryModel } from '../src/state';
import { renderBattery } from '../src/ui/battery';
import { describeError } from '../src/wallet';
import { ethCall } from '../src/eth';
import * as copy from '../src/copy';
import { JSDOM } from 'jsdom';

// node environment (jsdom's AbortController is rejected by Node's fetch, which viem's http transport uses);
// the battery renderer only needs a document, so one JSDOM document is installed for it.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
(globalThis as unknown as { document: Document }).document = dom.window.document;

// anvil's default, publicly documented dev keys (chain 31337 only; never funds on a real network)
const ANVIL_KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
];

const mockCoreAbi = parseAbi([
  'function height() view returns (uint64)',
  'function bump(uint64 n)',
  'function setHeight(uint64 h)',
  'function setRevertNext(bool v)',
  'function clearModes()',
]);

const rpcUrl = CONFIG.RPC[0]!;
const transport = http(rpcUrl, { timeout: 10_000, retryCount: 0 });
const pub = createPublicClient({ transport });
const clients: RpcClient[] = makeHttpClients(CONFIG.RPC);

type Ctx = {
  wallet: ReturnType<typeof createWalletClient>;
  player: Address;
  snapshot: Hex;
  h0: bigint;
};
const ctx = {} as Ctx;

async function rpc<T>(method: string, params: unknown[] = []): Promise<T> {
  return (await pub.request({ method, params } as never)) as T;
}

/** Mine an empty block with the current wall-clock timestamp so the head is never "stale" (SPEC §6.3, 120 s). */
async function freshHead(): Promise<void> {
  await rpc('evm_setNextBlockTimestamp', [Math.floor(Date.now() / 1000)]).catch(() => undefined);
  await rpc('evm_mine', []);
}

async function tick(wallet: Address | null): Promise<TickOk> {
  await freshHead();
  const r = await runTick(clients, { wallet });
  if (!r.ok) throw new Error(`tick failed: ${r.reason} ${r.error}`);
  return r;
}

async function write(functionName: 'join' | 'paint', args: readonly unknown[], account = ctx.wallet.account!): Promise<Hex> {
  const hash = await ctx.wallet.writeContract({
    address: CONFIG.PIT,
    abi: pixelPitAbi,
    functionName,
    args: args as never,
    account,
    chain: null,
  } as never);
  const rc = await pub.waitForTransactionReceipt({ hash });
  expect(rc.status).toBe('success');
  return hash;
}

async function mock(functionName: 'bump' | 'setHeight' | 'setRevertNext' | 'clearModes', args: readonly unknown[] = []): Promise<void> {
  const hash = await ctx.wallet.writeContract({ address: CONFIG.CORE, abi: mockCoreAbi, functionName, args: args as never, account: ctx.wallet.account!, chain: null } as never);
  const rc = await pub.waitForTransactionReceipt({ hash });
  expect(rc.status).toBe('success');
}

async function budgetOf(player: Address) {
  const r = await ethCall(pub, { address: CONFIG.PIT, abi: pixelPitAbi, functionName: 'budgetOf', args: [player] });
  return { joined: r[0], coreOk: r[1], coreHeight: r[2], ready: r[3], banked: r[4], fresh: r[5], arrived: r[6], forfeited: r[7] };
}

/** The page's own log replay: LogStore.sync on the tick's provider, then frame(null, painted, crews, genesis). */
async function replayFrame(t: TickOk): Promise<{ replayed: Uint32Array; onchain: Uint32Array; store: LogStore; integrity: ReturnType<LogStore['integrity']> }> {
  const noBootstrap = (() => Promise.reject(new Error('no bootstrap file on anvil'))) as unknown as typeof fetch;
  const store = new LogStore({ cfg: CONFIG, storage: null, fetchFn: noBootstrap });
  await store.loadInitial();
  const { snapshot, failed } = await store.sync(clients[t.providerIndex]!, t);
  expect(failed).toBe(0);
  expect(snapshot.incomplete).toBe(false);
  const genesis = genesisFrame(CONFIG.GENESIS_CELLS, CONFIG.GENESIS_COLORS);
  const replayed = frame(null, snapshot.painted, snapshot.crewByPlayerId, genesis);
  const onchain = decodeRawCells(t.pit!.rawCells);
  return { replayed, onchain, store, integrity: store.integrity(t, snapshot) };
}

function digitsOutsideClock(text: string): string {
  return text.replace(/\b\d{2}:\d{2}\b/g, '').replace(/[^0-9]/g, '');
}

beforeAll(async () => {
  expect(CONFIG.DEV, 'e2e must run with the dev config (vitest.e2e.config.ts defines __PIT_DEV__ = true)').toBe(true);
  const chainId = await pub.getChainId();
  expect(chainId).toBe(CONFIG.chainId);
  ctx.snapshot = await rpc<Hex>('evm_snapshot', []);

  // first anvil account that has not joined yet (a crashed previous run leaves state behind)
  let chosen: Hex | null = null;
  for (const key of ANVIL_KEYS) {
    const addr = privateKeyToAccount(key).address;
    const b = await budgetOf(addr);
    if (!b.joined) {
      chosen = key;
      break;
    }
  }
  if (!chosen) throw new Error('every anvil dev account already joined; restart anvil and redeploy');
  const account = privateKeyToAccount(chosen);
  ctx.wallet = createWalletClient({ account, transport });
  ctx.player = account.address;
  await mock('clearModes');
  ctx.h0 = await ethCall(pub, { address: CONFIG.CORE, abi: mockCoreAbi, functionName: 'height' });
});

afterAll(async () => {
  if (ctx.snapshot) await rpc('evm_revert', [ctx.snapshot]).catch(() => undefined);
});

describe('anvil end-to-end (dev Pit + MockCore)', () => {
  it('deployment.dev.json matches the chain: Pit.CORE(), DEPLOY_BLOCK(), GENESIS_HEIGHT(), genesis cells', async () => {
    const [core, deployBlock, genesisHeight] = await Promise.all([
      ethCall(pub, { address: CONFIG.PIT, abi: pixelPitAbi, functionName: 'CORE' }),
      ethCall(pub, { address: CONFIG.PIT, abi: pixelPitAbi, functionName: 'DEPLOY_BLOCK' }),
      ethCall(pub, { address: CONFIG.PIT, abi: pixelPitAbi, functionName: 'GENESIS_HEIGHT' }),
    ]);
    expect(core.toLowerCase()).toBe(CONFIG.CORE.toLowerCase());
    expect(deployBlock).toBe(CONFIG.PIT_DEPLOY_BLOCK);
    expect(genesisHeight).toBe(CONFIG.GENESIS_HEIGHT);
    expect(CONFIG.GENESIS_CELLS.length).toBeGreaterThan(0);
    expect(CONFIG.GENESIS_CELLS.length).toBe(CONFIG.GENESIS_COLORS.length);
    // every genesis cell is on chain with painterId 0, genesis bit 1, crew 0
    const t = await tick(null);
    const onchain = decodeRawCells(t.pit!.rawCells);
    for (let i = 0; i < CONFIG.GENESIS_CELLS.length; i++) {
      const c = CONFIG.GENESIS_CELLS[i]!;
      expect(onchain[c]).toBe(encodeCell({ color: CONFIG.GENESIS_COLORS[i]!, crew: 0, genesis: true, painterId: 0 }));
    }
  });

  it('a tick on the dev provider is ok, pinned to one block, and state().blockHeight is the mock height', async () => {
    const t = await tick(null);
    expect(t.provider).toBe(rpcUrl);
    expect(t.finalityTags).toBe(false); // anvil: head-12 / head-64 fallback
    expect(t.safe).toBeLessThanOrEqual(t.head);
    expect(t.state.blockHeight).toBe(ctx.h0);
    expect(t.state.paused).toBe(false);
    expect(t.pit).not.toBeNull();
    expect(t.pit!.rawCells.length).toBe(128);
    expect(t.pit!.budget).toBeNull(); // no wallet passed
  });

  it('before any paint, frame(logs) == rawCells() (genesis only)', async () => {
    const t = await tick(null);
    const { replayed, onchain } = await replayFrame(t);
    expect(framesEqual(replayed, onchain)).toBe(true);
  });

  it('join: budget starts at 0 (credited = lastHeight = H), battery shows numbers (not UNKNOWN)', async () => {
    await write('join', [2]);
    const b = await budgetOf(ctx.player);
    expect(b).toMatchObject({ joined: true, coreOk: true, coreHeight: ctx.h0, ready: 0, banked: 0, fresh: 0 });
    const t = await tick(ctx.player);
    expect(t.pit!.budget).toMatchObject({ joined: true, coreOk: true, ready: 0 });
    const m = batteryModel(t, t.pit!.budget, true, null, 0);
    expect(m.kind).toBe('numbers');
  });

  it('bump +43: budgetOf.ready == 40 (CAP), fresh 40, coreHeight H+43', async () => {
    await mock('bump', [43n]);
    const b = await budgetOf(ctx.player);
    expect(b.coreHeight).toBe(ctx.h0 + 43n);
    expect(b.ready).toBe(40);
    expect(b.coreOk).toBe(true);
    const t = await tick(ctx.player);
    expect(t.state.blockHeight).toBe(ctx.h0 + 43n);
    expect(t.pit!.budget!.ready).toBe(40);
    const el = document.createElement('div');
    renderBattery(el, batteryModel(t, t.pit!.budget, true, null, 0));
    expect(el.dataset.state).toBe('numbers');
    expect(el.textContent).toContain(copy.BATTERY_READY('40', '0', '40'));
  });

  it('paint 30 cells: budgetOf.ready == 10, rawCells updated, frame(logs) == rawCells(), integrity (a)(b)(c) pass', async () => {
    const cells = Array.from({ length: 30 }, (_, i) => 500 + i * 3);
    const colors = cells.map((_, i) => 1 + (i % 15));
    await write('paint', [cells, colors]);
    const b = await budgetOf(ctx.player);
    expect(b.ready).toBe(10);
    expect(b.banked).toBe(10);
    expect(b.fresh).toBe(0);

    const t = await tick(ctx.player);
    expect(t.pit!.totalStrokes).toBe(30n);
    expect(t.pit!.playerCount).toBeGreaterThanOrEqual(1);
    const { replayed, onchain, integrity } = await replayFrame(t);
    expect(framesEqual(replayed, onchain)).toBe(true);
    // the painted cells carry the painter's crew (2 = Seed) and colour; genesis bit off
    const playerId = Number((await ethCall(pub, { address: CONFIG.PIT, abi: pixelPitAbi, functionName: 'players', args: [ctx.player] })).id);
    for (let i = 0; i < cells.length; i++) {
      expect(onchain[cells[i]!]).toBe(encodeCell({ color: colors[i]!, crew: 2, genesis: false, painterId: playerId }));
    }
    expect(integrity.checked).toBe(true);
    expect(integrity.a).toBe(true);
    expect(integrity.b).toBe(true);
    expect(integrity.c).toBe(true);
    expect(integrity.d).toBeNull(); // MockCore emits no BatchSettled, so (d) has nothing to compare
    expect(t.pit!.crewScores[2]).toBe(30);
  });

  it('repainting own cells spends budget but holds the same pixels (surviving count unchanged)', async () => {
    const before = await budgetOf(ctx.player);
    await write('paint', [[500, 503], [4, 4]]);
    const after = await budgetOf(ctx.player);
    expect(after.ready).toBe(before.ready - 2);
    const t = await tick(ctx.player);
    expect(t.pit!.crewScores[2]).toBe(30);
    const { replayed, onchain } = await replayFrame(t);
    expect(framesEqual(replayed, onchain)).toBe(true);
  });

  it('partial height decrease: tick stays ok, numbers still shown (coreOk), page would show the backwards banner', async () => {
    const prev = await tick(ctx.player);
    const prevH = prev.state.blockHeight; // H+43
    const cred = ctx.h0 + 43n - BigInt((await budgetOf(ctx.player)).ready); // credited = H - ready
    await mock('setHeight', [prevH - 5n]);
    const t = await tick(ctx.player);
    expect(t.state.blockHeight).toBe(prevH - 5n);
    expect(t.state.blockHeight < prevH).toBe(true); // main.ts: HEIGHT_BACKWARDS banner + heightMovedBack
    const banner = copy.HEIGHT_BACKWARDS(String(t.state.blockHeight), String(prevH));
    expect(banner).toContain(String(prevH - 5n));
    expect(banner).toContain(String(prevH));
    const b = t.pit!.budget!;
    expect(b.coreOk).toBe(true);
    expect(b.coreHeight).toBe(prevH - 5n);
    // credited never decreases: ready = max(0, H - credited) under the lower height
    const expectedReady = prevH - 5n > cred ? Number(prevH - 5n - cred) : 0;
    expect(b.ready).toBe(expectedReady);
    const m = batteryModel(t, b, true, null, 0);
    expect(m.kind).toBe('numbers');
    await mock('setHeight', [prevH]);
    expect((await budgetOf(ctx.player)).ready).toBe(Number(prevH - cred));
  });

  it('Core below GENESIS_HEIGHT: tick ok but coreOk=false => battery UNKNOWN with no digits, paint reverts CoreUnavailable', async () => {
    const prevH = (await budgetOf(ctx.player)).coreHeight;
    await mock('setHeight', [CONFIG.GENESIS_HEIGHT - 1n]);
    const b = await budgetOf(ctx.player);
    expect(b.coreOk).toBe(false);
    expect(b).toMatchObject({ coreHeight: 0n, ready: 0, banked: 0, fresh: 0, arrived: 0n, forfeited: 0n });
    const t = await tick(ctx.player);
    expect(t.ok).toBe(true); // state() itself still reads
    expect(t.pit!.budget!.coreOk).toBe(false);
    const m = batteryModel(t, t.pit!.budget, true, null, 0);
    expect(m.kind).toBe('unknown');
    const el = document.createElement('div');
    renderBattery(el, m);
    expect(el.dataset.state).toBe('unknown');
    expect(el.textContent).toContain(copy.LABEL_UNKNOWN);
    expect(digitsOutsideClock(el.textContent ?? '')).toBe(''); // never a 0 in place of a budget
    // paint path (eth_estimateGas on the tick provider, as play.ts does) -> CoreUnavailable sentence
    const err = await pub
      .estimateContractGas({ address: CONFIG.PIT, abi: pixelPitAbi, functionName: 'paint', args: [[1], [1]], account: ctx.player })
      .then(() => null, (e: unknown) => e);
    expect(err).not.toBeNull();
    const d = describeError(err);
    expect(d.name).toBe('CoreUnavailable');
    expect(d.sentence).toBe(copy.ERR_SENTENCES.CoreUnavailable);
    await mock('setHeight', [prevH]);
    expect((await budgetOf(ctx.player)).coreOk).toBe(true);
  });

  it('Core state() reverting: the whole tick is UNKNOWN (never half a tick), battery UNKNOWN, join/paint revert CoreUnavailable', async () => {
    await mock('setRevertNext', [true]);
    await freshHead();
    const r = await runTick(clients, { wallet: ctx.player });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unreachable');
    const m = batteryModel(r, null, true, null, 0);
    expect(m.kind).toBe('unknown');
    const el = document.createElement('div');
    renderBattery(el, m);
    expect(digitsOutsideClock(el.textContent ?? '')).toBe('');
    const b = await budgetOf(ctx.player);
    expect(b.coreOk).toBe(false);
    expect(b.ready).toBe(0);
    // raw eth_estimateGas (the exact call play.ts makes) must decode to the CoreUnavailable sentence too
    const { encodeFunctionData } = await import('viem');
    const data = encodeFunctionData({ abi: pixelPitAbi, functionName: 'paint', args: [[1], [1]] });
    const rawErr = await clients[0]!.pub.request({ method: 'eth_estimateGas', params: [{ from: ctx.player, to: CONFIG.PIT, data }] }).then(() => null, (e: unknown) => e);
    expect(rawErr).not.toBeNull();
    expect(describeError(rawErr).sentence).toBe(copy.ERR_SENTENCES.CoreUnavailable);
    await mock('clearModes');
    const again = await tick(ctx.player);
    expect(again.pit!.budget!.coreOk).toBe(true);
    expect(again.pit!.budget!.ready).toBeGreaterThan(0); // budget survived the outage untouched
  });

  it('after everything, frame(logs) == rawCells() still holds (day-4 exit check)', async () => {
    const t = await tick(ctx.player);
    const { replayed, onchain, integrity } = await replayFrame(t);
    expect(framesEqual(replayed, onchain)).toBe(true);
    expect(integrity.ok).toBe(true);
  });
});
