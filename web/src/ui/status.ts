// Top-bar chips (SPEC §6.4 TOP BAR, §6.2 badge): deployment badge (+ api /v1/core comparison), Squeek block
// chip with FRESH/SETTLED, paused chip, RPC dot, wallet button.
import * as copy from '../copy';
import { CONFIG } from '../config';
import { fmtBlock, fmtInt, fmtUtcHHMM, fmtEth, shortAddr, el, clear } from '../format';
import { heightLabel, type AppState, type Store } from '../state';

export type StatusActions = {
  connect: () => void;
  switchChain: () => void;
  acknowledgeDeployment: () => void;
};

export function mountStatus(container: HTMLElement, store: Store, actions: StatusActions): () => void {
  container.className = 'chips';
  const render = (s: AppState) => {
    clear(container);
    container.append(deploymentChip(s, actions), heightChip(s), pausedChip(s), rpcDot(s), walletButton(s, actions));
  };
  render(store.get());
  return store.subscribe(render);
}

function deploymentChip(s: AppState, actions: StatusActions): HTMLElement {
  const d = s.deployment;
  const wrap = el('span', { class: 'chip-group' });
  if (d.status === 'checking') {
    wrap.append(el('span', { class: 'chip chip-grey', text: copy.DEPCHECK_CHECKING }));
    return wrap;
  }
  if (d.status === 'unreachable') {
    wrap.append(el('span', { class: 'chip chip-grey', title: d.error, text: `${copy.LABEL_UNKNOWN} · ${copy.DEPCHECK_CORE_UNREACHABLE}` }));
    return wrap;
  }
  if (d.status === 'ok') {
    wrap.append(
      el('span', { class: 'chip chip-green', title: `impl ${d.impl ?? '?'} · runtime ${d.runtimeHash ?? '?'}`, text: copy.DEPCHECK_OK(shortAddr(CONFIG.CORE), shortAddr(CONFIG.EXPECTED_IMPL)) }),
    );
  } else {
    const text = d.apiMismatch && d.mismatches.length === 0 && d.apiCore ? copy.DEPCHECK_CHANGED_API(shortAddr(d.apiCore)) : copy.DEPCHECK_CHANGED;
    wrap.append(el('span', { class: 'chip chip-red', title: d.mismatches.join('; ') || 'api address differs', text }));
    if (!s.deploymentAcknowledged) {
      const b = el('button', { class: 'chip chip-btn', type: 'button', text: copy.I_UNDERSTAND });
      b.addEventListener('click', actions.acknowledgeDeployment);
      wrap.append(b);
    }
  }
  // api /v1/core (PROVISIONAL, display only)
  const api = d.apiCore;
  if (api) {
    const match = api.toLowerCase() === CONFIG.CORE.toLowerCase();
    wrap.append(
      el('span', { class: `chip chip-api ${match ? 'chip-green-soft' : 'chip-red'}` }, el('span', { class: 'dot dot-provisional', title: copy.LABEL_PROVISIONAL }), ' ', match ? copy.DEPCHECK_API_MATCH(shortAddr(api)) : copy.DEPCHECK_API_MISMATCH(shortAddr(api))),
    );
  } else {
    wrap.append(el('span', { class: 'chip chip-grey chip-api' }, el('span', { class: 'dot dot-provisional', title: copy.LABEL_PROVISIONAL }), ' ', copy.DEPCHECK_API_UNKNOWN));
  }
  return wrap;
}

function heightChip(s: AppState): HTMLElement {
  const t = s.tick;
  if (!t || !t.ok) {
    const at = t?.at ?? Date.now();
    const title = t && !t.ok ? (t.reason === 'stale' ? copy.ERR_RPC_STALE(fmtBlock(t.head), fmtUtcHHMM(at)) : copy.ERR_RPC_UNREACHABLE(fmtBlock(s.lastGood?.head ?? null), fmtUtcHHMM(at))) : 'waiting for the first tick';
    return el('span', { class: 'chip chip-grey', title }, el('span', { class: 'tag tag-unknown', text: copy.LABEL_UNKNOWN }), ' ', copy.CHIP_UNKNOWN(fmtUtcHHMM(at)));
  }
  const label = heightLabel(s.heightSettledAtBlock, t.safe);
  const h = fmtInt(t.state.blockHeight);
  return el(
    'span',
    { class: 'chip chip-height', title: `safe ${fmtInt(t.safe)} · finalized ${fmtInt(t.finalized)}${t.finalityTags ? '' : ' (head-12 / head-64 fallback)'}` },
    copy.CHIP_SQUEEK_BLOCK(h, fmtBlock(t.head), label).replace(` · ${label}`, ' · '),
    el('span', { class: label === 'SETTLED' ? 'tag tag-settled' : 'tag tag-fresh', text: label }),
  );
}

function pausedChip(s: AppState): HTMLElement | string {
  const t = s.tick;
  if (t && t.ok && t.state.paused) return el('span', { class: 'chip chip-yellow', title: copy.CORE_PAUSED, text: copy.CHIP_PAUSED });
  return '';
}

function rpcDot(s: AppState): HTMLElement {
  const t = s.tick;
  const name = (url: string | null) => (url ? (url.includes('tenderly') ? 'Tenderly' : url.includes('publicnode') ? 'publicnode' : new URL(url).host) : 'RPC');
  if (!t) return el('span', { class: 'chip chip-rpc' }, el('span', { class: 'dot dot-grey' }), ' RPC');
  if (!t.ok) return el('span', { class: 'chip chip-rpc', title: t.error }, el('span', { class: 'dot dot-red' }), ` ${name(t.provider)} · ${t.reason}`);
  return el('span', { class: 'chip chip-rpc', title: t.provider }, el('span', { class: t.providerIndex === 0 ? 'dot dot-green' : 'dot dot-amber' }), ` ${name(t.provider)}`);
}

function walletButton(s: AppState, actions: StatusActions): HTMLElement {
  const w = s.wallet;
  if (w.status !== 'connected') {
    const b = el('button', { class: 'chip chip-btn chip-wallet', type: 'button', text: copy.WALLET_CONNECT });
    b.addEventListener('click', actions.connect);
    return b;
  }
  const wrap = el('span', { class: 'chip-group' });
  if (w.wrongNetwork) {
    const b = el('button', { class: 'chip chip-red chip-btn', type: 'button', text: `${copy.ERR_WRONG_NETWORK} · ${copy.WALLET_SWITCH}` });
    b.addEventListener('click', actions.switchChain);
    wrap.append(b);
  }
  const bal = w.balanceWei === null ? copy.LABEL_UNKNOWN : `${fmtEth(w.balanceWei)} ETH`;
  wrap.append(el('span', { class: `chip chip-wallet ${w.lowBalance ? 'chip-yellow' : ''}`, title: w.address }, `${shortAddr(w.address)} · ${bal}`));
  return wrap;
}
