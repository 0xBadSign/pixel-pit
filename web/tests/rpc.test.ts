import { describe, it, expect } from 'vitest';
import { decodeFunctionData, encodeFunctionResult, type Hex, type Address } from 'viem';
import { CONFIG, type Config } from '../src/config';
import { coreAbi, pixelPitAbi } from '../src/abi';
import { runTick, makeCustomClient, createTicker, isTagUnsupported, type RpcClient } from '../src/rpc';

const PIT: Address = '0x1111111111111111111111111111111111111111';
const CORE: Address = CONFIG.CORE;
const NOW_S = 1_762_292_520;
const cfg: Config = { ...CONFIG, PIT, PIT_DEPLOY_BLOCK: 100n, FINALITY_TAGS: true };

type FakeOpts = {
  head: number;
  headTs?: number;
  failOn?: (method: string, params: unknown[]) => boolean;
  supportTags?: boolean;
  blockHeight?: bigint;
};

function hexN(n: number | bigint): Hex {
  return `0x${BigInt(n).toString(16)}` as Hex;
}

function fakeProvider(url: string, index: number, o: FakeOpts): { client: RpcClient; calls: { method: string; params: unknown[] }[] } {
  const calls: { method: string; params: unknown[] }[] = [];
  const headTs = o.headTs ?? NOW_S - 10;
  const supportTags = o.supportTags ?? true;
  const block = (n: number, ts: number) => ({
    number: hexN(n),
    hash: `0x${(n + index * 1000).toString(16).padStart(64, '0')}` as Hex,
    parentHash: `0x${'00'.repeat(32)}`,
    timestamp: hexN(ts),
    transactions: [],
    gasLimit: '0x1',
    gasUsed: '0x0',
    baseFeePerGas: '0x1',
    difficulty: '0x0',
    extraData: '0x',
    logsBloom: `0x${'00'.repeat(256)}`,
    miner: '0x0000000000000000000000000000000000000000',
    mixHash: `0x${'00'.repeat(32)}`,
    nonce: '0x0000000000000000',
    receiptsRoot: `0x${'00'.repeat(32)}`,
    sha3Uncles: `0x${'00'.repeat(32)}`,
    size: '0x1',
    stateRoot: `0x${'00'.repeat(32)}`,
    totalDifficulty: '0x0',
    transactionsRoot: `0x${'00'.repeat(32)}`,
    uncles: [],
  });
  const request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    const p = params ?? [];
    calls.push({ method, params: p });
    if (o.failOn && o.failOn(method, p)) throw new Error(`fake failure on ${method}`);
    if (method === 'eth_chainId') return hexN(11155111);
    if (method === 'eth_getBlockByNumber') {
      const tag = p[0] as string;
      if (tag === 'latest') return block(o.head, headTs);
      if (tag === 'safe') {
        if (!supportTags) throw new Error('invalid block tag');
        return block(o.head - 12, headTs - 144);
      }
      if (tag === 'finalized') {
        if (!supportTags) throw new Error('invalid block tag');
        return block(o.head - 64, headTs - 768);
      }
      return block(Number(BigInt(tag)), headTs);
    }
    if (method === 'eth_call') {
      const call = p[0] as { to: Address; data: Hex };
      const to = call.to.toLowerCase();
      if (to === CORE.toLowerCase()) {
        const d = decodeFunctionData({ abi: coreAbi, data: call.data });
        if (d.functionName === 'state') {
          const h = o.blockHeight ?? 8473n;
          return encodeFunctionResult({
            abi: coreAbi,
            functionName: 'state',
            result: { settledThroughRound: 1246n, cumulativeWork: 0n, cumulativeBlockUnits: h * 1_000_000_000n, blockHeight: h, blockProgress: 0n, workPerThousandBlocks: 0, authorizationNonce: 0n, paused: false },
          });
        }
      }
      if (to === PIT.toLowerCase()) {
        const d = decodeFunctionData({ abi: pixelPitAbi, data: call.data });
        switch (d.functionName) {
          case 'rawCells':
            return encodeFunctionResult({ abi: pixelPitAbi, functionName: 'rawCells', result: new Array(128).fill(0n) as never });
          case 'totalStrokes':
            return encodeFunctionResult({ abi: pixelPitAbi, functionName: 'totalStrokes', result: 0n });
          case 'playerCount':
            return encodeFunctionResult({ abi: pixelPitAbi, functionName: 'playerCount', result: 0 });
          case 'crewScores':
            return encodeFunctionResult({ abi: pixelPitAbi, functionName: 'crewScores', result: [0, 0, 0, 0] });
          case 'budgetOf':
            return encodeFunctionResult({ abi: pixelPitAbi, functionName: 'budgetOf', result: [true, true, 8473n, 27, 10, 17, 57n, 30n] });
        }
      }
      throw new Error(`unexpected eth_call to ${to}`);
    }
    throw new Error(`unsupported method ${method}`);
  };
  return { client: makeCustomClient(url, index, request as never), calls };
}

const now = () => NOW_S * 1000;

describe('single-provider-per-tick rule (SPEC §6.3)', () => {
  it('a healthy primary serves the whole tick; the fallback is never touched', async () => {
    const a = fakeProvider('tenderly', 0, { head: 12_061_055 });
    const b = fakeProvider('publicnode', 1, { head: 12_061_056 });
    const r = await runTick([a.client, b.client], { cfg, now, wallet: '0x0000000000000000000000000000000000000001' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.providerIndex).toBe(0);
    expect(r.head).toBe(12_061_055n);
    expect(r.safe).toBe(12_061_043n);
    expect(r.finalized).toBe(12_060_991n);
    expect(r.finalityTags).toBe(true);
    expect(r.pit?.budget?.ready).toBe(27);
    expect(b.calls.length).toBe(0);
    // every pinned read used block B = head, pinned by HASH (EIP-1898)
    const pinned = a.calls.filter((c) => c.method === 'eth_call').map((c) => JSON.stringify(c.params[1]));
    expect(pinned.length).toBeGreaterThanOrEqual(6);
    expect(new Set(pinned)).toEqual(new Set([JSON.stringify({ blockHash: r.headHash })]));
  });

  it('a mid-tick failure on the primary moves the WHOLE tick to the fallback (no mixing)', async () => {
    const a = fakeProvider('tenderly', 0, {
      head: 12_061_055,
      failOn: (m, p) => m === 'eth_call' && (p[0] as { to: string }).to.toLowerCase() === PIT.toLowerCase(),
    });
    const b = fakeProvider('publicnode', 1, { head: 12_061_060 });
    const r = await runTick([a.client, b.client], { cfg, now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.providerIndex).toBe(1);
    expect(r.provider).toBe('publicnode');
    // nothing from provider A survives: head, hash, safe, finalized all come from B
    expect(r.head).toBe(12_061_060n);
    expect(r.headHash).toBe(`0x${(12_061_060 + 1000).toString(16).padStart(64, '0')}`);
    expect(r.safe).toBe(12_061_048n);
    expect(r.finalized).toBe(12_060_996n);
    // B performed the full read set itself (head, safe, finalized, state + 4 pit reads)
    expect(b.calls.filter((c) => c.method === 'eth_getBlockByNumber').length).toBe(3);
    expect(b.calls.filter((c) => c.method === 'eth_call').length).toBe(5);
    const pinned = b.calls.filter((c) => c.method === 'eth_call').map((c) => JSON.stringify(c.params[1]));
    expect(new Set(pinned)).toEqual(new Set([JSON.stringify({ blockHash: r.headHash })]));
  });

  it('a stale head (> 120 s old) is a provider failure: fallback is used, and both stale => UNKNOWN(stale)', async () => {
    const a = fakeProvider('tenderly', 0, { head: 100, headTs: NOW_S - 400 });
    const b = fakeProvider('publicnode', 1, { head: 130 });
    const r = await runTick([a.client, b.client], { cfg, now });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.providerIndex).toBe(1);

    const c = fakeProvider('publicnode', 1, { head: 130, headTs: NOW_S - 121 });
    const r2 = await runTick([a.client, c.client], { cfg, now });
    expect(r2.ok).toBe(false);
    if (!r2.ok) {
      expect(r2.reason).toBe('stale');
      expect(r2.head).toBe(130n);
    }
  });

  it('both providers down => UNKNOWN(unreachable), never a partial result', async () => {
    const a = fakeProvider('tenderly', 0, { head: 100, failOn: (m) => m === 'eth_call' });
    const b = fakeProvider('publicnode', 1, { head: 100, failOn: (m) => m === 'eth_getBlockByNumber' });
    const r = await runTick([a.client, b.client], { cfg, now });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('unreachable');
  });

  it('falls back to head-12 / head-64 when safe/finalized tags are unsupported', async () => {
    const a = fakeProvider('tenderly', 0, { head: 5000, supportTags: false });
    const r = await runTick([a.client], { cfg, now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.finalityTags).toBe(false);
    expect(r.safe).toBe(4988n);
    expect(r.finalized).toBe(4936n);
  });

  it('a timeout / 5xx / rate limit on the safe or finalized request is a provider failure, not a tag fallback', async () => {
    for (const msg of ['The request took too long to respond. timeout', 'HTTP request failed. Status: 503', 'Rate limit exceeded (429)']) {
      const a = fakeProvider('tenderly', 0, { head: 5000, failOn: (m, p) => m === 'eth_getBlockByNumber' && p[0] === 'finalized' ? ((): boolean => { throw new Error(msg); })() : false });
      const b = fakeProvider('publicnode', 1, { head: 5002 });
      const r = await runTick([a.client, b.client], { cfg, now });
      expect(r.ok, msg).toBe(true);
      if (!r.ok) continue;
      expect(r.providerIndex).toBe(1); // whole tick moved to the fallback
      expect(r.finalityTags).toBe(true); // real tags from the fallback, never head-12 on the failing primary
      expect(r.finalized).toBe(5002n - 64n);
    }
    // and with no fallback the tick is UNKNOWN, not a silently mislabelled head-64
    const only = fakeProvider('tenderly', 0, { head: 5000, failOn: (m, p) => m === 'eth_getBlockByNumber' && p[0] === 'safe' ? ((): boolean => { throw new Error('timeout'); })() : false });
    const r2 = await runTick([only.client], { cfg, now });
    expect(r2.ok).toBe(false);
  });

  it('isTagUnsupported: JSON-RPC -32602/-32601 and "invalid block tag"/"unknown block" messages only', () => {
    expect(isTagUnsupported({ code: -32602, message: 'invalid argument 0: hex string without 0x prefix' })).toBe(true);
    expect(isTagUnsupported({ code: -32601, message: 'method not found' })).toBe(true);
    expect(isTagUnsupported(new Error('invalid block tag safe'))).toBe(true);
    expect(isTagUnsupported(new Error('Unknown block'))).toBe(true);
    expect(isTagUnsupported(new Error('block safe not found'))).toBe(true);
    expect(isTagUnsupported({ message: 'HTTP request failed. Status: 503', cause: { message: 'service unavailable' } })).toBe(false);
    expect(isTagUnsupported(new Error('The request took too long to respond.'))).toBe(false);
    expect(isTagUnsupported({ code: 429, message: 'rate limited' })).toBe(false);
  });
});

describe('ticker: a kick during an in-flight tick re-runs once it finishes', () => {
  it('runs again immediately instead of dropping the kick', async () => {
    let resolveFirst: (() => void) | null = null;
    let runs = 0;
    const ticker = createTicker({
      run: () =>
        new Promise<void>((res) => {
          runs++;
          if (runs === 1) resolveFirst = res;
          else res();
        }),
      intervalMs: 60_000,
      hiddenMs: 60_000,
      doc: null,
    });
    ticker.start();
    await Promise.resolve();
    expect(runs).toBe(1);
    ticker.kick(); // arrives while the first run is in flight
    ticker.kick();
    await Promise.resolve();
    expect(runs).toBe(1);
    resolveFirst!();
    await new Promise((r) => setTimeout(r, 5));
    expect(runs).toBe(2); // exactly one re-run, not one per kick
    ticker.stop();
  });
});
