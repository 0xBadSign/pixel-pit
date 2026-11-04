// Wallet layer (SPEC §2.2, §6.4 join sheet): EIP-6963 discovery + window.ethereum fallback, chain check and
// wallet_switchEthereumChain(0xaa36a7), balance read, custom-error decoding to plain sentences.
import {
  createClient,
  custom,
  BaseError,
  ContractFunctionRevertedError,
  UserRejectedRequestError,
  decodeErrorResult,
  type Address,
  type Hex,
  type Client,
  type EIP1193Provider,
} from 'viem';
import { getBalanceAt } from './eth';
import { CONFIG } from './config';
import { pixelPitAbi } from './abi';
import * as copy from './copy';
import type { RpcClient } from './rpc';

export type ProviderInfo = {
  uuid: string;
  name: string;
  icon: string; // data URI
  rdns: string;
};

export type DiscoveredProvider = { info: ProviderInfo; provider: EIP1193Provider };

export type WalletState =
  | { status: 'disconnected'; providers: DiscoveredProvider[] }
  | {
      status: 'connected';
      providers: DiscoveredProvider[];
      selected: DiscoveredProvider;
      address: Address;
      chainId: number;
      wrongNetwork: boolean;
      balanceWei: bigint | null; // read from the tick provider, not the wallet
      lowBalance: boolean;
    };

export const LOW_BALANCE_WEI = 2_000_000_000_000_000n; // 0.002 ETH

type Eip6963AnnounceEvent = CustomEvent<{ info: ProviderInfo; provider: EIP1193Provider }>;

/** Listen for EIP-6963 announcements; also exposes window.ethereum as a fallback entry. */
export function discoverProviders(onChange: (list: DiscoveredProvider[]) => void): () => void {
  const found = new Map<string, DiscoveredProvider>();
  const emit = () => onChange(listWithFallback(found));
  const handler = (ev: Event) => {
    const d = (ev as Eip6963AnnounceEvent).detail;
    if (!d?.info?.uuid || !d.provider) return;
    found.set(d.info.uuid, { info: d.info, provider: d.provider });
    emit();
  };
  if (typeof window === 'undefined') return () => {};
  window.addEventListener('eip6963:announceProvider', handler);
  window.dispatchEvent(new Event('eip6963:requestProvider'));
  // window.ethereum may be injected late in in-wallet browsers
  const t = setTimeout(emit, 300);
  emit();
  return () => {
    clearTimeout(t);
    window.removeEventListener('eip6963:announceProvider', handler);
  };
}

/** window.ethereum is listed only when NO EIP-6963 provider announced itself (in-wallet browsers); wallets that
 *  announce usually inject a different object under window.ethereum, which would show the same wallet twice. */
export function listWithFallback(found: Map<string, DiscoveredProvider>, w?: EIP1193Provider | null): DiscoveredProvider[] {
  const list = [...found.values()];
  const eth = w === undefined ? (typeof window !== 'undefined' ? (window as unknown as { ethereum?: EIP1193Provider }).ethereum : undefined) : w;
  if (list.length === 0 && eth) {
    list.push({
      info: { uuid: 'window.ethereum', name: 'Browser wallet (window.ethereum)', icon: '', rdns: 'window.ethereum' },
      provider: eth,
    });
  }
  return list.sort((a, b) => rank(a.info.rdns) - rank(b.info.rdns) || a.info.name.localeCompare(b.info.name));
}

/** Well-known EVM wallets first; multi-chain wallets that also announce an EVM provider (e.g. Keplr) go last. */
const EVM_FIRST = ['io.metamask', 'io.rabby', 'com.coinbase.wallet', 'app.phantom', 'com.brave.wallet', 'xyz.frame', 'com.trustwallet.app', 'com.okex.wallet'];
function rank(rdns: string): number {
  const i = EVM_FIRST.indexOf(rdns);
  return i === -1 ? EVM_FIRST.length : i;
}

export async function connect(p: DiscoveredProvider): Promise<{ address: Address; chainId: number }> {
  const accounts = (await p.provider.request({ method: 'eth_requestAccounts' })) as Address[];
  const address = accounts[0];
  if (!address) throw new Error('No account returned');
  const chainId = await readChainId(p.provider);
  return { address, chainId };
}

export async function readChainId(provider: EIP1193Provider): Promise<number> {
  const hex = (await provider.request({ method: 'eth_chainId' })) as Hex;
  return Number(BigInt(hex));
}

/** wallet_switchEthereumChain(0xaa36a7); adds Sepolia if the wallet does not know it (4902). */
export async function switchToSepolia(provider: EIP1193Provider): Promise<void> {
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: CONFIG.chainIdHex }] });
  } catch (e) {
    const code = (e as { code?: number }).code;
    if (code === 4902 && CONFIG.chainId === 11155111) {
      await provider.request({
        method: 'wallet_addEthereumChain',
        params: [
          {
            chainId: CONFIG.chainIdHex,
            chainName: 'Sepolia',
            nativeCurrency: { name: 'Sepolia Ether', symbol: 'ETH', decimals: 18 },
            rpcUrls: [...CONFIG.RPC],
            blockExplorerUrls: [CONFIG.EXPLORER],
          },
        ],
      });
      return;
    }
    throw e;
  }
}

/** Balance is read through the tick RPC (same provider as the rest of the page), not through the wallet. */
export async function readBalance(client: RpcClient, address: Address, blockNumber?: bigint): Promise<bigint> {
  return getBalanceAt(client.pub, address, blockNumber ?? 'latest');
}

export function walletClientFor(p: DiscoveredProvider, account: Address): Client {
  return createClient({ account, transport: custom(p.provider) });
}

export type SentTx = { hash: Hex; nonce: number | null };

/**
 * Raw eth_sendTransaction through the wallet (viem's writeContract would pull the whole prepareTransactionRequest
 * pipeline, ~130 KB, into the bundle). `chainId` is included so a wallet whose chain silently changed rejects the
 * request instead of sending it to another network. The sender's pending nonce is read first so the tick can tell a
 * replaced/dropped tx (Speed up / Cancel in the wallet) from one that is still waiting.
 */
export async function sendPitTx(p: DiscoveredProvider, from: Address, data: Hex, to: Address = CONFIG.PIT): Promise<SentTx> {
  let nonce: number | null = null;
  try {
    const n = (await p.provider.request({ method: 'eth_getTransactionCount', params: [from, 'pending'] })) as Hex;
    nonce = Number(BigInt(n));
  } catch {
    nonce = null;
  }
  const hash = (await p.provider.request({
    method: 'eth_sendTransaction',
    params: [{ from, to, data, chainId: CONFIG.chainIdHex } as never],
  })) as Hex;
  return { hash, nonce };
}

export function onProviderEvents(
  provider: EIP1193Provider,
  handlers: { accountsChanged?: (a: Address[]) => void; chainChanged?: (hex: Hex) => void; disconnect?: () => void },
): () => void {
  const p = provider as unknown as {
    on?: (ev: string, cb: (...a: never[]) => void) => void;
    removeListener?: (ev: string, cb: (...a: never[]) => void) => void;
  };
  const ac = (a: Address[]) => handlers.accountsChanged?.(a);
  const cc = (h: Hex) => handlers.chainChanged?.(h);
  const dc = () => handlers.disconnect?.();
  p.on?.('accountsChanged', ac as never);
  p.on?.('chainChanged', cc as never);
  p.on?.('disconnect', dc as never);
  return () => {
    p.removeListener?.('accountsChanged', ac as never);
    p.removeListener?.('chainChanged', cc as never);
    p.removeListener?.('disconnect', dc as never);
  };
}

// ---------- error decoding (§6.4) ----------

export type DecodedError = { name: string | null; sentence: string; raw: string };

/** Every `.data` revert-payload candidate reachable from an error: data, data.data, data.originalError.data (MetaMask),
 *  walking the `cause` chain (viem wraps the RPC error several levels deep). */
export function revertDataCandidates(e: unknown): Hex[] {
  const out: Hex[] = [];
  const seen = new Set<unknown>();
  const push = (v: unknown) => {
    if (typeof v === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(v) && !out.includes(v as Hex)) out.push(v as Hex);
  };
  const visitData = (d: unknown, depth: number) => {
    if (depth > 3 || !d) return;
    push(d);
    if (typeof d === 'object') {
      const o = d as { data?: unknown; originalError?: { data?: unknown } };
      visitData(o.data, depth + 1);
      if (o.originalError) visitData(o.originalError.data, depth + 1);
    }
  };
  let cur: unknown = e;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const o = cur as { data?: unknown; cause?: unknown; error?: unknown; details?: unknown };
    visitData(o.data, 0);
    if (o.error && typeof o.error === 'object') visitData((o.error as { data?: unknown }).data, 0);
    cur = o.cause;
  }
  return out;
}

/** Turn a viem / wallet error into a plain sentence. Custom Pit errors map to the §6.4 list. */
export function describeError(e: unknown): DecodedError {
  const raw = e instanceof Error ? e.message : String(e);
  if (e instanceof BaseError) {
    const rejected = e.walk((err) => err instanceof UserRejectedRequestError);
    if (rejected) return { name: 'UserRejected', sentence: copy.ERR_USER_REJECTED, raw };
    const reverted = e.walk((err) => err instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (reverted) {
      const name = reverted.data?.errorName ?? reverted.reason ?? null;
      const args = (reverted.data?.args ?? []) as readonly unknown[];
      return { name, sentence: sentenceFor(name, args), raw };
    }
  }
  const code = (e as { code?: number })?.code;
  if (code === 4001) return { name: 'UserRejected', sentence: copy.ERR_USER_REJECTED, raw };
  // Wallets and raw RPC errors carry the revert payload as a `.data` string somewhere in the cause chain.
  for (const data of revertDataCandidates(e)) {
    const d = decodeRevertData(data);
    if (d) return { name: d.name, sentence: d.sentence, raw };
  }
  // Last resort: every hex blob in the message (the first one is usually the calldata or the `from` address, so try all).
  for (const m of raw.matchAll(/0x[0-9a-fA-F]{8,}/g)) {
    const d = decodeRevertData(m[0] as Hex);
    if (d) return { name: d.name, sentence: d.sentence, raw };
  }
  return { name: null, sentence: copy.ERR_TX_FAILED, raw };
}

export function decodeRevertData(data: Hex): { name: string; sentence: string } | null {
  try {
    const d = decodeErrorResult({ abi: pixelPitAbi, data });
    return { name: d.errorName, sentence: sentenceFor(d.errorName, d.args ?? []) };
  } catch {
    return null;
  }
}

export function sentenceFor(name: string | null, args: readonly unknown[]): string {
  if (!name) return copy.ERR_TX_FAILED;
  if (name === 'InsufficientBudget') {
    const have = args[0] !== undefined ? String(args[0]) : '?';
    const need = args[1] !== undefined ? String(args[1]) : '?';
    return copy.ERR_INSUFFICIENT_BUDGET(have, need);
  }
  return copy.ERR_SENTENCES[name] ?? copy.ERR_TX_FAILED;
}
