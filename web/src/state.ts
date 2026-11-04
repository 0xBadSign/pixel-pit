// Tiny observable store + honesty labels (SPEC §6.5). Every screen reads from here; nothing here
// computes a budget number itself: budget numbers only come from budgetOf() and only when coreOk.
import type { Address, Hex } from 'viem';
import type { TickResult, TickOk } from './rpc';
import type { LogsSnapshot } from './logs';
import type { WalletState } from './wallet';

export type Label =
  | 'SETTLED'
  | 'FRESH'
  | 'PENDING'
  | 'PROVISIONAL'
  | 'UNKNOWN'
  | 'INCOMPLETE'
  | 'PRACTICE';

export type Budget = {
  joined: boolean;
  coreOk: boolean;
  coreHeight: bigint;
  ready: number;
  banked: number;
  fresh: number;
  arrived: bigint;
  forfeited: bigint;
};

export type DeploymentCheck =
  | { status: 'checking' }
  | {
      status: 'ok' | 'changed';
      pitCore: Address | null;
      impl: Address | null;
      runtimeHash: Hex | null;
      streamId: Hex | null;
      genesisTimestamp: bigint | null;
      targetBlocks: bigint | null;
      mismatches: string[];
      apiCore: Address | null; // from /v1/core, display-only comparison (PROVISIONAL)
      apiMismatch: boolean;
      checkedAt: number;
    }
  | { status: 'unreachable'; error: string; checkedAt: number };

/** The few /v1/status facts the PROVISIONAL light shows (parsed from the real api.squeekchain.com shape). */
export type ApiSummary = {
  freshness: string | null; // measurement.freshness ('online' | 'stale' | ...)
  coreStatus: string | null; // measurement.coreStatus ('IDLE' | 'RUNNING' | ...)
  rpm: number | null; // measurement.rpmMilli / 1000
  builderStatus: string | null; // builder.status
  queueStatus: string | null; // settlementQueue.status
  installationId: string | null;
};

export type ApiState = {
  status: 'unknown' | 'ok' | 'unavailable';
  body: Record<string, unknown> | null;
  summary: ApiSummary | null;
  coreAddress: Address | null; // /v1/core identities.core
  implAddress: Address | null; // /v1/core identities.proxyImplementation (display only)
  at: number | null;
  etag: string | null;
  retryAfterMs: number | null;
};

export type Banner = {
  id: string;
  kind: 'info' | 'warn' | 'error';
  text: string;
  at: number;
};

export type PendingTx = {
  hash: Hex;
  cells: number[];
  colors: number[];
  sentAt: number;
  /** sender + its nonce when known: lets the tick detect a replaced/dropped tx (Speed up / Cancel) */
  from?: Address;
  nonce?: number | null;
};

export type AppState = {
  tick: TickResult | null; // latest tick (may be UNKNOWN)
  lastGood: TickOk | null; // latest successful tick (canvas is drawn from this even when RPC is down)
  logs: LogsSnapshot | null;
  wallet: WalletState;
  deployment: DeploymentCheck;
  api: ApiState;
  banners: Banner[];
  lastKnownHeight: bigint | null; // last Squeek height confirmed by state() at a pinned block
  heightSettledAtBlock: bigint | null; // ETH block of the BatchSettled that brought lastKnownHeight (for the chip label)
  heightMovedBack: { now: bigint; was: bigint } | null;
  deploymentAcknowledged: boolean; // "I understand" unlocks Paint only (Join stays closed)
  practice: boolean;
  pendingTx: PendingTx | null;
  queue: { cells: number[]; colors: number[] };
};

export const initialState: AppState = {
  tick: null,
  lastGood: null,
  logs: null,
  wallet: { status: 'disconnected', providers: [] },
  deployment: { status: 'checking' },
  api: { status: 'unknown', body: null, summary: null, coreAddress: null, implAddress: null, at: null, etag: null, retryAfterMs: null },
  banners: [],
  lastKnownHeight: null,
  heightSettledAtBlock: null,
  heightMovedBack: null,
  deploymentAcknowledged: false,
  practice: false,
  pendingTx: null,
  queue: { cells: [], colors: [] },
};

export type Listener = (state: AppState, prev: AppState) => void;

export class Store {
  private state: AppState;
  private listeners = new Set<Listener>();

  constructor(init: AppState = initialState) {
    this.state = init;
  }

  get(): AppState {
    return this.state;
  }

  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
    const prev = this.state;
    const p = typeof patch === 'function' ? patch(prev) : patch;
    this.state = { ...prev, ...p };
    for (const l of this.listeners) {
      try {
        l(this.state, prev);
      } catch (e) {
        console.error('[store] listener failed', e);
      }
    }
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  banner(id: string, kind: Banner['kind'], text: string): void {
    this.set((s) => ({
      banners: [...s.banners.filter((b) => b.id !== id), { id, kind, text, at: Date.now() }],
    }));
  }

  clearBanner(id: string): void {
    this.set((s) => ({ banners: s.banners.filter((b) => b.id !== id) }));
  }
}

export const store = new Store();

// ---------- label rules (§6.5) ----------

/** SETTLED if block <= safe, else FRESH. */
export function blockLabel(block: bigint, safe: bigint): 'SETTLED' | 'FRESH' {
  return block <= safe ? 'SETTLED' : 'FRESH';
}

/**
 * HUD height label: SETTLED only if the BatchSettled block that brought the height is <= safe.
 * Without a known settlement block the height came only from state() at head: FRESH.
 */
export function heightLabel(heightBlock: bigint | null, safe: bigint): 'SETTLED' | 'FRESH' {
  if (heightBlock === null) return 'FRESH';
  return blockLabel(heightBlock, safe);
}

export type BatteryModel =
  | { kind: 'unknown'; asOfMs: number }
  | {
      kind: 'numbers';
      ready: number;
      banked: number;
      fresh: number;
      arrived: bigint;
      forfeited: bigint;
      coreHeight: bigint;
      ethBlock: bigint;
      label: 'FRESH' | 'SETTLED';
      pending: number | null;
    }
  | { kind: 'not-joined' }
  | { kind: 'no-wallet' };

/**
 * Budget numbers are shown only from budgetOf() and only while coreOk === true and the tick is good.
 * Anything else is UNKNOWN as of HH:MM UTC (never 0). When `address` is given, the tick must have read
 * budgetOf for that same address (after accountsChanged the previous account's numbers are UNKNOWN).
 */
export function batteryModel(
  tick: TickResult | null,
  budget: Budget | null | undefined,
  walletConnected: boolean,
  heightBlock: bigint | null,
  pending: number | null,
  address?: Address | null,
): BatteryModel {
  const now = Date.now();
  if (!walletConnected) return { kind: 'no-wallet' };
  if (!tick || !tick.ok) return { kind: 'unknown', asOfMs: tick?.at ?? now };
  if (address && (!tick.wallet || tick.wallet.toLowerCase() !== address.toLowerCase())) return { kind: 'unknown', asOfMs: tick.at };
  if (!budget) return { kind: 'unknown', asOfMs: tick.at };
  if (!budget.coreOk) return { kind: 'unknown', asOfMs: tick.at };
  if (!budget.joined) return { kind: 'not-joined' };
  return {
    kind: 'numbers',
    ready: budget.ready,
    banked: budget.banked,
    fresh: budget.fresh,
    arrived: budget.arrived,
    forfeited: budget.forfeited,
    coreHeight: budget.coreHeight,
    ethBlock: tick.head,
    label: heightLabel(heightBlock, tick.safe),
    pending,
  };
}
