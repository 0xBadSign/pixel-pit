import { describe, it, expect } from 'vitest';
import { encodeEventTopics, encodeAbiParameters, type Abi, type AbiEvent, type Address, type Hex } from 'viem';
import { CONFIG, type Config } from '../src/config';
import { coreAbi, pixelPitAbi } from '../src/abi';
import { LogStore, planRanges, fetchChunk, ChunkFailure, cacheKey, type RawLog } from '../src/logs';
import { makeCustomClient, type RpcClient, type TickOk } from '../src/rpc';
import { encodeRawCells, genesisFrame, frame } from '../src/frame';

const PIT: Address = '0x1111111111111111111111111111111111111111';
const cfg: Config = { ...CONFIG, PIT, PIT_DEPLOY_BLOCK: 100n, LOG_CHUNK_BLOCKS: 10_000, GENESIS_CELLS: [0], GENESIS_COLORS: [13] };

function hexN(n: number | bigint): Hex {
  return `0x${BigInt(n).toString(16)}` as Hex;
}
/** topics via encodeEventTopics, data = ABI-encoded non-indexed inputs (by name). */
function encodeEventLog(o: { abi: Abi; eventName: string; args: Record<string, unknown> }): { data: Hex; topics: readonly Hex[] } {
  const ev = o.abi.find((x): x is AbiEvent => x.type === 'event' && x.name === o.eventName);
  if (!ev) throw new Error(`event ${o.eventName} not in abi`);
  const topics = encodeEventTopics({ abi: o.abi, eventName: o.eventName, args: o.args } as never) as readonly Hex[];
  const nonIndexed = ev.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(nonIndexed, nonIndexed.map((i) => o.args[i.name!]) as never);
  return { data, topics };
}
function hash(n: number | bigint): Hex {
  return `0x${BigInt(n).toString(16).padStart(64, '0')}` as Hex;
}

class MemStorage {
  m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

type LogsBehaviour = (range: { from: bigint; to: bigint }) => unknown; // return value or throw

function fakeClient(behaviour: LogsBehaviour): { client: RpcClient; calls: string[] } {
  const calls: string[] = [];
  const request = async ({ method, params }: { method: string; params?: unknown[] }): Promise<unknown> => {
    calls.push(method);
    if (method === 'eth_getLogs') {
      const f = (params as [{ fromBlock: Hex; toBlock: Hex }])[0];
      return behaviour({ from: BigInt(f.fromBlock), to: BigInt(f.toBlock) });
    }
    if (method === 'eth_getBlockByNumber') {
      const n = BigInt((params as [Hex])[0]);
      return { number: hexN(n), hash: hash(n), timestamp: '0x1', transactions: [], parentHash: hash(0), gasLimit: '0x1', gasUsed: '0x0', difficulty: '0x0', extraData: '0x', logsBloom: `0x${'00'.repeat(256)}`, miner: '0x0000000000000000000000000000000000000000', nonce: '0x0000000000000000', size: '0x1', uncles: [] };
    }
    throw new Error(`unsupported ${method}`);
  };
  return { client: makeCustomClient('fake', 0, request as never), calls };
}

function tick(head: number, finalized: number): TickOk {
  return {
    ok: true,
    at: 0,
    provider: 'fake',
    providerIndex: 0,
    head: BigInt(head),
    headHash: hash(head),
    headTimestamp: 1n,
    safe: BigInt(head - 12),
    finalized: BigInt(finalized),
    finalityTags: true,
    state: { settledThroughRound: 0n, cumulativeWork: 0n, cumulativeBlockUnits: 0n, blockHeight: 0n, blockProgress: 0n, workPerThousandBlocks: 0, authorizationNonce: 0n, paused: false },
    pit: null,
    wallet: null,
  };
}

const noBootstrap = (async () => ({ ok: false, status: 404, json: async () => ({}) })) as unknown as typeof fetch;

describe('log chunk planning', () => {
  it('splits into <= 10,000-block ranges', () => {
    const r = planRanges(100n, 25_000n, 10_000);
    expect(r).toEqual([
      { fromBlock: 100n, toBlock: 10_099n },
      { fromBlock: 10_100n, toBlock: 20_099n },
      { fromBlock: 20_100n, toBlock: 25_000n },
    ]);
    expect(planRanges(10n, 9n, 10_000)).toEqual([]);
  });
  it('sync never straddles finalized: canonical ranges end at finalized, the volatile tail starts after it', async () => {
    const store = new LogStore({ cfg, storage: new MemStorage(), fetchFn: noBootstrap, now: () => 0 });
    await store.loadInitial();
    const seen: [bigint, bigint][] = [];
    const client = fakeClient(({ from, to }) => {
      seen.push([from, to]);
      return [];
    });
    await store.sync(client.client, tick(25_000, 20_000));
    expect(seen).toEqual([
      [100n, 10_099n],
      [10_100n, 20_000n],
      [20_001n, 25_000n],
    ]);
    expect(store.canonicalThrough).toBe(20_000n);
    expect(store.volatileChunks.map((c) => [c.fromBlock, c.toBlock])).toEqual([[20_001n, 25_000n]]);
  });
});

describe('persistence + rebuild safety (SPEC §6.3 cache <= finalized)', () => {
  it('a tick on the head-12 / head-64 fallback (no node finality tags) is not persisted to localStorage', async () => {
    const storage = new MemStorage();
    const store = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 0 });
    await store.loadInitial();
    const r = await store.sync(fakeClient(() => []).client, { ...tick(160, 130), finalityTags: false });
    expect(r.snapshot.completeThrough).toBe(160n);
    expect(store.canonicalThrough).toBe(130n); // kept in memory
    expect(storage.getItem(cacheKey(cfg.chainId, PIT))).toBeNull(); // not on disk
  });

  it('a persisted canonical chunk whose toBlock hash is not on this provider\'s chain is dropped once per session', async () => {
    const storage = new MemStorage();
    const s1 = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 0 });
    await s1.loadInitial();
    await s1.sync(fakeClient(() => []).client, tick(160, 130));
    // tamper the stored hash: the next session must not trust it
    const raw = JSON.parse(storage.getItem(cacheKey(cfg.chainId, PIT))!) as { chunks: { toBlockHash: string }[] };
    raw.chunks[0]!.toBlockHash = hash(999_999);
    storage.setItem(cacheKey(cfg.chainId, PIT), JSON.stringify(raw));
    const s2 = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 0 });
    await s2.loadInitial();
    expect(s2.canonicalThrough).toBe(130n);
    const events: string[] = [];
    s2.on((ev) => events.push(ev.type));
    const refetch = fakeClient(() => []);
    const r = await s2.sync(refetch.client, tick(170, 140));
    expect(events).toContain('cache-rebuilt');
    expect(r.failed).toBe(0);
    expect(r.snapshot.completeThrough).toBe(170n);
    expect(refetch.calls.filter((m) => m === 'eth_getLogs').length).toBe(2); // 100..140 refetched + tail
  });

  it('rebuild keeps the old chunks and cache when the rebuild itself cannot load every chunk', async () => {
    const storage = new MemStorage();
    const store = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 0 });
    await store.loadInitial();
    await store.sync(fakeClient(() => []).client, tick(160, 130));
    const before = storage.getItem(cacheKey(cfg.chainId, PIT));
    const down = fakeClient(() => { throw new Error('timeout'); });
    const r = await store.rebuild(down.client, tick(160, 130));
    expect(r).toBeNull();
    expect(store.canonicalThrough).toBe(130n);
    expect(storage.getItem(cacheKey(cfg.chainId, PIT))).toBe(before);
    expect(store.snapshot().incomplete).toBe(false);
  });

  it('a successful rebuild swaps the chunks, rewrites the cache and emits cache-rebuilt', async () => {
    const storage = new MemStorage();
    const store = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 10 * 60_000 });
    await store.loadInitial();
    await store.sync(fakeClient(() => []).client, tick(160, 130));
    const events: string[] = [];
    store.on((ev) => events.push(ev.type));
    const r = await store.rebuild(fakeClient(() => []).client, tick(170, 140));
    expect(r).not.toBeNull();
    expect(events).toContain('cache-rebuilt');
    expect(store.canonicalThrough).toBe(140n);
    const cached = JSON.parse(storage.getItem(cacheKey(cfg.chainId, PIT))!) as { chunks: { fromBlock: string; toBlock: string }[] };
    expect(cached.chunks.map((c) => [c.fromBlock, c.toBlock])).toEqual([['100', '140']]);
  });

  it('a volatile log at the pinned head with another block hash fails the chunk (mid-tick reorg)', async () => {
    const range = { fromBlock: 150n, toBlock: 160n };
    const forked: RawLog = { address: PIT, topics: [], data: '0x', blockNumber: hexN(160), blockHash: hash(777), transactionHash: hash(1), logIndex: '0x0' };
    await expect(fetchChunk(fakeClient(() => [forked]).client, range, cfg, hash(160))).rejects.toBeInstanceOf(ChunkFailure);
    const ok = await fetchChunk(fakeClient(() => [{ ...forked, blockHash: hash(160) }]).client, range, cfg, hash(160));
    expect(ok.logs.length).toBe(1);
  });
});

describe('a failed log chunk is never an empty chunk (SPEC §6.3)', () => {
  it('fetchChunk rejects on null, error, "pruned" and non-array results', async () => {
    const range = { fromBlock: 100n, toBlock: 200n };
    await expect(fetchChunk(fakeClient(() => null).client, range, cfg)).rejects.toBeInstanceOf(ChunkFailure);
    await expect(fetchChunk(fakeClient(() => { throw new Error('block range too large'); }).client, range, cfg)).rejects.toBeInstanceOf(ChunkFailure);
    await expect(fetchChunk(fakeClient(() => { throw new Error('requested data is pruned'); }).client, range, cfg)).rejects.toBeInstanceOf(ChunkFailure);
    await expect(fetchChunk(fakeClient(() => ({})).client, range, cfg)).rejects.toBeInstanceOf(ChunkFailure);
    // a genuinely empty array from a healthy reply IS a valid (empty) chunk
    const ok = await fetchChunk(fakeClient(() => []).client, range, cfg);
    expect(ok.logs).toEqual([]);
    expect(ok.toBlockHash).toBe(hash(200));
  });

  it('sync: null result => INCOMPLETE with failed count, nothing persisted, completeThrough null', async () => {
    const storage = new MemStorage();
    const store = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 0 });
    await store.loadInitial();
    const bad = fakeClient(() => null);
    const r = await store.sync(bad.client, tick(150, 120));
    expect(r.failed).toBeGreaterThanOrEqual(1);
    expect(r.fetched).toBe(0);
    expect(r.snapshot.incomplete).toBe(true);
    expect(r.snapshot.failedChunks).toBe(r.failed);
    expect(r.snapshot.completeThrough).toBeNull();
    expect(store.canonicalChunks.length).toBe(0);
    expect(store.volatileChunks.length).toBe(0);
    expect(storage.getItem(cacheKey(cfg.chainId, PIT))).toBeNull();
    // integrity cannot run on an incomplete table
    expect(store.integrity({ ...tick(150, 120), pit: { rawCells: new Array(128).fill(0n), totalStrokes: 0n, playerCount: 0, crewScores: [0, 0, 0, 0], budget: null } }).checked).toBe(false);
  });

  it('sync: a later healthy tick fills the gap, persists only <= finalized, and clears INCOMPLETE', async () => {
    const storage = new MemStorage();
    const store = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 0 });
    await store.loadInitial();
    await store.sync(fakeClient(() => { throw new Error('timeout'); }).client, tick(150, 120));
    expect(store.snapshot().incomplete).toBe(true);

    const good = fakeClient(() => []);
    const r = await store.sync(good.client, tick(160, 130));
    expect(r.failed).toBe(0);
    expect(r.snapshot.incomplete).toBe(false);
    expect(r.snapshot.completeThrough).toBe(160n);
    expect(r.snapshot.canonicalThrough).toBe(130n);
    const cached = JSON.parse(storage.getItem(cacheKey(cfg.chainId, PIT))!) as { chunks: { fromBlock: string; toBlock: string }[] };
    expect(cached.chunks.map((c) => [c.fromBlock, c.toBlock])).toEqual([['100', '130']]);
    // volatile tail (131..160) lives only in memory
    expect(store.volatileChunks.map((c) => [c.fromBlock, c.toBlock])).toEqual([[131n, 160n]]);
  });

  it('sync: a failure in the volatile tail keeps canonical data but marks INCOMPLETE and drops the stale tail', async () => {
    const storage = new MemStorage();
    const store = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 0 });
    await store.loadInitial();
    await store.sync(fakeClient(() => []).client, tick(160, 130));
    const flaky = fakeClient(({ from }) => (from > 130n ? null : []));
    const r = await store.sync(flaky.client, tick(170, 130));
    expect(r.snapshot.incomplete).toBe(true);
    expect(r.snapshot.failedChunks).toBe(1);
    expect(r.snapshot.canonicalThrough).toBe(130n);
    expect(r.snapshot.completeThrough).toBe(130n);
    expect(store.volatileChunks.length).toBe(0);
  });

  it('loads a persisted cache back and ignores a cache for another pit/chain', async () => {
    const storage = new MemStorage();
    const s1 = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 0 });
    await s1.loadInitial();
    await s1.sync(fakeClient(() => []).client, tick(20_500, 20_200));
    const s2 = new LogStore({ cfg, storage, fetchFn: noBootstrap, now: () => 0 });
    await s2.loadInitial();
    expect(s2.canonicalThrough).toBe(20_200n);
    const s3 = new LogStore({ cfg: { ...cfg, PIT: '0x2222222222222222222222222222222222222222' }, storage, fetchFn: noBootstrap, now: () => 0 });
    await s3.loadInitial();
    expect(s3.canonicalThrough).toBeNull();
  });
});

describe('replay + integrity (a)-(d) at the pinned block', () => {
  const player: Address = '0x00000000000000000000000000000000000000aa';
  function raw(address: Address, blockNumber: number, logIndex: number, enc: { data: Hex; topics: readonly Hex[] }): RawLog {
    return { address, data: enc.data, topics: [...enc.topics], blockNumber: hexN(blockNumber), blockHash: hash(blockNumber), transactionHash: hash(9000 + blockNumber * 10 + logIndex), logIndex: hexN(logIndex) };
  }
  const joined = raw(PIT, 110, 0, encodeEventLog({ abi: pixelPitAbi, eventName: 'Joined', args: { player, playerId: 1, crew: 3, coreHeight: 8430n } }));
  const settled = raw(CONFIG.CORE, 120, 0, encodeEventLog({ abi: coreAbi, eventName: 'BatchSettled', args: { digest: hash(1), reporter: player, settledThroughRound: 1246n, nonce: 1n, previousSettledThroughRound: 1240n, activeRoundCount: 3, cumulativeWork: 0n, cumulativeBlockUnits: 8473n * 1_000_000_000n } }));
  const painted1 = raw(PIT, 125, 2, encodeEventLog({ abi: pixelPitAbi, eventName: 'Painted', args: { player, coreHeight: 8473n, playerId: 1, cells: [5, 6, 0], colors: [4, 4, 9], budgetLeft: 37 } }));
  const painted2 = raw(PIT, 125, 5, encodeEventLog({ abi: pixelPitAbi, eventName: 'Painted', args: { player, coreHeight: 8473n, playerId: 1, cells: [5], colors: [15], budgetLeft: 36 } }));
  const logs = [joined, settled, painted1, painted2];

  it('frame(B) == rawCells()@B passes; a tampered canvas fails (c) and a wrong height fails (d)', async () => {
    const store = new LogStore({ cfg, storage: new MemStorage(), fetchFn: noBootstrap, now: () => 0 });
    await store.loadInitial();
    const client = fakeClient(({ from, to }) => logs.filter((l) => BigInt(l.blockNumber) >= from && BigInt(l.blockNumber) <= to));
    const t = tick(150, 130);
    const { snapshot } = await store.sync(client.client, t);
    expect(snapshot.joined.length).toBe(1);
    expect(snapshot.painted.length).toBe(2);
    expect(snapshot.settled[0]?.height).toBe(8473n);
    expect(snapshot.crewByPlayerId.get(1)).toBe(3);

    const expected = frame(null, snapshot.painted, snapshot.crewByPlayerId, genesisFrame(cfg.GENESIS_CELLS, cfg.GENESIS_COLORS));
    const okTick: TickOk = { ...t, state: { ...t.state, blockHeight: 8473n }, pit: { rawCells: encodeRawCells(expected), totalStrokes: 4n, playerCount: 1, crewScores: [0, 0, 0, 3], budget: null } };
    const res = store.integrity(okTick, snapshot);
    expect(res.checked).toBe(true);
    expect(res).toMatchObject({ ok: true, a: true, b: true, c: true, d: true });

    const tampered = new Uint32Array(expected);
    tampered[5] = 0;
    const bad = store.integrity({ ...okTick, pit: { ...okTick.pit!, rawCells: encodeRawCells(tampered) } }, snapshot);
    expect(bad.ok).toBe(false);
    expect(bad.c).toBe(false);

    const wrongStrokes = store.integrity({ ...okTick, pit: { ...okTick.pit!, totalStrokes: 5n } }, snapshot);
    expect(wrongStrokes.a).toBe(false);

    const wrongHeight = store.integrity({ ...okTick, pit: { ...okTick.pit!, budget: { joined: true, coreOk: true, coreHeight: 8500n, ready: 0, banked: 0, fresh: 0, arrived: 0n, forfeited: 0n } } }, snapshot);
    expect(wrongHeight.d).toBe(false);
  });

  it('records are keyed by (chainId, blockHash, txHash, logIndex): duplicates across chunks collapse', async () => {
    const store = new LogStore({ cfg, storage: new MemStorage(), fetchFn: noBootstrap, now: () => 0 });
    await store.loadInitial();
    // the same Painted log appears in both the canonical and the volatile chunk
    const dup = fakeClient(() => [painted1]);
    const { snapshot } = await store.sync(dup.client, tick(150, 125));
    expect(snapshot.painted.length).toBe(1);
  });
});
