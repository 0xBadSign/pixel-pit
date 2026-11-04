// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { batteryModel, type Budget } from '../src/state';
import { renderBattery } from '../src/ui/battery';
import type { TickOk } from '../src/rpc';

const tick: TickOk = {
  ok: true,
  at: Date.UTC(2026, 10, 4, 21, 42, 0),
  provider: 'https://sepolia.gateway.tenderly.co',
  providerIndex: 0,
  head: 12_061_055n,
  headHash: '0x' + '00'.repeat(32) as `0x${string}`,
  headTimestamp: 1_762_292_520n,
  safe: 12_061_040n,
  finalized: 12_060_990n,
  finalityTags: true,
  state: { settledThroughRound: 1246n, cumulativeWork: 0n, cumulativeBlockUnits: 8473_000_000_000n, blockHeight: 8473n, blockProgress: 0n, workPerThousandBlocks: 0, authorizationNonce: 0n, paused: false },
  pit: null,
  wallet: '0x0000000000000000000000000000000000000001',
};

const budgetUnknown: Budget = { joined: true, coreOk: false, coreHeight: 0n, ready: 0, banked: 0, fresh: 0, arrived: 0n, forfeited: 0n };
const budgetOk: Budget = { joined: true, coreOk: true, coreHeight: 8473n, ready: 27, banked: 10, fresh: 17, arrived: 57n, forfeited: 30n };

function digitsOutsideClock(text: string): string {
  // the only digits allowed in an UNKNOWN battery are the HH:MM clock of "as of HH:MM UTC"
  return text.replace(/\d{2}:\d{2} UTC/g, '').replace(/\D/g, '');
}

describe('budget battery label rules (SPEC §6.5)', () => {
  it('coreOk=false renders UNKNOWN and no digits (other than the clock)', () => {
    const el = document.createElement('div');
    renderBattery(el, batteryModel(tick, budgetUnknown, true, null, null));
    const text = el.textContent ?? '';
    expect(text).toContain('UNKNOWN');
    expect(text).toContain('as of 21:42 UTC');
    expect(digitsOutsideClock(text)).toBe('');
    expect(text).not.toMatch(/READY/);
    expect(el.dataset.state).toBe('unknown');
  });

  it('a failed tick renders UNKNOWN even if an old budget object is around', () => {
    const el = document.createElement('div');
    const fail = { ok: false as const, at: tick.at, reason: 'stale' as const, provider: null, head: null, headTimestamp: null, error: 'x' };
    renderBattery(el, batteryModel(fail, budgetOk, true, null, null));
    const text = el.textContent ?? '';
    expect(text).toContain('UNKNOWN');
    expect(digitsOutsideClock(text)).toBe('');
  });

  it('coreOk=true shows READY = banked + fresh (cap 40), arrived/forfeited and the FRESH/SETTLED label', () => {
    const el = document.createElement('div');
    renderBattery(el, batteryModel(tick, budgetOk, true, null, 0));
    const text = el.textContent ?? '';
    expect(text).toContain('READY 27 = banked 10 + fresh 17 (cap 40)');
    expect(text).toContain('+57 arrived, 30 forfeited above cap');
    expect(text).toContain('as of ETH block 12,061,055 (head) · FRESH');
    expect(text).not.toContain('PENDING');
  });

  it('SETTLED only when the settlement block that brought the height is <= safe', () => {
    const el = document.createElement('div');
    renderBattery(el, batteryModel(tick, budgetOk, true, 12_061_000n, null));
    expect(el.textContent).toContain('· SETTLED');
    renderBattery(el, batteryModel(tick, budgetOk, true, 12_061_050n, null));
    expect(el.textContent).toContain('· FRESH');
  });

  it('PENDING n is a separate line and never counted into READY', () => {
    const el = document.createElement('div');
    renderBattery(el, batteryModel(tick, budgetOk, true, null, 12));
    expect(el.textContent).toContain('READY 27');
    expect(el.textContent).toContain('PENDING 12');
  });

  it('no wallet / not joined show no numbers', () => {
    const el = document.createElement('div');
    renderBattery(el, batteryModel(tick, budgetOk, false, null, null));
    expect(el.textContent?.replace(/\D/g, '')).toBe('');
    renderBattery(el, batteryModel(tick, { ...budgetOk, joined: false }, true, null, null));
    expect(el.textContent?.replace(/\D/g, '')).toBe('');
  });
});
