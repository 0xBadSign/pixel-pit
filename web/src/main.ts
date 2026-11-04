// App bootstrap: wires the RPC ticker, log replay, integrity check, deployment check, API light, wallet
// and the hash router. Screens live in ./screens and only read the store.
import './style.css';
import type { Address, Hex } from 'viem';
import { getReceipt, getTransactionCount } from './eth';
import { CONFIG } from './config';
import * as copy from './copy';
import { fmtBlock, fmtInt, fmtUtcHHMM, shortAddr, shortHash } from './format';
import { makeHttpClients, runTick, createTicker, type RpcClient, type TickOk } from './rpc';
import { LogStore, settlementFor, type LogsSnapshot } from './logs';
import { store, type AppState } from './state';
import { checkDeployment, withApiCore } from './deployment-check';
import { createApiPoller } from './api';
import { discoverProviders, connect, switchToSepolia, readBalance, onProviderEvents, LOW_BALANCE_WEI, type DiscoveredProvider } from './wallet';
import { createRouter } from './router';
import { mountTopbar, mountBanners } from './ui/topbar';
import { mountFooter } from './ui/footer';
import { screens, notFound } from './screens';
import { openJoinSheet } from './screens/join';

const app = document.getElementById('app');
if (!app) throw new Error('#app missing');

const clients: RpcClient[] = makeHttpClients(CONFIG.RPC);
const logStore = new LogStore();
let walletAddress: Address | null = null;
let selectedProvider: DiscoveredProvider | null = null;
let providerCleanup: (() => void) | null = null;
const INTEGRITY_D_MISMATCH = 'budgetOf.coreHeight != BatchSettled height';

// ---------- banners from log store ----------
logStore.on((ev) => {
  if (ev.type === 'cache-rebuilt') store.banner('cache-rebuilt', 'info', copy.ERR_CACHE_REBUILT(fmtBlock(ev.fromBlock)));
});

const sameAddr = (a: Address | null | undefined, b: Address | null | undefined): boolean => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** A snapshot whose integrity check (a)-(c) failed is never shown as SETTLED / complete (§6.5). */
function markIntegrityFailed(snap: LogsSnapshot): LogsSnapshot {
  return { ...snap, incomplete: true, integrityFailed: true, failedChunks: Math.max(1, snap.failedChunks) };
}

// ---------- tick ----------
async function tick(): Promise<void> {
  let result = await runTick(clients, { wallet: walletAddress });
  const prev = store.get();
  if (!result.ok) {
    store.set({ tick: result });
    const at = fmtUtcHHMM(result.at);
    if (result.reason === 'stale') store.banner('rpc', 'warn', copy.ERR_RPC_STALE(fmtBlock(result.head), at));
    else store.banner('rpc', 'warn', copy.ERR_RPC_UNREACHABLE(fmtBlock(prev.lastGood?.head ?? null), at));
    return;
  }
  store.clearBanner('rpc');
  const client = clients[result.providerIndex]!;

  // The account changed while this tick was in flight: its budgetOf belongs to the previous account. Drop the
  // budget (UNKNOWN until the re-run that the kick queued) rather than showing it under the new address.
  if (result.pit && !sameAddr(result.wallet, walletAddress)) {
    result = { ...result, pit: { ...result.pit, budget: null }, wallet: walletAddress };
  }

  // logs on the SAME provider as the tick
  const { snapshot } = await logStore.sync(client, result);

  // integrity (a)-(d) at pinned block B
  const integ = logStore.integrity(result, snapshot);
  let finalSnapshot = snapshot;
  if (integ.checked && !integ.ok) {
    const abcFailed = integ.a === false || integ.b === false || integ.c === false;
    if (abcFailed) {
      console.warn('[integrity] mismatch', integ.detail);
      // Rebuild only from a tick taken on the primary (§6.3: one provider per tick, and Tenderly serves the full
      // range). On a fallback tick the rebuild is postponed; nothing is cleared.
      let rebuilt: LogsSnapshot | null = null;
      if (result.providerIndex === 0) {
        const r = await logStore.rebuild(client, result);
        if (r) {
          const again = logStore.integrity(result, r.snapshot);
          rebuilt = again.checked && again.ok ? r.snapshot : null;
          if (!rebuilt) console.warn('[integrity] still failing after rebuild', again.detail);
        }
      }
      finalSnapshot = rebuilt ?? markIntegrityFailed(snapshot);
    }
    if (integ.d === false) {
      store.banner('deployment', 'error', copy.DEPLOYMENT_CHANGED);
      store.set((s) => (s.deployment.status === 'ok' ? { deployment: { ...s.deployment, status: 'changed', mismatches: [...s.deployment.mismatches, INTEGRITY_D_MISMATCH] } } : {}));
    }
  }

  // height tracking + labels. A tick from a provider whose head is BEHIND the last good head (failover to a lagging
  // node) must not move lastGood or the height backwards: compare heights only when the head moved forward.
  const behind = prev.lastGood !== null && result.head < prev.lastGood.head;
  const H = result.state.blockHeight;
  const hit = settlementFor(finalSnapshot.settled.filter((s) => s.blockNumber <= result.head), H);
  const patch: Partial<AppState> = { tick: result, logs: finalSnapshot };
  if (!behind) {
    patch.lastGood = result;
    patch.lastKnownHeight = H;
    patch.heightSettledAtBlock = hit ? hit.log.blockNumber : prev.lastKnownHeight === H ? prev.heightSettledAtBlock : null;
    if (prev.lastKnownHeight !== null && H < prev.lastKnownHeight) {
      patch.heightMovedBack = { now: H, was: prev.lastKnownHeight };
      store.banner('height-back', 'warn', copy.HEIGHT_BACKWARDS(fmtInt(H), fmtInt(prev.lastKnownHeight)));
    } else if (prev.heightMovedBack && H >= prev.heightMovedBack.was) {
      patch.heightMovedBack = null;
      store.clearBanner('height-back');
    }
  }
  store.set(patch);

  if (result.state.paused) store.banner('paused', 'warn', copy.CORE_PAUSED);
  else store.clearBanner('paused');

  // the §6.2 check has not succeeded yet (both providers down at load, or still pending): retry on this good tick
  const dep = store.get().deployment;
  if (dep.status === 'checking' || dep.status === 'unreachable') void deploymentCheck();

  // wallet balance through the same provider
  if (walletAddress) {
    try {
      const bal = await readBalance(client, walletAddress, result.head);
      const addr = walletAddress;
      store.set((s) => (s.wallet.status === 'connected' && sameAddr(s.wallet.address, addr) ? { wallet: { ...s.wallet, balanceWei: bal, lowBalance: bal < LOW_BALANCE_WEI } } : {}));
    } catch {
      /* balance stays as is */
    }
  }

  // pending tx: the lock releases only once budgetOf was read AT OR AFTER the tx block (§2.4 / §6.3: receipt, then
  // budgetOf re-read). A receipt newer than this tick's head keeps the lock and re-runs the tick.
  const pending = store.get().pendingTx;
  if (pending) {
    try {
      const rc = await getReceipt(client.pub, pending.hash);
      if (rc) {
        if (rc.blockNumber <= result.head) {
          store.set({ pendingTx: null });
          if (rc.status === 'reverted') store.banner('tx', 'error', `${copy.ERR_TX_FAILED} (tx ${shortHash(pending.hash)} reverted)`);
          else store.clearBanner('tx');
        } else {
          setTimeout(() => ticker.kick(), 1500);
        }
      } else if (pending.from && pending.nonce !== null && pending.nonce !== undefined) {
        // no receipt but the nonce was consumed: the wallet replaced (Speed up / Cancel) or dropped the tx
        const count = await getTransactionCount(client.pub, pending.from, result.head);
        if (count > pending.nonce) {
          store.set({ pendingTx: null });
          store.banner('tx', 'warn', `tx ${shortHash(pending.hash)} was replaced or dropped by the wallet; nothing is counted until a Painted/Joined log is seen`);
          setTimeout(() => ticker.kick(), 1500);
        }
      }
    } catch {
      /* not mined yet / provider hiccup: keep the lock */
    }
  }
}

const ticker = createTicker({ run: tick });

// ---------- deployment check ----------
let depCheckInFlight = false;
async function deploymentCheck(): Promise<void> {
  if (depCheckInFlight) return;
  depCheckInFlight = true;
  try {
    let d = await checkDeployment(clients[0]!, CONFIG, store.get().api.coreAddress);
    if (d.status === 'unreachable' && clients[1]) d = await checkDeployment(clients[1], CONFIG, store.get().api.coreAddress);
    // keep a 'changed' that integrity (d) already established: a later ok from the RPC check does not clear it
    const prevDep = store.get().deployment;
    if ((d.status === 'ok' || d.status === 'changed') && prevDep.status === 'changed' && prevDep.mismatches.includes(INTEGRITY_D_MISMATCH)) {
      d = { ...d, status: 'changed', mismatches: [...d.mismatches, INTEGRITY_D_MISMATCH] };
    }
    store.set({ deployment: d });
    if (d.status === 'changed') {
      const got = d.impl && d.impl.toLowerCase() !== CONFIG.EXPECTED_IMPL.toLowerCase() ? shortAddr(d.impl) : d.apiCore && d.apiMismatch ? `API ${shortAddr(d.apiCore)}` : 'mismatch';
      store.banner('deployment', 'error', `${copy.ERR_DEPLOYMENT_CHANGED_SHORT(got)}. ${copy.DEPLOYMENT_CHANGED}`);
    } else if (d.status === 'ok') {
      store.clearBanner('deployment');
    }
  } finally {
    depCheckInFlight = false;
  }
}

// ---------- api light ----------
const api = createApiPoller({
  onState(s) {
    const prevCore = store.get().api.coreAddress;
    store.set({ api: s });
    if (s.coreAddress !== prevCore) {
      store.set((st) => ({ deployment: withApiCore(st.deployment, s.coreAddress) }));
      const d = store.get().deployment;
      if (d.status === 'changed' && d.apiMismatch && d.apiCore) store.banner('deployment', 'error', `${copy.DEPCHECK_CHANGED_API(shortAddr(d.apiCore))}. ${copy.DEPLOYMENT_CHANGED}`);
      else if (d.status === 'ok') store.clearBanner('deployment');
    }
  },
});

// ---------- wallet ----------
discoverProviders((providers) => {
  store.set((s) => ({ wallet: { ...s.wallet, providers } }));
});

let closeJoinSheet: (() => void) | null = null;
/** §6.4 Join sheet (modal, from every route): EIP-6963 list → chain → balance → crew → §7.3 text → JOIN. */
function showJoinSheet(): void {
  closeJoinSheet?.();
  const close = openJoinSheet({ store, actions });
  const mine = (): void => {
    close();
    if (closeJoinSheet === mine) closeJoinSheet = null;
  };
  closeJoinSheet = mine;
}

async function connectWallet(p?: DiscoveredProvider): Promise<void> {
  const s = store.get();
  const list = s.wallet.providers;
  const chosen = p ?? (list.length === 1 ? list[0] : null);
  if (!chosen) {
    if (list.length === 0) {
      store.banner('wallet', 'warn', copy.ERR_NO_WALLET);
      return;
    }
    // several wallets announced and none chosen: the user picks in the Join sheet (never silently providers[0])
    showJoinSheet();
    return;
  }
  try {
    const { address, chainId } = await connect(chosen);
    selectedProvider = chosen;
    walletAddress = address;
    providerCleanup?.();
    providerCleanup = onProviderEvents(chosen.provider, {
      accountsChanged: (a) => {
        if (!a[0]) return disconnectWallet();
        walletAddress = a[0];
        // the previous account's balance, budget and pending lock are not the new account's
        store.set((st) => (st.wallet.status === 'connected' ? { wallet: { ...st.wallet, address: a[0] as Address, balanceWei: null }, pendingTx: null, queue: { cells: [], colors: [] } } : {}));
        ticker.kick();
      },
      chainChanged: (hex: Hex) => {
        const id = Number(BigInt(hex));
        store.set((st) => (st.wallet.status === 'connected' ? { wallet: { ...st.wallet, chainId: id, wrongNetwork: id !== CONFIG.chainId } } : {}));
      },
      disconnect: () => disconnectWallet(),
    });
    store.clearBanner('wallet');
    store.set((st) => ({
      wallet: { status: 'connected', providers: st.wallet.providers, selected: chosen, address, chainId, wrongNetwork: chainId !== CONFIG.chainId, balanceWei: null, lowBalance: false },
    }));
    ticker.kick();
  } catch (e) {
    console.warn('[wallet] connect failed', e);
  }
}

function disconnectWallet(): void {
  providerCleanup?.();
  providerCleanup = null;
  selectedProvider = null;
  walletAddress = null;
  store.set((st) => ({ wallet: { status: 'disconnected', providers: st.wallet.providers }, pendingTx: null, queue: { cells: [], colors: [] } }));
}

async function switchChain(): Promise<void> {
  if (!selectedProvider) return;
  try {
    await switchToSepolia(selectedProvider.provider);
  } catch (e) {
    console.warn('[wallet] switch failed', e);
  }
}

// Expose the actions screens need without importing main.ts (avoids a cycle).
export type Actions = { connectWallet: typeof connectWallet; disconnectWallet: typeof disconnectWallet; switchChain: typeof switchChain; kick: () => void; clients: RpcClient[]; logStore: LogStore };
const actions: Actions = { connectWallet, disconnectWallet, switchChain, kick: () => ticker.kick(), clients, logStore };
(window as unknown as { pit: Actions }).pit = actions;

// ---------- mount ----------
const root = document.createElement('main');
root.className = 'screen';
app.append(root);
mountTopbar(app, store, {
  // Top-bar Connect opens the §6.4 Join sheet (wallet list, crew pick, §7.3 text, JOIN) from every route; the Play
  // rail keeps its own card. With exactly one wallet and nothing to join, a plain connect is enough.
  connect: () => {
    const s = store.get();
    const joined = s.lastGood?.pit?.budget?.joined === true && s.wallet.status === 'connected';
    if (s.wallet.providers.length > 1 || !joined) showJoinSheet();
    else void connectWallet();
  },
  switchChain: () => void switchChain(),
  acknowledgeDeployment: () => store.set({ deploymentAcknowledged: true }),
});
mountBanners(app, store);
mountFooter();
const router = createRouter(root, store, screens, notFound);
router.onChange(() => closeJoinSheet?.());
router.start();

// ---------- go ----------
void (async () => {
  await logStore.loadInitial();
  ticker.start();
  api.start();
  void deploymentCheck();
})();

export { store, logStore, clients };
export type { TickOk };
