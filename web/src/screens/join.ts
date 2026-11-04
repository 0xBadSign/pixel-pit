// Join card (Play right rail) + Join sheet (modal, any route), SPEC §2.2, §2.3, §6.4 "Join sheet", §7.3.
// Flow: EIP-6963 list -> chain check -> balance / faucets -> crew pick -> §7.3 text -> JOIN -> "Joined at Squeek
// block H as Crew" + tx link. Every string comes from copy.ts; the few structural words that are not in §7 are
// collected in LOCAL below so the integrator can hoist them.
import { encodeFunctionData, type Hex } from 'viem';
import { CONFIG, CREW_NAMES, CREW_COLORS, crewName } from '../config';
import * as copy from '../copy';
import { el, div, button, clear, fmtEth, fmtInt, shortAddr, shortHash } from '../format';
import { blockLabel, type AppState, type Store } from '../state';
import { pixelPitAbi } from '../abi';
import { describeError, sendPitTx, type DiscoveredProvider, type SentTx } from '../wallet';
import type { RpcClient } from '../rpc';

// ---------- actions exposed by main.ts on window.pit (no import of main.ts: avoids a cycle) ----------

export type PitActions = {
  connectWallet: (p?: DiscoveredProvider) => Promise<void>;
  disconnectWallet: () => void;
  switchChain: () => Promise<void>;
  kick: () => void;
  clients: RpcClient[];
};

export function getActions(): PitActions | null {
  if (typeof window === 'undefined') return null;
  return (window as unknown as { pit?: PitActions }).pit ?? null;
}

/** Structural words not in SPEC §7 (factual, no claims). Listed in the task result for the integrator. */
export const LOCAL = {
  join: 'Join',
  joinButton: 'JOIN',
  chooseWallet: 'Choose a wallet',
  wallet: 'wallet',
  balance: 'balance',
  chooseCrew: 'Choose your crew',
  chooseCrewFirst: 'choose a crew',
  close: 'Close',
  txArrow: 'tx ↗',
  joinedNoLog: 'joined (Joined event not in the loaded logs)',
} as const;

// ---------- small shared helpers (also used by play.ts) ----------

export function txLink(hash: Hex): HTMLAnchorElement {
  return el('a', { class: 'mono', href: `${CONFIG.EXPLORER}/tx/${hash}`, target: '_blank', rel: 'noopener noreferrer', title: hash }, LOCAL.txArrow);
}

export function tag(label: 'SETTLED' | 'FRESH' | 'PENDING' | 'PROVISIONAL' | 'UNKNOWN' | 'INCOMPLETE' | 'PRACTICE' | 'FORFEITED'): HTMLElement {
  // §6.5: FRESH carries the "not yet safe" tooltip everywhere it appears
  return el('span', { class: `tag tag-${label.toLowerCase()}`, title: label === copy.LABEL_FRESH ? copy.TOOLTIP_NOT_YET_SAFE : undefined, text: label });
}

/** Wallet of the connected account, or null. */
export function connectedWallet(s: AppState): Extract<AppState['wallet'], { status: 'connected' }> | null {
  return s.wallet.status === 'connected' ? s.wallet : null;
}

/**
 * budgetOf(me) from the last good tick, and ONLY when that tick read budgetOf for the wallet that is connected now.
 * After accountsChanged the previous account's numbers are never shown as the new account's (null => UNKNOWN).
 */
export function budgetOf(s: AppState) {
  const t = s.lastGood;
  const w = connectedWallet(s);
  if (!t || !t.pit || !w) return null;
  if (!t.wallet || t.wallet.toLowerCase() !== w.address.toLowerCase()) return null;
  return t.pit.budget ?? null;
}

/** Why JOIN is closed right now, or null when it can be sent. Deployment changed keeps Join closed even after "I understand" (§6.2). */
export function joinDisabledReason(s: AppState, crew: number | null): string | null {
  const w = connectedWallet(s);
  if (!w) return copy.REASON_NO_WALLET;
  if (w.wrongNetwork) return copy.REASON_WRONG_NETWORK;
  if (s.deployment.status === 'changed') return copy.REASON_DEPLOYMENT_CHANGED;
  if (!s.tick || !s.tick.ok || !s.lastGood?.pit) return copy.REASON_CORE_UNREACHABLE;
  const b = budgetOf(s);
  if (!b || !b.coreOk) return copy.REASON_CORE_UNREACHABLE;
  if (b.joined) return copy.ERR_SENTENCES.AlreadyJoined ?? copy.ERR_TX_FAILED;
  if (s.pendingTx) return copy.REASON_WAITING_TX(shortHash(s.pendingTx.hash));
  if (crew === null) return LOCAL.chooseCrewFirst;
  return null;
}

export async function sendJoin(s: AppState, crew: number): Promise<SentTx> {
  const w = connectedWallet(s);
  if (!w) throw new Error(copy.REASON_NO_WALLET);
  // raw eth_sendTransaction with chainId + pending nonce (wallet.ts sendPitTx); the wallet fills gas.
  const data = encodeFunctionData({ abi: pixelPitAbi, functionName: 'join', args: [crew] });
  return sendPitTx(w.selected, w.address, data);
}

/** Test seams may return a bare hash. */
export function asSent(v: Hex | SentTx): SentTx {
  return typeof v === 'string' ? { hash: v, nonce: null } : v;
}

// ---------- the join body (shared by the rail card and the modal sheet) ----------

export type JoinContext = {
  store: Store;
  actions: PitActions | null;
  send?: (s: AppState, crew: number) => Promise<Hex | SentTx>; // test seam
};

type JoinLocal = { crew: number | null; txHash: Hex | null; error: string | null; sending: boolean };

export function createJoinBody(container: HTMLElement, ctx: JoinContext): { render: (s: AppState) => void; local: JoinLocal } {
  const local: JoinLocal = { crew: null, txHash: null, error: null, sending: false };

  const render = (s: AppState): void => {
    clear(container);
    container.className = 'join-body';
    const w = connectedWallet(s);
    const b = budgetOf(s);

    // already joined: the Joined line and nothing else
    if (w && b && b.coreOk && b.joined) {
      container.dataset.state = 'joined';
      const ev = s.logs?.joined.find((j) => j.player.toLowerCase() === w.address.toLowerCase());
      if (ev && s.lastGood) {
        container.append(
          div('join-done', el('span', { class: 'mono' }, `${LOCAL.wallet} ${shortAddr(w.address)} · `), tag(blockLabel(ev.blockNumber, s.lastGood.safe)), ' ', copy.FEED_JOINED(fmtInt(ev.coreHeight), crewName(ev.crew)), ' ', txLink(ev.txHash)),
        );
      } else {
        container.append(div('join-done muted', tag(s.logs?.incomplete ? copy.LABEL_INCOMPLETE : copy.LABEL_UNKNOWN), ' ', LOCAL.joinedNoLog));
      }
      return;
    }

    // sent, not mined
    if (local.txHash && s.pendingTx && s.pendingTx.hash === local.txHash) {
      container.dataset.state = 'pending';
      container.append(div('join-pending', tag(copy.LABEL_PENDING), ' ', copy.WORD_PENDING_SENT, ' ', txLink(local.txHash)));
      return;
    }

    container.dataset.state = 'open';
    // 1) wallet
    const walletBox = div('join-step join-wallet');
    if (!w) {
      walletBox.append(div('join-step-title', LOCAL.chooseWallet));
      const providers = s.wallet.providers;
      if (providers.length === 0) {
        walletBox.append(div('muted', copy.ERR_NO_WALLET));
      } else {
        const list = div('provider-list');
        for (const p of providers) {
          const btn = el('button', { type: 'button', class: 'btn provider-btn', 'data-rdns': p.info.rdns });
          if (p.info.icon) btn.append(el('img', { src: p.info.icon, alt: '', width: '18', height: '18' }));
          btn.append(p.info.name);
          btn.onclick = () => void ctx.actions?.connectWallet(p);
          list.append(btn);
        }
        walletBox.append(list);
      }
    } else {
      walletBox.append(div('mono', `${LOCAL.wallet} ${shortAddr(w.address)}`));
      if (w.wrongNetwork) {
        const sw = button(`${copy.ERR_WRONG_NETWORK} · ${copy.WALLET_SWITCH}`, () => void ctx.actions?.switchChain(), false, 'btn btn-red');
        walletBox.append(sw);
      }
      // 2) balance / faucets (balance comes from the tick provider at the pinned block; FRESH)
      const bal = w.balanceWei === null ? tag(copy.LABEL_UNKNOWN) : el('span', {}, `${fmtEth(w.balanceWei)} ETH `, tag(copy.LABEL_FRESH));
      walletBox.append(div('join-balance', `${LOCAL.balance}: `, bal));
      if (w.lowBalance) {
        const f = div('faucets', div('muted', copy.WALLET_LOW_BALANCE));
        for (const x of copy.FAUCETS) f.append(el('a', { href: x.url, target: '_blank', rel: 'noopener noreferrer' }, x.name), ' ');
        walletBox.append(f);
      }
    }
    container.append(walletBox);

    // 3) crew pick
    const crewBox = div('join-step join-crews', div('join-step-title', LOCAL.chooseCrew));
    const row = div('crew-row');
    CREW_NAMES.forEach((name, i) => {
      const btn = el('button', { type: 'button', class: 'btn crew-btn', 'data-crew': String(i), 'aria-pressed': local.crew === i ? 'true' : 'false' });
      btn.style.setProperty('--crew', CREW_COLORS[i] ?? '#fff');
      btn.append(el('span', { class: 'crew-dot' }), name);
      btn.onclick = () => {
        local.crew = i;
        render(ctx.store.get());
      };
      row.append(btn);
    });
    crewBox.append(row);
    container.append(crewBox);

    // 4) §7.3 text
    container.append(el('p', { class: 'join-text', text: copy.JOIN_BUDGET_P1 }), el('p', { class: 'join-text', text: copy.JOIN_BUDGET_P2 }));

    // 5) JOIN
    const reason = joinDisabledReason(s, local.crew);
    // wrong network does not disable JOIN: pressing it asks the wallet to switch to Sepolia first (nothing is sent before that)
    const wrongNet = reason === copy.REASON_WRONG_NETWORK;
    const btn = button(LOCAL.joinButton, () => void doJoin(), (reason !== null && !wrongNet) || local.sending, 'btn btn-primary join-btn');
    const why = div('reason muted', reason ?? '');
    container.append(div('join-actions', btn, why));
    if (local.error) container.append(el('div', { class: 'error', role: 'alert', text: local.error }));
  };

  const doJoin = async (): Promise<void> => {
    let s = ctx.store.get();
    if (local.crew !== null && joinDisabledReason(s, local.crew) === copy.REASON_WRONG_NETWORK) {
      await ctx.actions?.switchChain();
      s = ctx.store.get();
    }
    if (local.crew === null || joinDisabledReason(s, local.crew) !== null) return;
    local.sending = true;
    local.error = null;
    render(s);
    try {
      const sent = asSent(await (ctx.send ?? sendJoin)(s, local.crew));
      local.txHash = sent.hash;
      // a join is a Pit tx of this wallet: Paint stays locked until it is mined (§6.3 pending lock)
      const from = connectedWallet(s)?.address;
      ctx.store.set({ pendingTx: { hash: sent.hash, cells: [], colors: [], sentAt: Date.now(), from, nonce: sent.nonce } });
      ctx.actions?.kick();
    } catch (e) {
      local.error = describeError(e).sentence;
    } finally {
      local.sending = false;
      render(ctx.store.get());
    }
  };

  return { render, local };
}

/** Rail card (Play): the full card until the connected wallet has joined, then one line (wallet · Joined at …). */
export function mountJoinCard(container: HTMLElement, ctx: JoinContext): { render: (s: AppState) => void } {
  container.className = 'card join-card';
  const body = el('div');
  container.append(el('summary', {}, el('h3', { text: LOCAL.join })), body); // <summary>: play.ts mounts it in a <details>
  const inner = createJoinBody(body, ctx);
  return {
    render(s: AppState) {
      const w = connectedWallet(s);
      const b = budgetOf(s);
      container.classList.toggle('join-collapsed', !!(w && b && b.coreOk && b.joined));
      inner.render(s);
    },
  };
}

/** Modal sheet (any route). Returns a close function. Esc and the backdrop close it. */
export function openJoinSheet(ctx: JoinContext): () => void {
  const backdrop = el('div', { class: 'sheet-backdrop', role: 'presentation' });
  const sheet = el('div', { class: 'sheet join-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': LOCAL.join });
  const head = div('sheet-head', el('h3', { text: LOCAL.join }));
  const closeBtn = button(LOCAL.close, () => close());
  head.append(closeBtn);
  const body = el('div');
  sheet.append(head, body);
  backdrop.append(sheet);
  document.body.append(backdrop);
  const inner = createJoinBody(body, ctx);
  inner.render(ctx.store.get());
  const unsub = ctx.store.subscribe((s) => inner.render(s));
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') close();
  };
  const close = () => {
    unsub();
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
  };
  backdrop.onclick = (ev) => {
    if (ev.target === backdrop) close();
  };
  document.addEventListener('keydown', onKey);
  return close;
}
