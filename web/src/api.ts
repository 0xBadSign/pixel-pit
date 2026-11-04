// api.squeekchain.com poller (SPEC §6.3 last bullet): /v1/status every 15 s with ETag and Retry-After,
// /v1/core for the display-only address comparison. Everything here is PROVISIONAL: it lights a dot and
// shows a reported address; it never creates budget, never triggers a flash, never replaces an RPC number.
//
// Real response shapes (captured 2026-11-04, tests/api.test.ts keeps the fixtures):
//   /v1/status: { installationId, measurement: { freshness: 'online', coreStatus: 'IDLE', rpmMilli, staleAfterSeconds, … },
//                builder: { status: 'available', … }, settlementQueue: { status: 'available', … }, oracle, signer, modules }
//   /v1/core:   { status: 'available', identities: { core, proxyImplementation, … }, core: { blockHeight, … }, implementation: { codeAddress, runtimeHash } }
// There is no top-level `status`/`running`/`rpm` in /v1/status and no top-level address in /v1/core.
import type { Address } from 'viem';
import { CONFIG } from './config';
import type { ApiState, ApiSummary } from './state';

export type ApiPollerOptions = {
  fetchFn?: typeof fetch;
  intervalMs?: number;
  hiddenMs?: number; // poll interval while the tab is hidden (default 60 s)
  doc?: Pick<Document, 'hidden'> | null;
  onState: (s: ApiState) => void;
  now?: () => number;
};

export function parseRetryAfter(header: string | null, nowMs: number): number | null {
  if (!header) return null;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const t = Date.parse(header);
  if (Number.isFinite(t)) return Math.max(0, t - nowMs);
  return null;
}

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | null => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const addr = (v: unknown): Address | null => (typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null);

/** Reported core proxy address: /v1/core `identities.core` (legacy flat shapes are still accepted). */
export function extractCoreAddress(body: unknown): Address | null {
  const o = obj(body);
  if (!o) return null;
  const ids = obj(o.identities);
  return addr(ids?.core) ?? addr(o.coreAddress) ?? addr(o.address) ?? addr(o.core) ?? addr(obj(o.core)?.address) ?? addr(obj(o.data)?.core) ?? null;
}

/** Reported implementation address: `identities.proxyImplementation`, else `implementation.codeAddress`. */
export function extractImplAddress(body: unknown): Address | null {
  const o = obj(body);
  if (!o) return null;
  return addr(obj(o.identities)?.proxyImplementation) ?? addr(obj(o.implementation)?.codeAddress) ?? null;
}

/** The few /v1/status facts the light shows. Missing fields stay null (never invented). */
export function summarizeStatus(body: unknown): ApiSummary | null {
  const o = obj(body);
  if (!o) return null;
  const m = obj(o.measurement);
  const rpmMilli = m && typeof m.rpmMilli === 'number' && Number.isFinite(m.rpmMilli) ? m.rpmMilli : null;
  return {
    freshness: str(m?.freshness),
    coreStatus: str(m?.coreStatus),
    rpm: rpmMilli === null ? null : rpmMilli / 1000,
    builderStatus: str(obj(o.builder)?.status),
    queueStatus: str(obj(o.settlementQueue)?.status),
    installationId: str(o.installationId),
  };
}

/**
 * ok only when the measurement is `online` and no reported component says `unavailable` (SPEC §6.3:
 * `status: unavailable` → UNKNOWN). A body without a measurement block is unknown, never ok.
 */
export function statusOf(body: unknown): ApiState['status'] {
  const o = obj(body);
  if (!o) return 'unknown';
  const nested = [o.status, obj(o.builder)?.status, obj(o.settlementQueue)?.status, obj(o.oracle)?.status];
  if (nested.some((s) => s === 'unavailable')) return 'unavailable';
  const m = obj(o.measurement);
  if (!m) return typeof o.status === 'string' ? (o.status === 'unavailable' ? 'unavailable' : 'ok') : 'unknown';
  if (m.freshness !== 'online') return 'unavailable';
  return 'ok';
}

export function createApiPoller(o: ApiPollerOptions): { start(): void; stop(): void } {
  const fetchFn = o.fetchFn ?? (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
  const now = o.now ?? Date.now;
  const interval = o.intervalMs ?? CONFIG.API_POLL_MS;
  const hiddenMs = o.hiddenMs ?? CONFIG.TICK_HIDDEN_MS;
  const doc = o.doc === undefined ? (typeof document !== 'undefined' ? document : null) : o.doc;
  const baseInterval = () => (doc && doc.hidden ? hiddenMs : interval);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let state: ApiState = { status: 'unknown', body: null, summary: null, coreAddress: null, implAddress: null, at: null, etag: null, retryAfterMs: null };
  let lastBody: Record<string, unknown> | null = null;

  const update = (patch: Partial<ApiState>) => {
    state = { ...state, ...patch };
    o.onState(state);
  };

  const pollStatus = async (): Promise<number> => {
    const interval = baseInterval();
    if (!fetchFn) {
      update({ status: 'unknown', at: now() });
      return interval;
    }
    try {
      const headers: Record<string, string> = { accept: 'application/json' };
      if (state.etag) headers['if-none-match'] = state.etag;
      const res = await fetchFn(CONFIG.API_STATUS, { headers, cache: 'no-store' });
      const retry = parseRetryAfter(res.headers.get('retry-after'), now());
      if (res.status === 304) {
        update({ at: now(), retryAfterMs: retry, body: lastBody, summary: summarizeStatus(lastBody), status: statusOf(lastBody) });
        return Math.max(interval, retry ?? 0);
      }
      if (res.status === 429 || res.status === 503) {
        update({ status: 'unavailable', at: now(), retryAfterMs: retry });
        return Math.max(interval, retry ?? 60_000);
      }
      if (!res.ok) {
        update({ status: 'unavailable', at: now(), retryAfterMs: retry });
        return Math.max(interval, retry ?? 0);
      }
      const body = (await res.json()) as Record<string, unknown>;
      lastBody = body;
      update({ status: statusOf(body), body, summary: summarizeStatus(body), at: now(), etag: res.headers.get('etag'), retryAfterMs: retry });
      return Math.max(interval, retry ?? 0);
    } catch {
      update({ status: 'unknown', at: now() });
      return interval;
    }
  };

  const pollCore = async (): Promise<void> => {
    if (!fetchFn) return;
    try {
      const res = await fetchFn(CONFIG.API_CORE, { headers: { accept: 'application/json' }, cache: 'no-store' });
      if (!res.ok) return;
      const body = (await res.json()) as unknown;
      update({ coreAddress: extractCoreAddress(body), implAddress: extractImplAddress(body) });
    } catch {
      /* display only; leave coreAddress as is */
    }
  };

  let coreTicks = 0;
  const loop = async () => {
    if (!running) return;
    const wait = await pollStatus();
    if (coreTicks % 20 === 0) await pollCore(); // every ~5 minutes
    coreTicks++;
    if (!running) return;
    timer = setTimeout(loop, wait);
  };

  return {
    start() {
      if (running) return;
      running = true;
      void loop();
    },
    stop() {
      running = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
