// @vitest-environment node
// Wallet layer: EIP-6963 list fallback rule and revert-data decoding across the shapes wallets/RPCs produce (§6.4).
import { describe, it, expect } from 'vitest';
import { encodeErrorResult, type EIP1193Provider } from 'viem';
import { pixelPitAbi } from '../src/abi';
import { describeError, listWithFallback, revertDataCandidates, type DiscoveredProvider } from '../src/wallet';
import * as copy from '../src/copy';

const insufficient = encodeErrorResult({ abi: pixelPitAbi, errorName: 'InsufficientBudget', args: [13, 20n] });
const notJoined = encodeErrorResult({ abi: pixelPitAbi, errorName: 'NotJoined' });

describe('describeError walks every .data candidate, not just the first hex blob', () => {
  it('MetaMask shape: data.originalError.data', () => {
    const e = { code: -32603, message: 'Internal JSON-RPC error.', data: { code: 3, message: 'execution reverted', originalError: { data: insufficient } } };
    expect(revertDataCandidates(e)).toContain(insufficient);
    expect(describeError(e)).toMatchObject({ name: 'InsufficientBudget', sentence: copy.ERR_INSUFFICIENT_BUDGET('13', '20') });
  });
  it('nested cause chain with data.data', () => {
    const e = new Error('outer');
    (e as unknown as { cause: unknown }).cause = { message: 'rpc', cause: { data: { data: notJoined } } };
    expect(describeError(e)).toMatchObject({ name: 'NotJoined', sentence: copy.ERR_SENTENCES.NotJoined });
  });
  it('message fallback: the first hex blob is the calldata/from, the revert data comes later', () => {
    const e = new Error(`RPC Request failed.\nRequest body: {"from":"0x1111111111111111111111111111111111111111","data":"0xdeadbeef00000000"}\nDetails: execution reverted ${notJoined}`);
    expect(describeError(e)).toMatchObject({ name: 'NotJoined' });
  });
  it('user rejection and unknown errors', () => {
    expect(describeError({ code: 4001, message: 'User rejected' }).sentence).toBe(copy.ERR_USER_REJECTED);
    expect(describeError(new Error('boom')).sentence).toBe(copy.ERR_TX_FAILED);
  });
});

describe('EIP-6963 list: window.ethereum only when nobody announced', () => {
  const fake = (uuid: string): DiscoveredProvider => ({ info: { uuid, name: uuid, icon: '', rdns: uuid }, provider: { request: async () => null } as unknown as EIP1193Provider });
  const injected = { request: async () => null } as unknown as EIP1193Provider;
  it('an announced wallet is not duplicated by a different window.ethereum object', () => {
    const found = new Map([['mm', fake('mm')]]);
    expect(listWithFallback(found, injected).map((p) => p.info.uuid)).toEqual(['mm']);
  });
  it('with no announcement the injected provider is the single fallback entry', () => {
    expect(listWithFallback(new Map(), injected).map((p) => p.info.uuid)).toEqual(['window.ethereum']);
    expect(listWithFallback(new Map(), null)).toEqual([]);
  });
});
