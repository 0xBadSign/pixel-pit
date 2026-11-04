// Log replay (SPEC §6.3): bootstrap file + localStorage cache (<= finalized only) + tail getLogs in
// <= 10,000-block chunks, all from the tick's provider. A chunk that returns null, errors, times out or
// says "pruned"/"range too large" is a FAILURE and is never recorded as an empty chunk; while any chunk
// is missing the snapshot is INCOMPLETE with the failed-chunk count.
import { decodeEventLog, type Address, type Hex } from 'viem';
import { getBlockHeader } from './eth';
import { CONFIG, type Config } from './config';
import { coreAbi, pixelPitAbi, TOPIC0, BLOCK_UNITS_PER_BLOCK } from './abi';
import { frame, framesEqual, genesisFrame, decodeRawCells, type PaintedEvent } from './frame';
import type { RpcClient, TickOk } from './rpc';

// ---------- types ----------

export type RawLog = {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: Hex;
  blockHash: Hex;
  transactionHash: Hex;
  logIndex: Hex;
};

export type JoinedEvent = {
  kind: 'Joined';
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  blockHash: Hex;
  player: Address;
  playerId: number;
  crew: number;
  coreHeight: bigint;
};

export type PaintedLog = PaintedEvent & { kind: 'Painted' };

export type BatchSettledEvent = {
  kind: 'BatchSettled';
  blockNumber: bigint;
  logIndex: number;
  txHash: Hex;
  blockHash: Hex;
  digest: Hex;
  reporter: Address;
  settledThroughRound: bigint;
  nonce: bigint;
  previousSettledThroughRound: bigint;
  activeRoundCount: number;
  cumulativeWork: bigint;
  cumulativeBlockUnits: bigint;
  height: bigint; // cumulativeBlockUnits / 1e9
};

export type LogRecord = JoinedEvent | PaintedLog | BatchSettledEvent;

export type Chunk = {
  fromBlock: bigint;
  toBlock: bigint;
  toBlockHash: Hex;
  logs: RawLog[];
};

export type SerializedChunk = { fromBlock: string; toBlock: string; toBlockHash: Hex; logs: RawLog[] };

export type BootstrapFile = {
  version: number;
  chainId: number;
  pit: Address;
  core: Address;
  fromBlock: string | null;
  bootstrapBlock: string | null;
  chunks: SerializedChunk[];
};

export type CacheFile = { version: number; chainId: number; pit: Address; chunks: SerializedChunk[] };

export type LogsSnapshot = {
  joined: JoinedEvent[];
  painted: PaintedLog[];
  settled: BatchSettledEvent[];
  crewByPlayerId: Map<number, number>;
  /** last block (inclusive) for which every chunk loaded; null when nothing loaded */
  completeThrough: bigint | null;
  canonicalThrough: bigint | null; // <= finalized, persisted
  incomplete: boolean;
  failedChunks: number;
  /** set by the caller when the integrity check (a)-(c) at the pinned block failed and no clean rebuild exists yet */
  integrityFailed?: boolean;
  provider: string | null;
  at: number;
};

export const CACHE_VERSION = 1;

export function cacheKey(chainId: number, pit: string): string {
  return `pit:${chainId}:${pit.toLowerCase()}:logs`;
}

export function recordKey(chainId: number, l: { blockHash: Hex; txHash: Hex; logIndex: number }): string {
  return `${chainId}:${l.blockHash.toLowerCase()}:${l.txHash.toLowerCase()}:${l.logIndex}`;
}

// ---------- decoding ----------

export function decodeRawLog(raw: RawLog, cfg: Config = CONFIG): LogRecord | null {
  const t0 = raw.topics[0]?.toLowerCase();
  if (!t0) return null;
  const addr = raw.address.toLowerCase();
  const base = {
    blockNumber: BigInt(raw.blockNumber),
    logIndex: Number(BigInt(raw.logIndex)),
    txHash: raw.transactionHash,
    blockHash: raw.blockHash,
  };
  try {
    if (t0 === TOPIC0.Joined.toLowerCase() && addr === cfg.PIT.toLowerCase()) {
      const d = decodeEventLog({ abi: pixelPitAbi, eventName: 'Joined', data: raw.data, topics: raw.topics as [Hex, ...Hex[]] });
      return { kind: 'Joined', ...base, player: d.args.player, playerId: d.args.playerId, crew: d.args.crew, coreHeight: d.args.coreHeight };
    }
    if (t0 === TOPIC0.Painted.toLowerCase() && addr === cfg.PIT.toLowerCase()) {
      const d = decodeEventLog({ abi: pixelPitAbi, eventName: 'Painted', data: raw.data, topics: raw.topics as [Hex, ...Hex[]] });
      return {
        kind: 'Painted',
        ...base,
        player: d.args.player,
        coreHeight: d.args.coreHeight,
        playerId: d.args.playerId,
        cells: [...d.args.cells],
        colors: [...d.args.colors],
        budgetLeft: d.args.budgetLeft,
      };
    }
    if (t0 === TOPIC0.BatchSettled.toLowerCase() && addr === cfg.CORE.toLowerCase()) {
      const d = decodeEventLog({ abi: coreAbi, eventName: 'BatchSettled', data: raw.data, topics: raw.topics as [Hex, ...Hex[]] });
      return {
        kind: 'BatchSettled',
        ...base,
        digest: d.args.digest,
        reporter: d.args.reporter,
        settledThroughRound: d.args.settledThroughRound,
        nonce: d.args.nonce,
        previousSettledThroughRound: d.args.previousSettledThroughRound,
        activeRoundCount: d.args.activeRoundCount,
        cumulativeWork: d.args.cumulativeWork,
        cumulativeBlockUnits: d.args.cumulativeBlockUnits,
        height: d.args.cumulativeBlockUnits / BLOCK_UNITS_PER_BLOCK,
      };
    }
  } catch {
    return null; // malformed log from a mismatching contract: ignore, never fabricate
  }
  return null;
}

// ---------- chunk planning ----------

export type Range = { fromBlock: bigint; toBlock: bigint };

/** Split [from, to] into ranges of at most `size` blocks. Callers split canonical (<= finalized) and volatile tails themselves. */
export function planRanges(from: bigint, to: bigint, size: number): Range[] {
  const out: Range[] = [];
  if (to < from) return out;
  const step = BigInt(Math.max(1, size));
  let cursor = from;
  while (cursor <= to) {
    let end = cursor + step - 1n;
    if (end > to) end = to;
    out.push({ fromBlock: cursor, toBlock: end });
    cursor = end + 1n;
  }
  return out;
}

/** The first BatchSettled that brought height H (later ones at the same height moved nothing). Shared by main/play/overlay. */
export function settlementFor(settled: readonly BatchSettledEvent[], H: bigint): { log: BatchSettledEvent; index: number } | null {
  const index = settled.findIndex((x) => x.height === H);
  return index >= 0 ? { log: settled[index]!, index } : null;
}

// ---------- fetching ----------

export class ChunkFailure extends Error {
  constructor(
    public range: Range,
    message: string,
  ) {
    super(message);
    this.name = 'ChunkFailure';
  }
}

function toHexBlock(n: bigint): Hex {
  return `0x${n.toString(16)}` as Hex;
}

/**
 * Fetch one chunk from `client`. Resolves only with a real result (array, possibly empty, from a 2xx RPC
 * reply plus the toBlock hash from the same provider). Any null / error / timeout / "pruned" / "range too
 * large" rejects with ChunkFailure. The caller MUST have head >= toBlock on this provider.
 */
export async function fetchChunk(
  client: RpcClient,
  range: Range,
  cfg: Config = CONFIG,
  knownToBlockHash?: Hex,
): Promise<Chunk> {
  const filter = {
    address: [cfg.PIT, cfg.CORE],
    topics: [[TOPIC0.Joined, TOPIC0.Painted, TOPIC0.BatchSettled]],
    fromBlock: toHexBlock(range.fromBlock),
    toBlock: toHexBlock(range.toBlock),
  };
  let result: unknown;
  try {
    result = await client.pub.request({ method: 'eth_getLogs', params: [filter] } as never);
  } catch (e) {
    throw new ChunkFailure(range, `eth_getLogs failed: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
  }
  if (result === null || result === undefined) throw new ChunkFailure(range, 'eth_getLogs returned null');
  if (!Array.isArray(result)) throw new ChunkFailure(range, 'eth_getLogs returned a non-array');
  for (const l of result as unknown[]) {
    if (!isRawLog(l)) throw new ChunkFailure(range, 'eth_getLogs returned a malformed log');
    const bn = BigInt((l as RawLog).blockNumber);
    if (bn < range.fromBlock || bn > range.toBlock) throw new ChunkFailure(range, 'log outside requested range');
    // the tick pinned toBlock by hash: a log at that height from another fork means the node reorged mid-tick
    if (knownToBlockHash && bn === range.toBlock && (l as RawLog).blockHash.toLowerCase() !== knownToBlockHash.toLowerCase()) {
      throw new ChunkFailure(range, `log at block ${bn} has hash ${(l as RawLog).blockHash}, tick pinned ${knownToBlockHash}`);
    }
  }
  let toBlockHash = knownToBlockHash;
  if (!toBlockHash) {
    try {
      const b = await getBlockHeader(client.pub, range.toBlock);
      if (!b || !b.hash) throw new Error('no hash');
      toBlockHash = b.hash;
    } catch (e) {
      throw new ChunkFailure(range, `toBlock hash unavailable: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}`);
    }
  }
  const logs = (result as RawLog[]).map(normalizeRawLog);
  return { fromBlock: range.fromBlock, toBlock: range.toBlock, toBlockHash, logs };
}

function isRawLog(l: unknown): l is RawLog {
  if (!l || typeof l !== 'object') return false;
  const o = l as Record<string, unknown>;
  return (
    typeof o.address === 'string' &&
    Array.isArray(o.topics) &&
    typeof o.data === 'string' &&
    typeof o.blockNumber === 'string' &&
    typeof o.blockHash === 'string' &&
    typeof o.transactionHash === 'string' &&
    (typeof o.logIndex === 'string' || typeof o.logIndex === 'number')
  );
}

function normalizeRawLog(l: RawLog): RawLog {
  return {
    address: l.address,
    topics: l.topics,
    data: l.data,
    blockNumber: l.blockNumber,
    blockHash: l.blockHash,
    transactionHash: l.transactionHash,
    logIndex: typeof l.logIndex === 'number' ? (`0x${(l.logIndex as number).toString(16)}` as Hex) : l.logIndex,
  };
}

// ---------- store ----------

export type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export type LogStoreOptions = {
  cfg?: Config;
  storage?: StorageLike | null; // default: window.localStorage when available
  fetchFn?: typeof fetch; // default: globalThis.fetch
  now?: () => number;
};

export type SyncResult = {
  snapshot: LogsSnapshot;
  fetched: number;
  failed: number;
};

export type IntegrityResult = {
  checked: boolean; // false when logs are INCOMPLETE through B or PIT reads are missing
  ok: boolean;
  a: boolean | null; // strokes
  b: boolean | null; // players
  c: boolean | null; // frame == rawCells
  d: boolean | null; // budgetOf.coreHeight == last BatchSettled height (null = no settlement or no wallet)
  detail: string[];
};

export class LogStore {
  readonly cfg: Config;
  private storage: StorageLike | null;
  private fetchFn: typeof fetch | null;
  private now: () => number;

  /** canonical chunks: toBlock <= finalized, contiguous from PIT_DEPLOY_BLOCK, persisted */
  private canonical: Chunk[] = [];
  /** volatile chunks: finalized < block <= head, replaced every tick */
  private volatile: Chunk[] = [];
  private failedChunks = 0;
  private lastProvider: string | null = null;
  private bootstrapLoaded = false;
  private lastRebuildAt = 0;
  private deferSave = false; // during rebuild: never persist a partially rebuilt canonical list
  private boundaryVerified = false; // canonicalThrough's hash checked against the provider once per session
  private listeners = new Set<(ev: LogStoreEvent) => void>();

  constructor(o: LogStoreOptions = {}) {
    this.cfg = o.cfg ?? CONFIG;
    this.storage = o.storage === undefined ? safeLocalStorage() : o.storage;
    this.fetchFn = o.fetchFn ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    this.now = o.now ?? Date.now;
  }

  on(l: (ev: LogStoreEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(ev: LogStoreEvent): void {
    for (const l of this.listeners) {
      try {
        l(ev);
      } catch (e) {
        console.error('[logs] listener failed', e);
      }
    }
  }

  get canonicalThrough(): bigint | null {
    const last = this.canonical[this.canonical.length - 1];
    return last ? last.toBlock : null;
  }

  get volatileChunks(): readonly Chunk[] {
    return this.volatile;
  }

  get canonicalChunks(): readonly Chunk[] {
    return this.canonical;
  }

  /** Load bootstrap file then cache; cache wins for ranges past the bootstrap block. Safe to call once. */
  async loadInitial(): Promise<void> {
    if (this.bootstrapLoaded) return;
    this.bootstrapLoaded = true;
    const boot = await this.loadBootstrap();
    if (boot) this.mergeCanonical(boot);
    const cached = this.loadCache();
    if (cached) this.mergeCanonical(cached);
  }

  async loadBootstrap(): Promise<Chunk[] | null> {
    if (!this.fetchFn) return null;
    try {
      const res = await this.fetchFn(this.cfg.LOGS_BOOTSTRAP, { cache: 'no-cache' });
      if (!res.ok) return null;
      const json = (await res.json()) as Partial<BootstrapFile>;
      if (!json || json.chainId !== this.cfg.chainId) return null;
      if (!json.pit || json.pit.toLowerCase() !== this.cfg.PIT.toLowerCase()) return null;
      if (!Array.isArray(json.chunks)) return null;
      return json.chunks.map(deserializeChunk);
    } catch {
      return null;
    }
  }

  loadCache(): Chunk[] | null {
    if (!this.storage) return null;
    try {
      const raw = this.storage.getItem(cacheKey(this.cfg.chainId, this.cfg.PIT));
      if (!raw) return null;
      const json = JSON.parse(raw) as Partial<CacheFile>;
      if (json.version !== CACHE_VERSION || json.chainId !== this.cfg.chainId) return null;
      if (!json.pit || json.pit.toLowerCase() !== this.cfg.PIT.toLowerCase()) return null;
      if (!Array.isArray(json.chunks)) return null;
      return json.chunks.map(deserializeChunk);
    } catch {
      return null;
    }
  }

  saveCache(): void {
    if (!this.storage || this.deferSave) return;
    try {
      const file: CacheFile = {
        version: CACHE_VERSION,
        chainId: this.cfg.chainId,
        pit: this.cfg.PIT,
        chunks: this.canonical.map(serializeChunk),
      };
      this.storage.setItem(cacheKey(this.cfg.chainId, this.cfg.PIT), JSON.stringify(file));
    } catch {
      // quota / private mode / disabled storage: run from bootstrap + tail
    }
  }

  clearCache(): void {
    try {
      this.storage?.removeItem(cacheKey(this.cfg.chainId, this.cfg.PIT));
    } catch {
      /* ignore */
    }
  }

  /** Merge chunks into the canonical list keeping it contiguous from PIT_DEPLOY_BLOCK. */
  private mergeCanonical(chunks: Chunk[]): void {
    const all = [...this.canonical, ...chunks].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0));
    const out: Chunk[] = [];
    let expect = this.cfg.PIT_DEPLOY_BLOCK;
    for (const c of all) {
      if (c.toBlock < expect) continue; // already covered
      if (c.fromBlock > expect) break; // gap: stop, the tail fetch will fill it
      if (c.fromBlock < expect) {
        // overlapping: trim logs below `expect`
        const trimmed: Chunk = { ...c, fromBlock: expect, logs: c.logs.filter((l) => BigInt(l.blockNumber) >= expect) };
        out.push(trimmed);
      } else {
        out.push(c);
      }
      expect = c.toBlock + 1n;
    }
    this.canonical = out;
  }

  /**
   * One tick's log work, on the tick's provider: fetch canonical gaps up to `finalized` (persisted) and
   * the volatile tail (finalized, head] (memory only, refetched every tick). Never throws.
   */
  async sync(client: RpcClient, tick: TickOk): Promise<SyncResult> {
    const cfg = this.cfg;
    this.lastProvider = client.url;
    let fetched = 0;
    let failed = 0;

    // Reorg guard for canonical chunks: finalized can only move forward on a healthy chain, but a provider
    // switch may report a slightly lower finalized; nothing to do, canonical stays <= old finalized.
    // Once per session the stored toBlock hash of the last canonical chunk (bootstrap file / localStorage) is
    // compared with this provider's block at that number; a mismatch means the persisted data is not on this
    // chain (reorg past a head-64 fallback, or a cache from another fork): drop it and refetch from the start.
    if (!this.boundaryVerified && this.canonical.length > 0) {
      const last = this.canonical[this.canonical.length - 1]!;
      if (last.toBlock <= tick.head) {
        try {
          const b = await getBlockHeader(client.pub, last.toBlock);
          if (b.hash.toLowerCase() !== last.toBlockHash.toLowerCase()) {
            this.canonical = [];
            this.clearCache();
            this.emit({ type: 'cache-rebuilt', fromBlock: cfg.PIT_DEPLOY_BLOCK });
          }
          this.boundaryVerified = true;
        } catch {
          /* provider hiccup: verify on a later tick */
        }
      }
    }
    const canonicalStart = this.canonicalThrough === null ? cfg.PIT_DEPLOY_BLOCK : this.canonicalThrough + 1n;

    // 1) canonical gap: canonicalStart .. finalized
    if (tick.finalized >= canonicalStart) {
      const ranges = planRanges(canonicalStart, tick.finalized, cfg.LOG_CHUNK_BLOCKS);
      let stop = false;
      for (const r of ranges) {
        if (stop) {
          failed++;
          continue;
        }
        try {
          const chunk = await fetchChunk(client, r, cfg);
          this.mergeCanonical([chunk]);
          fetched++;
        } catch (e) {
          failed++;
          stop = true; // keep contiguity; later ranges count as failed for this tick
          this.emit({ type: 'chunk-failed', range: r, error: e instanceof Error ? e.message : String(e) });
        }
      }
      // persist only when `finalized` came from a real node tag: the head-64 fallback is not reorg-proof
      if (fetched > 0 && (tick.finalityTags || cfg.DEV)) this.saveCache();
    }

    // 2) volatile tail: max(canonicalThrough+1, finalized+1) .. head
    const volatileStart = (this.canonicalThrough === null ? cfg.PIT_DEPLOY_BLOCK : this.canonicalThrough + 1n);
    const tailFrom = volatileStart > tick.finalized + 1n ? volatileStart : tick.finalized + 1n;
    const newVolatile: Chunk[] = [];
    if (tick.head >= tailFrom && (this.canonicalThrough !== null || tailFrom === cfg.PIT_DEPLOY_BLOCK)) {
      const ranges = planRanges(tailFrom, tick.head, cfg.LOG_CHUNK_BLOCKS);
      let stop = false;
      for (const r of ranges) {
        if (stop) {
          failed++;
          continue;
        }
        try {
          const known = r.toBlock === tick.head ? tick.headHash : undefined;
          const chunk = await fetchChunk(client, r, cfg, known);
          newVolatile.push(chunk);
          fetched++;
        } catch (e) {
          failed++;
          stop = true;
          this.emit({ type: 'chunk-failed', range: r, error: e instanceof Error ? e.message : String(e) });
        }
      }
    } else if (tick.head >= tailFrom) {
      // canonical gap still open: the tail cannot be trusted as contiguous; count its chunks as failed.
      failed += planRanges(tailFrom, tick.head, cfg.LOG_CHUNK_BLOCKS).length;
    }
    // Volatile is replaced wholesale: a chunk missing this tick must not survive from a previous tick
    // at a different head, otherwise the range (finalized, head] could be stale.
    this.volatile = newVolatile;
    this.failedChunks = failed;

    const snapshot = this.snapshot(tick.head);
    this.emit({ type: 'synced', snapshot });
    return { snapshot, fetched, failed };
  }

  /** Decoded, de-duplicated view of everything loaded, limited to blocks <= `upTo` when given. */
  snapshot(upTo: bigint | null = null): LogsSnapshot {
    const cfg = this.cfg;
    const seen = new Set<string>();
    const joined: JoinedEvent[] = [];
    const painted: PaintedLog[] = [];
    const settled: BatchSettledEvent[] = [];
    const push = (rec: LogRecord) => {
      if (upTo !== null && rec.blockNumber > upTo) return;
      const k = recordKey(cfg.chainId, rec);
      if (seen.has(k)) return;
      seen.add(k);
      if (rec.kind === 'Joined') joined.push(rec);
      else if (rec.kind === 'Painted') painted.push(rec);
      else settled.push(rec);
    };
    for (const c of this.canonical) for (const l of c.logs) {
      const r = decodeRawLog(l, cfg);
      if (r) push(r);
    }
    for (const c of this.volatile) for (const l of c.logs) {
      const r = decodeRawLog(l, cfg);
      if (r) push(r);
    }
    const byBlock = (a: { blockNumber: bigint; logIndex: number }, b: { blockNumber: bigint; logIndex: number }) =>
      a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex;
    joined.sort(byBlock);
    painted.sort(byBlock);
    settled.sort(byBlock);
    const crewByPlayerId = new Map<number, number>();
    for (const j of joined) crewByPlayerId.set(j.playerId, j.crew);

    // completeThrough: contiguous coverage from PIT_DEPLOY_BLOCK through canonical + volatile
    let completeThrough: bigint | null = this.canonicalThrough;
    const vol = [...this.volatile].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : 1));
    let expect = completeThrough === null ? cfg.PIT_DEPLOY_BLOCK : completeThrough + 1n;
    for (const c of vol) {
      if (c.fromBlock !== expect) break;
      completeThrough = c.toBlock;
      expect = c.toBlock + 1n;
    }
    return {
      joined,
      painted,
      settled,
      crewByPlayerId,
      completeThrough,
      canonicalThrough: this.canonicalThrough,
      incomplete: this.failedChunks > 0,
      failedChunks: this.failedChunks,
      provider: this.lastProvider,
      at: this.now(),
    };
  }

  /**
   * Integrity check (a)-(d) at the pinned block B, SPEC §6.3. Only meaningful when logs are complete
   * through B and the Pit reads exist; otherwise `checked=false`.
   */
  integrity(tick: TickOk, snap: LogsSnapshot = this.snapshot(tick.head)): IntegrityResult {
    const cfg = this.cfg;
    const res: IntegrityResult = { checked: false, ok: true, a: null, b: null, c: null, d: null, detail: [] };
    if (!tick.pit) return res;
    if (snap.completeThrough === null || snap.completeThrough < tick.head || snap.incomplete) return res;
    res.checked = true;

    const upTo = tick.head;
    const paintedB = snap.painted.filter((p) => p.blockNumber <= upTo);
    const joinedB = snap.joined.filter((j) => j.blockNumber <= upTo);

    const strokes = paintedB.reduce((n, p) => n + BigInt(p.cells.length), 0n);
    res.a = strokes === tick.pit.totalStrokes;
    if (!res.a) res.detail.push(`strokes replayed ${strokes} != totalStrokes ${tick.pit.totalStrokes}`);

    res.b = BigInt(joinedB.length) === BigInt(tick.pit.playerCount);
    if (!res.b) res.detail.push(`joined replayed ${joinedB.length} != playerCount ${tick.pit.playerCount}`);

    const gen = genesisFrame(cfg.GENESIS_CELLS, cfg.GENESIS_COLORS);
    const replayed = frame(null, paintedB, snap.crewByPlayerId, gen);
    const onchain = decodeRawCellsSafe(tick.pit.rawCells);
    res.c = onchain !== null && framesEqual(replayed, onchain);
    if (!res.c) res.detail.push('frame(B) != rawCells()@B');

    const lastSettled = [...snap.settled].filter((s) => s.blockNumber <= upTo).pop();
    if (lastSettled && tick.pit.budget && tick.pit.budget.coreOk) {
      res.d = tick.pit.budget.coreHeight === lastSettled.height;
      if (!res.d) res.detail.push(`budgetOf.coreHeight ${tick.pit.budget.coreHeight} != BatchSettled height ${lastSettled.height}`);
    } else if (lastSettled) {
      // no wallet: cross-check state().blockHeight with the log-derived height instead
      res.d = tick.state.blockHeight === lastSettled.height;
      if (!res.d) res.detail.push(`state().blockHeight ${tick.state.blockHeight} != BatchSettled height ${lastSettled.height}`);
    }
    res.ok = (res.a ?? true) && (res.b ?? true) && (res.c ?? true) && (res.d ?? true);
    return res;
  }

  /**
   * Drop cache and rebuild from PIT_DEPLOY_BLOCK with the primary (Tenderly) client. Emits
   * 'cache-rebuilt' ("cache rebuilt from block N"). Rate-limited to once per 5 minutes.
   */
  async rebuild(primary: RpcClient, tick: TickOk): Promise<SyncResult | null> {
    const t = this.now();
    if (t - this.lastRebuildAt < 5 * 60_000) return null;
    this.lastRebuildAt = t;
    // Build into a fresh list; the old chunks and the persisted cache are only replaced once every chunk from
    // PIT_DEPLOY_BLOCK to head loaded. A rebuild that cannot load (provider down, range too large) leaves the
    // previous data in place (the caller marks it INCOMPLETE/integrityFailed) instead of leaving nothing.
    const oldCanonical = this.canonical;
    const oldVolatile = this.volatile;
    const oldFailed = this.failedChunks;
    this.canonical = [];
    this.volatile = [];
    this.boundaryVerified = true;
    this.deferSave = true;
    let r: SyncResult;
    try {
      r = await this.sync(primary, tick);
    } finally {
      this.deferSave = false;
    }
    if (r.failed > 0 || r.snapshot.completeThrough === null || r.snapshot.completeThrough < tick.head) {
      this.canonical = oldCanonical;
      this.volatile = oldVolatile;
      this.failedChunks = oldFailed;
      return null;
    }
    this.clearCache();
    if (tick.finalityTags || this.cfg.DEV) this.saveCache();
    this.emit({ type: 'cache-rebuilt', fromBlock: this.cfg.PIT_DEPLOY_BLOCK });
    return r;
  }
}

export type LogStoreEvent =
  | { type: 'chunk-failed'; range: Range; error: string }
  | { type: 'synced'; snapshot: LogsSnapshot }
  | { type: 'cache-rebuilt'; fromBlock: bigint };

function decodeRawCellsSafe(words: readonly bigint[]): Uint32Array | null {
  try {
    return decodeRawCells(words);
  } catch {
    return null;
  }
}

export function serializeChunk(c: Chunk): SerializedChunk {
  return { fromBlock: c.fromBlock.toString(), toBlock: c.toBlock.toString(), toBlockHash: c.toBlockHash, logs: c.logs };
}

export function deserializeChunk(s: SerializedChunk): Chunk {
  return { fromBlock: BigInt(s.fromBlock), toBlock: BigInt(s.toBlock), toBlockHash: s.toBlockHash, logs: s.logs ?? [] };
}

function safeLocalStorage(): StorageLike | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    const k = '__pit_probe__';
    localStorage.setItem(k, '1');
    localStorage.removeItem(k);
    return localStorage;
  } catch {
    return null;
  }
}
