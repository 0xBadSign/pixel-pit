// @vitest-environment node
// api.squeekchain.com parsing (SPEC §6.3 last bullet, §6.5 PROVISIONAL/UNKNOWN). Fixtures are the live bodies
// captured on 2026-11-04 10:52 UTC (trimmed to the fields the page reads plus a few neighbours).
import { describe, it, expect, vi } from 'vitest';
import { createApiPoller, extractCoreAddress, extractImplAddress, parseRetryAfter, statusOf, summarizeStatus } from '../src/api';
import type { ApiState } from '../src/state';

const LIVE_STATUS = {
  schemaVersion: 1,
  installationId: 'stream-game-sepolia-test-20261025-01',
  revision: 'RjkzveU7K37MNC337y7GzRJ0R1GveEmS1cCjN-BarG8',
  generatedAt: '2026-11-04T10:52:47.880Z',
  measurement: {
    freshness: 'online',
    observedAt: '2026-11-04T10:52:39.658Z',
    receivedAt: '2026-11-04T10:52:40.229Z',
    staleAfterSeconds: 120,
    counterEpoch: 'c011f01a-93ba-45ff-8579-619ddfdf40ec',
    cumulativeWorkUnits: '92730',
    provenance: 'hardware',
    coreStatus: 'IDLE',
    rpmMilli: 0,
    speedMmPerSecond: 0,
    distanceMm: 7022244,
  },
  builder: {
    status: 'available',
    anchor: { cumulativeWork: '92730', cumulativeBlockUnits: '8430478838171', blockHeight: '8430', settledThroughRound: '1276', transactionHash: '0x8afceb71f4ba066b73aedb2159c6bc5d7eab93b86b71644582fe60c5a27779cc' },
    projected: { blockHeight: '8430', lifecycle: 'optimistic' },
  },
  oracle: { state: 'accepted', reason: null, latestAcceptedAt: '2026-11-04T10:52:40.229Z' },
  settlementQueue: { status: 'available', state: 'submitted', settlementEnabled: true, incidentOpen: false, blockedReason: null },
  signer: { kind: 'trust-m', algorithm: 'ecdsa-p256-sha256' },
  modules: [{ instanceId: 'wheel', moduleType: 'wheel.counter', state: 'ready' }],
};

const LIVE_CORE = {
  schemaVersion: 1,
  installationId: 'stream-game-sepolia-test-20261025-01',
  status: 'available',
  chain: { target: 'sepolia', chainId: '11155111', confirmations: '12', deploymentBlock: '11998937', indexedThroughBlock: '12061945', safeThroughBlock: '12061934' },
  identities: {
    factory: '0xbeaea1b81a7e9f2dc49901602fdb4d6bb260813f',
    core: '0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44',
    proxyAdmin: '0x4a8ea91a43eeecb8cffc73631627a7d6f973fdbf',
    proxyImplementation: '0x284747c4664af2203e7a90a2ee76f22b6b5e6889',
  },
  configuration: { streamId: '0x52e443e4e0d236ff0c07f4cdc518c594a3d680d20abb1481510efbed0ec73633', genesisTimestamp: '1793022600', targetBlocksPerActiveRound: '40' },
  // NOTE: top-level `core` is the STATE object, not an address
  core: { cumulativeWork: '92730', cumulativeBlockUnits: '8430478838171', blockHeight: '8430', settledThroughRound: '1276', paused: false },
  implementation: { codeAddress: '0x284747c4664af2203e7a90a2ee76f22b6b5e6889', codeVersion: '3', runtimeHash: '0xd8f2fb3c7dcf63e6dc0378ce5f85ceea52a876ae1f0cd66ac8631c3103371f8a' },
};

describe('/v1/status parsing (real shape)', () => {
  it('live body: ok, freshness online, coreStatus IDLE, rpm = rpmMilli/1000', () => {
    expect(statusOf(LIVE_STATUS)).toBe('ok');
    expect(summarizeStatus(LIVE_STATUS)).toEqual({ freshness: 'online', coreStatus: 'IDLE', rpm: 0, builderStatus: 'available', queueStatus: 'available', installationId: 'stream-game-sepolia-test-20261025-01' });
    const running = { ...LIVE_STATUS, measurement: { ...LIVE_STATUS.measurement, coreStatus: 'RUNNING', rpmMilli: 42_500 } };
    expect(summarizeStatus(running)?.rpm).toBe(42.5);
  });

  it('freshness !== online or any nested status === unavailable => UNKNOWN (spec: status unavailable → UNKNOWN)', () => {
    expect(statusOf({ ...LIVE_STATUS, measurement: { ...LIVE_STATUS.measurement, freshness: 'stale' } })).toBe('unavailable');
    expect(statusOf({ ...LIVE_STATUS, builder: { status: 'unavailable' } })).toBe('unavailable');
    expect(statusOf({ ...LIVE_STATUS, settlementQueue: { status: 'unavailable' } })).toBe('unavailable');
    expect(statusOf({ ...LIVE_STATUS, status: 'unavailable' })).toBe('unavailable');
  });

  it('never invents ok: no measurement block and no status => unknown; the old invented shape is not "ok" either', () => {
    expect(statusOf(null)).toBe('unknown');
    expect(statusOf({})).toBe('unknown');
    expect(statusOf({ status: 'running', rpm: 42 })).toBe('ok'); // flat legacy shape with an explicit non-unavailable status
    expect(summarizeStatus({ status: 'running', rpm: 42 })).toEqual({ freshness: null, coreStatus: null, rpm: null, builderStatus: null, queueStatus: null, installationId: null });
  });
});

describe('/v1/core parsing (real shape)', () => {
  it('reads identities.core and identities.proxyImplementation', () => {
    expect(extractCoreAddress(LIVE_CORE)).toBe('0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44');
    expect(extractImplAddress(LIVE_CORE)).toBe('0x284747c4664af2203e7a90a2ee76f22b6b5e6889');
  });
  it('UNKNOWN only when the field is genuinely absent (the state object under `core` is not an address)', () => {
    expect(extractCoreAddress({ ...LIVE_CORE, identities: {} })).toBeNull();
    expect(extractCoreAddress({ core: LIVE_CORE.core })).toBeNull();
    expect(extractCoreAddress({ identities: { core: 'not an address' } })).toBeNull();
    expect(extractCoreAddress({ coreAddress: '0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44' })).toBe('0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44'); // legacy flat shape still accepted
    expect(extractImplAddress({ implementation: { codeAddress: LIVE_CORE.implementation.codeAddress } })).toBe(LIVE_CORE.implementation.codeAddress);
  });
});

describe('poller: ETag / 304, Retry-After, 429, hidden-tab backoff', () => {
  function res(status: number, body: unknown, headers: Record<string, string> = {}): Response {
    const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { status, ok: status >= 200 && status < 300, headers: { get: (k: string) => h.get(k.toLowerCase()) ?? null }, json: async () => body } as unknown as Response;
  }

  it('304 keeps the last body + status; Retry-After stretches the next poll; 429 is UNKNOWN', async () => {
    const states: ApiState[] = [];
    const calls: string[] = [];
    let n = 0;
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/v1/core')) return res(200, LIVE_CORE);
      n++;
      if (n === 1) return res(200, LIVE_STATUS, { etag: '"abc"' });
      if (n === 2) {
        expect((init?.headers as Record<string, string>)['if-none-match']).toBe('"abc"');
        return res(304, null, { 'retry-after': '30' });
      }
      return res(429, null, { 'retry-after': '120' });
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    const now = () => Date.now();
    const poller = createApiPoller({ fetchFn, intervalMs: 15_000, onState: (s) => states.push(s), now, doc: { hidden: false } });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(states.at(-1)).toMatchObject({ status: 'ok', etag: '"abc"', coreAddress: '0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44', implAddress: '0x284747c4664af2203e7a90a2ee76f22b6b5e6889' });
    expect(states.at(-1)?.summary?.freshness).toBe('online');
    await vi.advanceTimersByTimeAsync(15_000); // second poll: 304 + Retry-After 30 s
    expect(states.at(-1)).toMatchObject({ status: 'ok', retryAfterMs: 30_000 });
    expect(states.at(-1)?.body).toEqual(LIVE_STATUS); // body kept across the 304
    const before = calls.length;
    await vi.advanceTimersByTimeAsync(20_000); // < 30 s: no third poll yet
    expect(calls.length).toBe(before);
    await vi.advanceTimersByTimeAsync(10_000); // 429 => unavailable, next wait 120 s
    expect(states.at(-1)).toMatchObject({ status: 'unavailable', retryAfterMs: 120_000 });
    poller.stop();
    vi.useRealTimers();
  });

  it('backs off to the hidden interval while document.hidden', async () => {
    const calls: number[] = [];
    const doc = { hidden: true };
    const fetchFn = vi.fn(async () => {
      calls.push(Date.now());
      return res(200, LIVE_STATUS);
    }) as unknown as typeof fetch;
    vi.useFakeTimers();
    const poller = createApiPoller({ fetchFn, intervalMs: 15_000, hiddenMs: 60_000, onState: () => {}, doc });
    poller.start();
    await vi.advanceTimersByTimeAsync(1);
    const statusCalls = () => calls.length - 1; // minus the one /v1/core call on the first loop
    expect(statusCalls()).toBe(1);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(statusCalls()).toBe(1); // 15 s interval would have polled 3 more times
    await vi.advanceTimersByTimeAsync(15_000);
    expect(statusCalls()).toBe(2);
    doc.hidden = false; // the already-armed 60 s timer fires once more, then the 15 s cadence resumes
    await vi.advanceTimersByTimeAsync(60_000);
    expect(statusCalls()).toBe(3);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(statusCalls()).toBe(4);
    poller.stop();
    vi.useRealTimers();
  });

  it('parseRetryAfter: seconds and HTTP dates', () => {
    const now = Date.UTC(2026, 10, 4, 10, 52, 48);
    expect(parseRetryAfter('30', now)).toBe(30_000);
    expect(parseRetryAfter('Wed, 04 Nov 2026 10:53:48 GMT', now)).toBe(60_000);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter('garbage', now)).toBeNull();
  });
});
