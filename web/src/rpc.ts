// Single-provider-per-tick RPC layer (SPEC §6.3).
// Every read of a tick (head, safe, finalized, state(), rawCells(), budgetOf(), totalStrokes(), playerCount(),
// crewScores()) comes from the SAME provider at the SAME pinned block. Tenderly is primary; on any error or
// timeout the WHOLE tick is retried on publicnode. Half from one and half from the other never happens.
import {
  createClient,
  http,
  custom,
  type Address,
  type Hex,
  type Client,
  type EIP1193RequestFn,
} from 'viem';
import { ethCall, getBlockHeader } from './eth';
import { CONFIG, type Config } from './config';
import { coreAbi, pixelPitAbi } from './abi';
import type { Budget } from './state';

export type CoreState = {
  settledThroughRound: bigint;
  cumulativeWork: bigint;
  cumulativeBlockUnits: bigint;
  blockHeight: bigint;
  blockProgress: bigint;
  workPerThousandBlocks: number;
  authorizationNonce: bigint;
  paused: boolean;
};

export type PitReads = {
  rawCells: bigint[]; // 128 words
  totalStrokes: bigint;
  playerCount: number;
  crewScores: number[]; // 4 entries
  budget: Budget | null; // only when a wallet is connected
};

export type TickOk = {
  ok: true;
  at: number; // device time (ms) when the tick completed
  provider: string;
  providerIndex: number;
  head: bigint; // pinned block B
  headHash: Hex;
  headTimestamp: bigint;
  safe: bigint;
  finalized: bigint;
  finalityTags: boolean; // false => head-12 / head-64 fallback was used
  state: CoreState;
  pit: PitReads | null; // null when PIT is not configured yet (pre-deploy placeholder)
  wallet: Address | null;
};

export type TickFail = {
  ok: false;
  at: number;
  reason: 'stale' | 'unreachable';
  provider: string | null;
  head: bigint | null;
  headTimestamp: bigint | null;
  error: string;
};

export type TickResult = TickOk | TickFail;

/** A provider handle. `index` 0 is primary (Tenderly), 1 is the fallback (publicnode). */
export type RpcClient = {
  url: string;
  index: number;
  pub: Client;
};

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as const;

export function makeHttpClients(urls: readonly string[], timeoutMs = CONFIG.RPC_TIMEOUT_MS): RpcClient[] {
  return urls.map((url, index) => ({
    url,
    index,
    pub: createClient({
      transport: http(url, { timeout: timeoutMs, retryCount: 0, batch: false }),
    }),
  }));
}

/** Build a client around an EIP-1193-style request function (tests / dev). */
export function makeCustomClient(url: string, index: number, request: EIP1193RequestFn): RpcClient {
  return { url, index, pub: createClient({ transport: custom({ request }, { retryCount: 0 }) }) };
}

export class StaleHeadError extends Error {
  constructor(
    public head: bigint,
    public headTimestamp: bigint,
    ageSeconds: number,
  ) {
    super(`stale head ${head} (${ageSeconds}s old)`);
    this.name = 'StaleHeadError';
  }
}

export type TickOptions = {
  wallet?: Address | null;
  now?: () => number; // ms
  cfg?: Config;
};

/**
 * Run one full tick against the given provider. Throws on ANY failure so the caller can retry the
 * whole tick on the next provider. Nothing from a thrown tick is kept.
 */
export async function tickWith(client: RpcClient, opts: TickOptions = {}): Promise<TickOk> {
  const cfg = opts.cfg ?? CONFIG;
  const now = opts.now ?? Date.now;
  const pub = client.pub;

  // head
  const headBlock = await getBlockHeader(pub, 'latest');
  const head = headBlock.number;
  const headHash = headBlock.hash;
  const headTimestamp = headBlock.timestamp;
  const ageSeconds = Math.floor(now() / 1000) - Number(headTimestamp);
  if (ageSeconds > cfg.HEAD_STALE_SECONDS) {
    throw new StaleHeadError(head, headTimestamp, ageSeconds);
  }

  // safe / finalized (node tags), fallback head-12 / head-64 ONLY when the provider does not know the tag.
  // Any other error (timeout, 5xx, rate limit) is a provider failure and moves the whole tick to the fallback.
  let safe: bigint;
  let finalized: bigint;
  let finalityTags = false;
  const clampBelowHead = (n: bigint) => (n > head ? head : n);
  if (cfg.FINALITY_TAGS) {
    try {
      const [s, f] = await Promise.all([getBlockHeader(pub, 'safe'), getBlockHeader(pub, 'finalized')]);
      safe = clampBelowHead(s.number);
      finalized = clampBelowHead(f.number);
      finalityTags = true;
    } catch (e) {
      if (!isTagUnsupported(e)) throw e;
      safe = fallbackTag(head, cfg.FALLBACK_CONFIRMATIONS.safe);
      finalized = fallbackTag(head, cfg.FALLBACK_CONFIRMATIONS.finalized);
    }
  } else {
    safe = fallbackTag(head, cfg.FALLBACK_CONFIRMATIONS.safe);
    finalized = fallbackTag(head, cfg.FALLBACK_CONFIRMATIONS.finalized);
  }

  // All contract reads pinned to block B = head, by HASH (EIP-1898): a reorg between eth_getBlockByNumber and the
  // calls cannot hand us a different block's state under the same number.
  const blockNumber = { blockHash: headHash } as const;
  const stateP = ethCall(pub, { address: cfg.CORE, abi: coreAbi, functionName: 'state', block: blockNumber });

  const pitConfigured = cfg.PIT.toLowerCase() !== ZERO_ADDRESS;
  let pit: PitReads | null = null;
  let stateRaw: Awaited<typeof stateP>;
  if (pitConfigured) {
    const wallet = opts.wallet ?? null;
    const rawCellsP = ethCall(pub, { address: cfg.PIT, abi: pixelPitAbi, functionName: 'rawCells', block: blockNumber });
    const totalStrokesP = ethCall(pub, { address: cfg.PIT, abi: pixelPitAbi, functionName: 'totalStrokes', block: blockNumber });
    const playerCountP = ethCall(pub, { address: cfg.PIT, abi: pixelPitAbi, functionName: 'playerCount', block: blockNumber });
    const crewScoresP = ethCall(pub, { address: cfg.PIT, abi: pixelPitAbi, functionName: 'crewScores', block: blockNumber });
    const budgetP: Promise<readonly [boolean, boolean, bigint, number, number, number, bigint, bigint] | null> = wallet
      ? ethCall(pub, { address: cfg.PIT, abi: pixelPitAbi, functionName: 'budgetOf', args: [wallet], block: blockNumber })
      : Promise.resolve(null);
    // Kicked off in parallel above; awaited one by one so a single failure rejects the whole tick.
    // Mark the siblings handled so a later rejection is not reported as unhandled once we threw.
    for (const p of [stateP, rawCellsP, totalStrokesP, playerCountP, crewScoresP, budgetP]) p.catch(() => {});
    const st = await stateP;
    // abitype gives up on `uint256[128]` (tuple too long) and types it `unknown`; the runtime shape is bigint[128].
    const rawCells = (await rawCellsP) as readonly bigint[];
    const totalStrokes = await totalStrokesP;
    const playerCount = await playerCountP;
    const crewScores = await crewScoresP;
    const budgetRaw = await budgetP;
    stateRaw = st;
    if (rawCells.length !== 128) throw new Error(`rawCells returned ${rawCells.length} words`);
    pit = {
      rawCells: [...rawCells],
      totalStrokes,
      playerCount,
      crewScores: [...crewScores],
      budget: budgetRaw ? decodeBudget(budgetRaw) : null,
    };
  } else {
    stateRaw = await stateP;
  }

  const state: CoreState = {
    settledThroughRound: stateRaw.settledThroughRound,
    cumulativeWork: stateRaw.cumulativeWork,
    cumulativeBlockUnits: stateRaw.cumulativeBlockUnits,
    blockHeight: stateRaw.blockHeight,
    blockProgress: stateRaw.blockProgress,
    workPerThousandBlocks: stateRaw.workPerThousandBlocks,
    authorizationNonce: stateRaw.authorizationNonce,
    paused: stateRaw.paused,
  };

  return {
    ok: true,
    at: now(),
    provider: client.url,
    providerIndex: client.index,
    head,
    headHash,
    headTimestamp,
    safe,
    finalized,
    finalityTags,
    state,
    pit,
    wallet: opts.wallet ?? null,
  };
}

/**
 * True only for errors that mean "this node does not know the safe/finalized tag": JSON-RPC -32602 (invalid params)
 * / -32601 (method not found) or an "invalid block tag" / "unknown block" message. Timeouts, 5xx and rate limits
 * return false so the tick fails over instead of silently using head-12 / head-64.
 */
export function isTagUnsupported(e: unknown): boolean {
  const seen = new Set<unknown>();
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as { code?: unknown; message?: unknown; cause?: unknown; details?: unknown };
    if (o.code === -32602 || o.code === -32601) return true;
    for (const text of [o.message, o.details]) {
      if (typeof text === 'string' && /invalid block tag|unknown block|block tag .*not supported|unsupported block tag|^block (safe|finalized) not found/i.test(text)) return true;
    }
    cur = o.cause;
  }
  return false;
}

function fallbackTag(head: bigint, confirmations: number): bigint {
  const n = head - BigInt(confirmations);
  return n < 0n ? 0n : n;
}

export function decodeBudget(
  r: readonly [boolean, boolean, bigint, number, number, number, bigint, bigint],
): Budget {
  return {
    joined: r[0],
    coreOk: r[1],
    coreHeight: r[2],
    ready: r[3],
    banked: r[4],
    fresh: r[5],
    arrived: r[6],
    forfeited: r[7],
  };
}

/**
 * Run one tick: primary first, then the fallback for the WHOLE tick. Returns an UNKNOWN result
 * (never throws) when every provider fails or is stale.
 */
export async function runTick(clients: readonly RpcClient[], opts: TickOptions = {}): Promise<TickResult> {
  const now = opts.now ?? Date.now;
  let lastError: unknown = null;
  let lastProvider: string | null = null;
  let staleInfo: { head: bigint; ts: bigint } | null = null;
  for (const client of clients) {
    lastProvider = client.url;
    try {
      return await tickWith(client, opts);
    } catch (e) {
      lastError = e;
      if (e instanceof StaleHeadError) staleInfo = { head: e.head, ts: e.headTimestamp };
    }
  }
  const reason: TickFail['reason'] = lastError instanceof StaleHeadError ? 'stale' : 'unreachable';
  return {
    ok: false,
    at: now(),
    reason,
    provider: lastProvider,
    head: staleInfo?.head ?? null,
    headTimestamp: staleInfo?.ts ?? null,
    error: errorMessage(lastError),
  };
}

export function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message.split('\n')[0] ?? e.message;
  return String(e);
}

// ---------- ticker ----------

export type TickerOptions = {
  run: () => Promise<void>;
  intervalMs?: number;
  hiddenMs?: number;
  doc?: Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'> | null;
};

/** 12 s interval, 60 s while the tab is hidden; a visibility change re-arms immediately. */
export function createTicker(o: TickerOptions): { start(): void; stop(): void; kick(): void } {
  const intervalMs = o.intervalMs ?? CONFIG.TICK_MS;
  const hiddenMs = o.hiddenMs ?? CONFIG.TICK_HIDDEN_MS;
  const doc = o.doc === undefined ? (typeof document !== 'undefined' ? document : null) : o.doc;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let inFlight = false;
  let rerun = false; // a kick() that arrived while a tick was in flight: run again as soon as it finishes

  const delay = () => (doc && doc.hidden ? hiddenMs : intervalMs);

  const arm = () => {
    if (!running) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(loop, delay());
  };

  const loop = async () => {
    if (!running) return;
    if (inFlight) {
      rerun = true;
      return;
    }
    inFlight = true;
    try {
      await o.run();
    } catch (e) {
      console.error('[tick] failed', e);
    } finally {
      inFlight = false;
      if (rerun && running) {
        rerun = false;
        void loop();
      } else {
        arm();
      }
    }
  };

  const onVisibility = () => {
    if (!running) return;
    if (doc && !doc.hidden) void loop();
    else arm();
  };

  return {
    start() {
      if (running) return;
      running = true;
      doc?.addEventListener('visibilitychange', onVisibility);
      void loop();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
    kick() {
      void loop();
    },
  };
}
