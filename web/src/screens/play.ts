// #/ PLAY (SPEC §2.1-§2.5, §6.4 PLAY, §7.6, §7.7, §7.12, §7.14). Left: canvas with Live/Practice switch, crew
// map + genesis frame toggles, zoom, hover tooltip, idle status card. Right rail: budget battery (budgetOf only,
// digits only when coreOk), palette (0-9/a-f), queue (Undo/Clear/PAINT with a written reason when closed),
// confirm sheet, Join card, status strip (SETTLED facts + PROVISIONAL light), feed (last 50), top crews.
// Every string comes from copy.ts; structural words that §7 does not define are collected in LOCAL below.
import { encodeFunctionData, type Hex } from 'viem';
import { ethCall, getBlockHeader } from '../eth';
import { CAP, CONFIG, CREW_NAMES, CREW_COLORS, PALETTE, crewName, paletteName } from '../config';
import * as copy from '../copy';
import { el, clear, fmtAgo, fmtBlock, fmtInt, fmtUtcHHMM, shortAddr, shortHash } from '../format';
import { PitCanvas, type HoverInfo, type Zoom } from '../canvas';
import { cellXY, decodeCell, decodeRawCells, genesisFrame } from '../frame';
import { batteryModel, blockLabel, heightLabel, type AppState, type Store } from '../state';
import { renderBattery } from '../ui/battery';
import { coreAbi, pixelPitAbi } from '../abi';
import { describeError, sendPitTx, type SentTx } from '../wallet';
import type { Route } from '../router';
import type { RpcClient, TickOk } from '../rpc';
import { settlementFor, type LogsSnapshot, type PaintedLog } from '../logs';
import { asSent, budgetOf, connectedWallet, getActions, mountJoinCard, tag, txLink, type PitActions } from './join';

export { settlementFor };

// ---------- local structural strings (not in SPEC §7; factual; listed in the result) ----------

export const LOCAL = {
  live: 'Live',
  practice: 'Practice',
  crewMap: 'crew map',
  genesisFrame: 'genesis frame',
  zoom: 'zoom',
  budget: 'Budget',
  palette: 'Palette',
  queue: 'Queue',
  status: 'Status',
  feed: 'Feed',
  topCrews: 'Top crews',
  cellsHeld: 'cells held',
  undo: 'Undo',
  clearQ: 'Clear',
  cancel: 'Cancel',
  confirm: 'Confirm',
  cells: 'cells',
  gasEstimate: 'gas estimate',
  coreHeight: 'Core height',
  settledThrough: 'settledThroughRound',
  lastSettlement: 'last settlement',
  api: 'api.squeekchain.com',
  unpainted: 'unpainted',
  asOfHead: (N: string) => `as of ETH block ${N} (head)`,
  tooltip: (x: number, y: number, color: string, crew: string, who: string, H: string) => `(${x}, ${y}) · ${color} · crew ${crew} · ${who} · Squeek block ${H}`,
  feedPainted: (who: string, n: string, H: string, left: string) => `${who} painted ${n} cells at Squeek block ${H} · budget left ${left}`,
  feedBatch: (H: string, delta: string, round: string) => `BatchSettled: Squeek block ${H} (+${delta}) · round ${round}`,
  feedPendingPaint: (n: string) => `paint ${n} cells`,
  feedPendingJoin: 'join',
  settlementLine: (H: string, delta: string, round: string, N: string) => `Squeek block ${H} (+${delta}) · round ${round} · ETH block ${N}`,
  roundLabel: (r: string) => `round ${r}`,
  apiLine: (status: string) => `${LOCAL.api}: ${status}`,
} as const;

// ---------- pure helpers (exported for tests) ----------

export type Queue = { cells: number[]; colors: number[] };

/** paint() calldata: one entry per cell (last colour wins), cells sorted ascending (SPEC §5.5: same-word cells share one SSTORE). */
export function encodePaintArgs(q: Queue): { cells: number[]; colors: number[] } {
  const last = new Map<number, number>();
  const n = Math.min(q.cells.length, q.colors.length);
  for (let i = 0; i < n; i++) last.set(q.cells[i]!, q.colors[i]! & 0xf);
  const cells = [...last.keys()].sort((a, b) => a - b);
  return { cells, colors: cells.map((c) => last.get(c)!) };
}

/** Add (or recolour) a queued cell; returns the new queue or null when nothing changed. `limit` caps the number of distinct cells. */
export function enqueue(q: Queue, cell: number, color: number, limit: number): Queue | null {
  const i = q.cells.indexOf(cell);
  if (i >= 0) {
    if (q.colors[i] === color) return null;
    const cells = [...q.cells.slice(0, i), ...q.cells.slice(i + 1), cell];
    const colors = [...q.colors.slice(0, i), ...q.colors.slice(i + 1), color];
    return { cells, colors };
  }
  if (q.cells.length >= limit) return null;
  return { cells: [...q.cells, cell], colors: [...q.colors, color] };
}

/** Why PAINT is closed, or null when the queue can be sent. Order follows SPEC §6.4 (the first blocking fact wins). */
export function paintDisabledReason(s: AppState, queued: number): string | null {
  if (s.practice) return copy.PRACTICE_TITLE;
  const w = connectedWallet(s);
  if (!w) return copy.REASON_NO_WALLET;
  if (w.wrongNetwork) return copy.REASON_WRONG_NETWORK;
  // §6.2: the implementation / runtime-hash check must have RUN and passed (or been acknowledged) before a paint is sent
  if (s.deployment.status === 'checking') return copy.DEPCHECK_CHECKING;
  if (s.deployment.status === 'unreachable') return copy.REASON_CORE_UNREACHABLE;
  if (s.deployment.status === 'changed' && !s.deploymentAcknowledged) return copy.REASON_DEPLOYMENT_CHANGED;
  if (!s.tick || !s.tick.ok || !s.lastGood?.pit) return copy.REASON_CORE_UNREACHABLE;
  const b = budgetOf(s); // null when the last tick read another account's budget
  if (!b || !b.coreOk) return copy.REASON_CORE_UNREACHABLE;
  if (!b.joined) return copy.REASON_NOT_JOINED;
  if (s.pendingTx) return copy.REASON_WAITING_TX(shortHash(s.pendingTx.hash));
  if (b.ready === 0) return copy.REASON_BRUSH_EMPTY;
  if (queued === 0) return copy.ERR_SENTENCES.EmptyStroke ?? copy.ERR_TX_FAILED;
  if (queued > b.ready) return copy.ERR_INSUFFICIENT_BUDGET(String(b.ready), String(queued));
  return null;
}

export type FeedItem = { kind: 'Joined' | 'Painted' | 'BatchSettled'; blockNumber: bigint; logIndex: number; txHash: Hex; text: string };

/** Last `limit` Joined/Painted/BatchSettled records, newest first. */
export function feedItems(snap: LogsSnapshot, limit = 50): FeedItem[] {
  const items: FeedItem[] = [];
  for (const j of snap.joined) items.push({ kind: 'Joined', blockNumber: j.blockNumber, logIndex: j.logIndex, txHash: j.txHash, text: `${shortAddr(j.player)} · ${copy.FEED_JOINED(fmtInt(j.coreHeight), crewName(j.crew))}` });
  for (const p of snap.painted) items.push({ kind: 'Painted', blockNumber: p.blockNumber, logIndex: p.logIndex, txHash: p.txHash, text: LOCAL.feedPainted(shortAddr(p.player), String(p.cells.length), fmtInt(p.coreHeight), String(p.budgetLeft)) });
  const settled = snap.settled;
  settled.forEach((b, i) => {
    const prev = i > 0 ? settled[i - 1]!.height : b.height;
    const delta = b.height > prev ? b.height - prev : 0n;
    items.push({ kind: 'BatchSettled', blockNumber: b.blockNumber, logIndex: b.logIndex, txHash: b.txHash, text: LOCAL.feedBatch(fmtInt(b.height), fmtInt(delta), fmtInt(b.settledThroughRound)) });
  });
  items.sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? 1 : -1) : b.logIndex - a.logIndex));
  return items.slice(0, limit);
}

/** cell -> the Painted record that last touched it (for the provenance tooltip). */
export function provenanceIndex(painted: readonly PaintedLog[]): Map<number, PaintedLog> {
  const m = new Map<number, PaintedLog>();
  for (const p of painted) for (const c of p.cells) m.set(c, p);
  return m;
}

/** Flash text without the brush sentence when no budget number exists (no wallet / not joined / UNKNOWN). */
export function flashText(H: bigint, delta: bigint, label: 'fresh' | 'settled', ready: number | null): string {
  const full = copy.FLASH_SETTLED(fmtInt(H), fmtInt(delta), label, ready === null ? '' : String(ready));
  if (ready !== null) return full;
  const cut = full.indexOf(' Your brush');
  return cut > 0 ? full.slice(0, cut) : full;
}

export type PlayDeps = {
  actions?: PitActions | null;
  now?: () => number;
  /** block -> timestamp (seconds); the default reads eth_getBlockByNumber through the tick provider */
  blockTimestamp?: (client: RpcClient | null, block: bigint) => Promise<bigint | null>;
  /** Core.configuration() reader for the derived round line */
  configuration?: (client: RpcClient | null) => Promise<{ genesisTimestamp: bigint; roundDuration: bigint } | null>;
  send?: (s: AppState, args: { cells: number[]; colors: number[] }) => Promise<Hex | SentTx>;
  estimateGas?: (s: AppState, args: { cells: number[]; colors: number[] }) => Promise<bigint>;
};

async function defaultBlockTimestamp(client: RpcClient | null, block: bigint): Promise<bigint | null> {
  if (!client) return null;
  try {
    const b = await getBlockHeader(client.pub, block);
    return b.timestamp;
  } catch {
    return null;
  }
}

async function defaultConfiguration(client: RpcClient | null): Promise<{ genesisTimestamp: bigint; roundDuration: bigint } | null> {
  if (!client) return null;
  try {
    const c = await ethCall(client.pub, { address: CONFIG.CORE, abi: coreAbi, functionName: 'configuration' });
    return { genesisTimestamp: c.genesisTimestamp, roundDuration: c.roundDuration };
  } catch {
    return null;
  }
}

async function defaultSend(s: AppState, args: { cells: number[]; colors: number[] }): Promise<SentTx> {
  const w = connectedWallet(s);
  if (!w) throw new Error(copy.REASON_NO_WALLET);
  // raw eth_sendTransaction with chainId + pending nonce (wallet.ts sendPitTx); the wallet fills gas
  const data = encodeFunctionData({ abi: pixelPitAbi, functionName: 'paint', args: [args.cells, args.colors] });
  return sendPitTx(w.selected, w.address, data);
}

function defaultEstimateGas(actions: PitActions | null) {
  return async (s: AppState, args: { cells: number[]; colors: number[] }): Promise<bigint> => {
    const w = connectedWallet(s);
    const client = actions?.clients[s.lastGood?.providerIndex ?? 0] ?? actions?.clients[0];
    if (!w || !client) throw new Error(copy.REASON_CORE_UNREACHABLE);
    // raw eth_estimateGas on the tick provider; a revert surfaces as RpcRequestError.data and describeError decodes it
    const data = encodeFunctionData({ abi: pixelPitAbi, functionName: 'paint', args: [args.cells, args.colors] });
    const gas = await client.pub.request({ method: 'eth_estimateGas', params: [{ from: w.address, to: CONFIG.PIT, data }] });
    return BigInt(gas);
  };
}

// ---------- mount ----------

export function mount(root: HTMLElement, store: Store, _route?: Route, deps: PlayDeps = {}): () => void {
  injectStyle();
  const actions = deps.actions === undefined ? getActions() : deps.actions;
  const now = deps.now ?? Date.now;
  const timestampOf = deps.blockTimestamp ?? defaultBlockTimestamp;
  const configurationOf = deps.configuration ?? defaultConfiguration;
  const send = deps.send ?? defaultSend;
  const estimate = deps.estimateGas ?? defaultEstimateGas(actions);

  // local (per-mount) state
  let selectedColor = 4;
  let practiceFrame: Uint32Array | null = null;
  let practiceUndo: { cell: number; prev: number }[] = [];
  let showCrew = false;
  let showGenesis = true;
  let liveFrameSrc: TickOk | null | undefined;
  let liveFrame: Uint32Array = genesisFrame(CONFIG.GENESIS_CELLS, CONFIG.GENESIS_COLORS);
  let provSrc: LogsSnapshot | null = null;
  let prov = new Map<number, PaintedLog>();
  const tsCache = new Map<bigint, bigint>();
  const tsPending = new Set<bigint>();
  let roundCfg: { genesisTimestamp: bigint; roundDuration: bigint } | null = null;
  let flash: { height: bigint; block: bigint; node: HTMLElement; timer: ReturnType<typeof setTimeout>; label: 'fresh' | 'settled'; delta: bigint } | null = null;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;
  let freshHead: bigint | null = null; // head of the last Live canvas render (ripple gating)
  let lastError: string | null = null;
  let queueHint: string | null = null;
  let sheet: { close: () => void; render: (s: AppState) => void } | null = null;
  let disposed = false;

  const clientFor = (s: AppState): RpcClient | null => actions?.clients[s.lastGood?.providerIndex ?? 0] ?? actions?.clients[0] ?? null;

  // ---------- DOM skeleton ----------
  const section = el('section', { class: 'play' });
  const left = el('div', { class: 'play-left' });
  const rail = el('aside', { class: 'play-rail' });
  section.append(left, rail);
  root.append(section);

  // left: tools
  const tools = el('div', { class: 'play-tools', role: 'toolbar' });
  const liveBtn = el('button', { type: 'button', class: 'btn mode-btn', 'data-mode': 'live', text: LOCAL.live });
  const practiceBtn = el('button', { type: 'button', class: 'btn mode-btn', 'data-mode': 'practice', text: LOCAL.practice });
  const crewToggle = el('input', { type: 'checkbox', id: 'play-crew' });
  const genesisToggle = el('input', { type: 'checkbox', id: 'play-genesis', checked: true });
  const zoomBox = el('span', { class: 'zoom-box' }, `${LOCAL.zoom} `);
  const zoomBtns: HTMLButtonElement[] = ([1, 2, 4] as Zoom[]).map((z) => el('button', { type: 'button', class: 'btn zoom-btn', 'data-zoom': String(z), text: `${z}x` }));
  zoomBox.append(...zoomBtns);
  tools.append(
    el('span', { class: 'mode-switch' }, liveBtn, practiceBtn),
    el('label', { class: 'toggle', for: 'play-crew' }, crewToggle, ` ${LOCAL.crewMap}`),
    el('label', { class: 'toggle', for: 'play-genesis' }, genesisToggle, ` ${LOCAL.genesisFrame}`),
    zoomBox,
  );
  const practiceTitle = el('div', { class: 'practice-title', hidden: true }, tag('PRACTICE'), ' ', copy.PRACTICE_TITLE);
  const canvasWrap = el('div', { class: 'canvas-wrap' });
  const tooltip = el('div', { class: 'tooltip', role: 'tooltip', hidden: true });
  const statusCard = el('div', { class: 'card status-card', 'aria-live': 'polite' });
  const seasonLine = el('div', { class: 'season-line muted' });
  left.append(tools, practiceTitle, canvasWrap, tooltip, statusCard, seasonLine);

  // rail
  const batteryBox = el('div', { class: 'battery' });
  const batteryExtra = el('div', { class: 'battery-extra muted' });
  const paletteBox = el('div', { class: 'palette', role: 'listbox', 'aria-label': LOCAL.palette });
  const queueBox = el('div', { class: 'queue' });
  const joinCardBox = el('section');
  const stripBox = el('div', { class: 'strip' });
  const feedBox = el('ol', { class: 'feed' });
  const completeLine = el('div', { class: 'complete-line muted' });
  const crewsBox = el('div', { class: 'crews' });
  rail.append(
    el('section', { class: 'card' }, el('h3', { text: LOCAL.budget }), batteryBox, batteryExtra),
    el('section', { class: 'card' }, el('h3', { text: LOCAL.palette }), paletteBox),
    el('section', { class: 'card' }, el('h3', { text: LOCAL.queue }), queueBox),
    joinCardBox,
    el('section', { class: 'card' }, el('h3', { text: LOCAL.status }), stripBox),
    el('section', { class: 'card' }, el('h3', { text: LOCAL.feed }), feedBox, completeLine),
    el('section', { class: 'card' }, el('h3', { text: LOCAL.topCrews }), crewsBox),
  );
  const joinCard = mountJoinCard(joinCardBox, { store, actions });

  // canvas
  const canvas = new PitCanvas(canvasWrap, { showGenesisFrame: true, showCrewTint: false });
  canvas.onHoverCell((h) => renderTooltip(h, store.get()));
  canvas.onCellClick((cell) => onCell(cell));
  canvas.onCellDrag((cell) => onCell(cell));

  // ---------- frame sources ----------
  const currentLiveFrame = (s: AppState): Uint32Array => {
    if (s.lastGood !== liveFrameSrc) {
      liveFrameSrc = s.lastGood;
      const pit = s.lastGood?.pit;
      if (pit) {
        try {
          liveFrame = decodeRawCells(pit.rawCells);
        } catch {
          /* keep the previous frame */
        }
      }
    }
    return liveFrame;
  };
  const provenance = (s: AppState): Map<number, PaintedLog> => {
    if (s.logs !== provSrc) {
      provSrc = s.logs;
      prov = provenanceIndex(s.logs?.painted ?? []);
    }
    return prov;
  };
  const freshCells = (s: AppState): Set<number> => {
    const out = new Set<number>();
    const t = s.lastGood;
    if (!t || !s.logs) return out;
    for (const p of s.logs.painted) if (p.blockNumber > t.safe) for (const c of p.cells) out.add(c);
    return out;
  };
  const pendingCells = (s: AppState): Map<number, number> => {
    const m = new Map<number, number>();
    const q = s.queue;
    for (let i = 0; i < q.cells.length; i++) m.set(q.cells[i]!, q.colors[i]!);
    if (s.pendingTx) for (let i = 0; i < s.pendingTx.cells.length; i++) m.set(s.pendingTx.cells[i]!, s.pendingTx.colors[i]!);
    return m;
  };

  // ---------- interactions ----------
  const onCell = (cell: number): void => {
    const s = store.get();
    if (s.practice) {
      if (!practiceFrame) practiceFrame = new Uint32Array(currentLiveFrame(s));
      const prev = practiceFrame[cell]!;
      const next = (prev & ~0xf) | (selectedColor & 0xf);
      if (prev === next) return;
      practiceUndo.push({ cell, prev });
      practiceFrame[cell] = next;
      canvas.setFrame(practiceFrame);
      renderQueue(s);
      return;
    }
    // Live canvas: queueing is for joined wallets only (Practice is the free sandbox). Otherwise point at the Join card.
    const w = connectedWallet(s);
    const b = budgetOf(s);
    const gate = !w ? copy.REASON_NO_WALLET : w.wrongNetwork ? copy.REASON_WRONG_NETWORK : b && b.coreOk && !b.joined ? copy.REASON_NOT_JOINED : null;
    if (gate) {
      queueHint = gate;
      renderQueue(s);
      joinCardBox.classList.remove('nudge');
      void joinCardBox.offsetWidth; // restart the nudge animation
      joinCardBox.classList.add('nudge');
      joinCardBox.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    queueHint = null;
    const limit = b && b.coreOk && b.joined ? Math.min(CAP, b.ready) : CAP;
    const q = enqueue(s.queue, cell, selectedColor, limit);
    if (q) store.set({ queue: q });
  };

  const setPractice = (on: boolean): void => {
    const s = store.get();
    if (on === s.practice) return;
    if (on) {
      practiceFrame = new Uint32Array(currentLiveFrame(s));
      practiceUndo = [];
    } else {
      practiceFrame = null; // discarded, nothing was ever sent
      practiceUndo = [];
    }
    store.set({ practice: on });
  };
  liveBtn.addEventListener('click', () => setPractice(false));
  practiceBtn.addEventListener('click', () => setPractice(true));
  crewToggle.addEventListener('change', () => {
    showCrew = crewToggle.checked;
    canvas.setCrewTint(showCrew);
  });
  genesisToggle.addEventListener('change', () => {
    showGenesis = genesisToggle.checked;
    canvas.setGenesisFrame(showGenesis);
  });
  for (const b of zoomBtns) b.addEventListener('click', () => {
    canvas.setZoom(Number(b.dataset.zoom) as Zoom);
    renderTools();
  });

  const onKey = (ev: KeyboardEvent): void => {
    const t = ev.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    if (ev.key === 'Escape') {
      sheet?.close();
      return;
    }
    const k = ev.key.toLowerCase();
    if (/^[0-9a-f]$/.test(k)) {
      selectedColor = parseInt(k, 16);
      renderPalette();
      ev.preventDefault();
    }
  };
  document.addEventListener('keydown', onKey);

  const undo = (): void => {
    const s = store.get();
    if (s.practice) {
      const u = practiceUndo.pop();
      if (u && practiceFrame) {
        practiceFrame[u.cell] = u.prev;
        canvas.setFrame(practiceFrame);
      }
      renderQueue(s);
      return;
    }
    if (s.queue.cells.length === 0) return;
    store.set({ queue: { cells: s.queue.cells.slice(0, -1), colors: s.queue.colors.slice(0, -1) } });
  };
  const clearQueue = (): void => {
    const s = store.get();
    if (s.practice) {
      practiceFrame = new Uint32Array(currentLiveFrame(s));
      practiceUndo = [];
      canvas.setFrame(practiceFrame);
      renderQueue(s);
      return;
    }
    store.set({ queue: { cells: [], colors: [] } });
  };

  // ---------- confirm sheet + write path ----------
  const openConfirm = (): void => {
    const s0 = store.get();
    const args = encodePaintArgs(s0.queue);
    if (paintDisabledReason(s0, args.cells.length) !== null) return;
    let gas: bigint | null | 'failed' = null;
    let gasError: string | null = null;
    let sending = false;
    const backdrop = el('div', { class: 'sheet-backdrop', role: 'presentation' });
    const box = el('div', { class: 'sheet paint-sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': copy.PAINT_N(String(args.cells.length)) });
    backdrop.append(box);
    document.body.append(backdrop);
    const render = (s: AppState): void => {
      clear(box);
      const reason = paintDisabledReason(s, args.cells.length);
      const gasLine =
        gas === null
          ? el('span', {}, tag('UNKNOWN'), ' …')
          : gas === 'failed'
            ? el('span', {}, tag('UNKNOWN'), ` ${gasError ?? copy.ERR_TX_FAILED}`)
            : el('span', {}, `~${fmtInt(gas)} `, tag('FRESH'));
      const cancel = el('button', { type: 'button', class: 'btn', text: LOCAL.cancel });
      const ok = el('button', { type: 'button', class: 'btn btn-primary', disabled: reason !== null || sending || gas === 'failed', text: LOCAL.confirm });
      cancel.addEventListener('click', close);
      ok.addEventListener('click', () => void confirm());
      box.append(
        el('div', { class: 'sheet-head' }, el('h3', { text: copy.PAINT_N(String(args.cells.length)) })),
        el('div', { class: 'sheet-line' }, `${args.cells.length} ${LOCAL.cells} `, tag('PENDING'), ` ${copy.WORD_PENDING_NOT_SENT}`),
        el('div', { class: 'sheet-line' }, `${LOCAL.gasEstimate}: `, gasLine),
        el('div', { class: 'sheet-line' }, `${copy.PAINT_SHEET_DESTINATION} (`, el('span', { class: 'mono', title: CONFIG.PIT }, shortAddr(CONFIG.PIT)), ')'),
        reason ? el('div', { class: 'reason muted', text: reason }) : '',
        lastError ? el('div', { class: 'error', role: 'alert', text: lastError }) : '',
        el('div', { class: 'sheet-actions' }, cancel, ok),
      );
    };
    const close = (): void => {
      unsub();
      backdrop.remove();
      if (sheet && sheet.close === close) sheet = null;
    };
    const confirm = async (): Promise<void> => {
      const s = store.get();
      if (paintDisabledReason(s, args.cells.length) !== null || sending) return;
      sending = true;
      lastError = null;
      render(s);
      try {
        const sent = asSent(await send(s, args));
        const from = connectedWallet(s)?.address;
        store.set({ pendingTx: { hash: sent.hash, cells: args.cells, colors: args.colors, sentAt: now(), from, nonce: sent.nonce }, queue: { cells: [], colors: [] } });
        actions?.kick();
        close();
      } catch (e) {
        lastError = describeError(e).sentence;
        sending = false;
        render(store.get());
      }
    };
    const unsub = store.subscribe(render);
    backdrop.addEventListener('click', (ev) => {
      if (ev.target === backdrop) close();
    });
    sheet = { close, render };
    render(s0);
    void estimate(s0, args)
      .then((g) => {
        gas = g;
      })
      .catch((e: unknown) => {
        gas = 'failed';
        gasError = describeError(e).sentence;
      })
      .finally(() => {
        if (!disposed && sheet && sheet.close === close) render(store.get());
      });
  };

  // ---------- settlement flash (§2.4 / §6.3) ----------
  const showFlash = (s: AppState, H: bigint, delta: bigint, block: bigint): void => {
    hideFlash();
    const node = el('div', { class: 'flash', role: 'status', 'data-height': H.toString() });
    document.body.append(node);
    // one-shot bezel pulse on the canvas frame, caused by this observed BatchSettled (never by time); one timer handle
    if (pulseTimer !== null) clearTimeout(pulseTimer);
    canvasWrap.classList.remove('settled-pulse');
    void canvasWrap.offsetWidth; // restart the animation when a pulse is still running
    canvasWrap.classList.add('settled-pulse');
    pulseTimer = setTimeout(() => {
      canvasWrap.classList.remove('settled-pulse');
      pulseTimer = null;
    }, 700);
    const timer = setTimeout(hideFlash, 6000);
    flash = { height: H, block, node, timer, label: 'fresh', delta };
    renderFlash(s);
  };
  const renderFlash = (s: AppState): void => {
    if (!flash) return;
    const b = budgetOf(s);
    const ready = b && b.coreOk && b.joined && s.tick?.ok ? b.ready : null;
    clear(flash.node);
    // body sentence in the readable mono face; only the "+N" number gets the pixel face
    const text = flashText(flash.height, flash.delta, flash.label, ready);
    const num = `+${fmtInt(flash.delta)}`;
    const at = text.indexOf(num);
    flash.node.append(tag(flash.label === 'fresh' ? 'FRESH' : 'SETTLED'), ' ');
    if (at < 0) flash.node.append(text);
    else flash.node.append(text.slice(0, at), el('b', { class: 'flash-num', text: num }), text.slice(at + num.length));
  };
  const hideFlash = (): void => {
    if (!flash) return;
    clearTimeout(flash.timer);
    flash.node.remove();
    flash = null;
  };

  // ---------- renderers ----------
  const renderTools = (): void => {
    const s = store.get();
    liveBtn.setAttribute('aria-pressed', s.practice ? 'false' : 'true');
    practiceBtn.setAttribute('aria-pressed', s.practice ? 'true' : 'false');
    section.dataset.mode = s.practice ? 'practice' : 'live'; // bezel glow colour only (amber live / violet practice)
    practiceTitle.hidden = !s.practice;
    for (const b of zoomBtns) b.setAttribute('aria-pressed', Number(b.dataset.zoom) === canvas.getZoom() ? 'true' : 'false');
  };

  const renderCanvas = (s: AppState): void => {
    if (s.practice && practiceFrame) {
      canvas.setFrame(practiceFrame);
      canvas.setPending(new Map());
      canvas.setFresh(new Set());
      freshHead = null; // leaving Live: the next live render re-enters view, it is not a new block
      return;
    }
    canvas.setFrame(currentLiveFrame(s));
    canvas.setPending(pendingCells(s));
    // the FRESH ripple is armed only when the observed head advanced since the previous live render, never on the
    // first render or on a Practice -> Live switch (those cells merely re-entered view)
    const head = s.lastGood?.head ?? null;
    canvas.setFresh(freshCells(s), { animate: freshHead !== null && head !== null && head !== freshHead });
    freshHead = head;
  };

  const renderTooltip = (h: HoverInfo | null, s: AppState): void => {
    if (!h) {
      tooltip.hidden = true;
      return;
    }
    clear(tooltip);
    const frame = s.practice && practiceFrame ? practiceFrame : currentLiveFrame(s);
    const c = decodeCell(frame[h.cell]!);
    const { x, y } = cellXY(h.cell);
    if (s.practice) {
      tooltip.append(tag('PRACTICE'), ` (${x}, ${y}) · ${paletteName(c.color)}`);
    } else if (c.genesis && c.painterId === 0) {
      tooltip.append(`(${x}, ${y}) · ${paletteName(c.color)} · `, copy.GENESIS_HOVER);
    } else if (c.painterId === 0) {
      tooltip.append(`(${x}, ${y}) · ${paletteName(c.color)} · ${LOCAL.unpainted}`);
    } else {
      const p = provenance(s).get(h.cell);
      const t = s.lastGood;
      if (p && p.playerId === c.painterId && t) {
        tooltip.append(tag(blockLabel(p.blockNumber, t.safe)), ' ', LOCAL.tooltip(x, y, paletteName(c.color), crewName(c.crew), shortAddr(p.player), fmtInt(p.coreHeight)), ' ', txLink(p.txHash));
      } else {
        tooltip.append(tag(s.logs?.incomplete ? 'INCOMPLETE' : 'UNKNOWN'), ' ', LOCAL.tooltip(x, y, paletteName(c.color), crewName(c.crew), `#${c.painterId}`, copy.LABEL_UNKNOWN));
      }
    }
    const r = left.getBoundingClientRect();
    tooltip.style.left = `${Math.round(h.clientX - r.left + 12)}px`;
    tooltip.style.top = `${Math.round(h.clientY - r.top + 12)}px`;
    tooltip.hidden = false;
  };

  /** "since" facts for the idle card: height H, the ETH block that brought it (or a lower bound), and its age. */
  const idleFacts = (s: AppState): { H: bigint; block: bigint | null; lowerBound: boolean; ago: string | null; ageMs: number | null } | null => {
    const t = s.lastGood;
    if (!t) return null;
    const H = t.state.blockHeight;
    const hit = s.logs ? settlementFor(s.logs.settled, H) : null;
    let block: bigint | null = null;
    let lowerBound = false;
    if (hit) block = hit.log.blockNumber;
    else if (CONFIG.PIT_DEPLOY_BLOCK > 0n) {
      block = CONFIG.PIT_DEPLOY_BLOCK; // H was already reached when the Pit was deployed: a lower bound on the gap
      lowerBound = true;
    }
    let ago: string | null = null;
    let ageMs: number | null = null;
    if (block !== null) {
      const ts = tsCache.get(block);
      if (ts !== undefined) {
        ageMs = Math.max(0, now() - Number(ts) * 1000);
        ago = `${lowerBound ? '≥ ' : ''}${fmtAgo(now() - ageMs, now())}`;
      } else if (!tsPending.has(block)) {
        tsPending.add(block);
        const b = block;
        void timestampOf(clientFor(s), b).then((v) => {
          tsPending.delete(b);
          if (v !== null) tsCache.set(b, v);
          if (!disposed) renderAll(store.get());
        });
      }
    }
    return { H, block, lowerBound, ago, ageMs };
  };

  const renderStatusCard = (s: AppState): void => {
    clear(statusCard);
    const t = s.tick;
    if (t && !t.ok) {
      const at = fmtUtcHHMM(t.at);
      statusCard.dataset.state = 'unknown';
      statusCard.append(tag('UNKNOWN'), ' ', t.reason === 'stale' ? copy.IDLE_STALE(at, fmtBlock(t.head)) : copy.ERR_RPC_UNREACHABLE(fmtBlock(s.lastGood?.head ?? null), at));
      return;
    }
    const f = idleFacts(s);
    if (!f || !s.lastGood) {
      statusCard.dataset.state = 'unknown';
      statusCard.append(tag('UNKNOWN'), ' ', copy.WORD_UNKNOWN(fmtUtcHHMM(now())));
      return;
    }
    if (f.block === null || f.ago === null) {
      // no BatchSettled for H in the loaded logs and no lower bound yet (or its timestamp still loading): no digits
      statusCard.dataset.state = 'unknown';
      statusCard.append(tag('UNKNOWN'), ' ', copy.WORD_UNKNOWN(fmtUtcHHMM(now())));
      return;
    }
    statusCard.dataset.state = 'idle';
    // lowerBound: H was already reached before the Pit was deployed, so the settlement block is only known to be
    // <= PIT_DEPLOY_BLOCK and the gap only >= its age; the line is INCOMPLETE (a lower bound), never SETTLED.
    const label = f.lowerBound ? 'INCOMPLETE' : blockLabel(f.block, s.lastGood.safe);
    const blockText = f.lowerBound ? `≤ ${fmtBlock(f.block)}` : fmtBlock(f.block);
    statusCard.append(el('div', {}, tag(label), ' ', copy.IDLE_STATUS(fmtInt(f.H), f.ago, blockText)));
    if (f.ageMs !== null && f.ageMs > 24 * 3600 * 1000) statusCard.append(el('div', { class: 'muted', text: copy.IDLE_LONG_GAP }));
    const b = budgetOf(s);
    if (b && b.coreOk && b.joined && b.ready > 0) statusCard.append(el('div', { text: copy.IDLE_HOLD(String(b.ready)) }));
    if (s.heightMovedBack) statusCard.append(el('div', { class: 'warn', text: copy.HEIGHT_BACKWARDS(fmtInt(s.heightMovedBack.now), fmtInt(s.heightMovedBack.was)) }));
    if (s.lastGood.state.paused) statusCard.append(el('div', { class: 'warn', text: copy.CORE_PAUSED }));
  };

  const renderSeasonLine = (s: AppState): void => {
    clear(seasonLine);
    const logs = s.logs;
    if (!logs || !s.lastGood) return;
    const firstNight = logs.settled.some((x) => x.height > CONFIG.GENESIS_HEIGHT);
    if (firstNight) return;
    seasonLine.append(logs.incomplete ? tag('INCOMPLETE') : tag('SETTLED'), ' ', copy.SEASON_STARTED(fmtInt(CONFIG.GENESIS_HEIGHT)));
  };

  const renderBatteryBox = (s: AppState): void => {
    const w = connectedWallet(s);
    const pending = (s.pendingTx ? s.pendingTx.cells.length : 0) + s.queue.cells.length;
    const m = batteryModel(s.tick, budgetOf(s), !!w, s.heightSettledAtBlock, pending > 0 ? pending : null, w?.address ?? null);
    renderBattery(batteryBox, m);
    clear(batteryExtra);
    if (m.kind !== 'numbers') return;
    if (m.ready === 0) {
      const f = idleFacts(s);
      if (f && f.ago) batteryExtra.append(copy.BATTERY_IDLE(fmtInt(f.H), f.ago));
    } else if (m.fresh === 0) {
      batteryExtra.append(copy.BATTERY_HOLD(String(m.ready)));
    }
  };

  const renderPalette = (): void => {
    clear(paletteBox);
    PALETTE.forEach((p, i) => {
      const b = el('button', {
        type: 'button',
        class: 'swatch',
        role: 'option',
        'data-index': String(i),
        'aria-selected': i === selectedColor ? 'true' : 'false',
        title: `${i.toString(16)} · ${p.name}`,
        'aria-label': `${i.toString(16)} ${p.name}`,
      });
      b.style.background = p.hex;
      b.addEventListener('click', () => {
        selectedColor = i;
        renderPalette();
      });
      paletteBox.append(b);
    });
  };

  const renderQueue = (s: AppState): void => {
    clear(queueBox);
    if (s.practice) {
      queueBox.append(
        el('div', { class: 'queue-line' }, tag('PRACTICE'), ` ${practiceUndo.length} ${LOCAL.cells}`),
        el('div', { class: 'queue-actions' }, button(LOCAL.undo, undo, practiceUndo.length === 0), button(LOCAL.clearQ, clearQueue, practiceUndo.length === 0)),
        el('div', { class: 'reason muted', text: copy.PRACTICE_TITLE }),
      );
      return;
    }
    const n = encodePaintArgs(s.queue).cells.length;
    const b = budgetOf(s);
    const cap = b && b.coreOk && b.joined && s.tick?.ok ? String(Math.min(CAP, b.ready)) : copy.LABEL_UNKNOWN;
    const reason = paintDisabledReason(s, n);
    // wrong network does not disable PAINT: pressing it asks the wallet to switch to Sepolia first
    const wrongNet = reason === copy.REASON_WRONG_NETWORK && n > 0;
    const paint = el('button', { type: 'button', class: 'btn btn-primary paint-btn', disabled: reason !== null && !wrongNet, text: copy.PAINT_N(String(n)) });
    paint.addEventListener('click', () => {
      if (paintDisabledReason(store.get(), n) === copy.REASON_WRONG_NETWORK) {
        void actions?.switchChain();
        return;
      }
      openConfirm();
    });
    queueBox.append(
      el('div', { class: 'queue-line' }, tag('PENDING'), ` ${copy.QUEUED(String(n), cap)} · ${copy.WORD_PENDING_NOT_SENT}`),
      s.pendingTx ? el('div', { class: 'queue-line' }, tag('PENDING'), ` ${s.pendingTx.cells.length} ${LOCAL.cells} · ${copy.WORD_PENDING_SENT} `, txLink(s.pendingTx.hash)) : '',
      el('div', { class: 'queue-actions' }, button(LOCAL.undo, undo, n === 0), button(LOCAL.clearQ, clearQueue, n === 0), paint),
      el('div', { class: 'reason muted', text: reason ?? queueHint ?? '' }),
      lastError && !sheet ? el('div', { class: 'error', role: 'alert', text: lastError }) : '',
    );
  };

  const renderStrip = (s: AppState): void => {
    clear(stripBox);
    const t = s.lastGood;
    if (!t || !s.tick || !s.tick.ok) {
      // §6.5 UNKNOWN is a grey dash + clock, never a number: a failed tick shows no Core digits (board.ts does the same)
      stripBox.append(el('div', { class: 'strip-line' }, tag('UNKNOWN'), ' ', copy.WORD_UNKNOWN(fmtUtcHHMM(s.tick?.at ?? now()))));
    } else {
      const hl = heightLabel(s.heightSettledAtBlock, t.safe);
      stripBox.append(
        el('div', { class: 'strip-line' }, tag(hl), ` ${LOCAL.coreHeight} ${fmtInt(t.state.blockHeight)} · ${LOCAL.settledThrough} ${fmtInt(t.state.settledThroughRound)} · `, el('span', { class: 'muted', text: LOCAL.asOfHead(fmtBlock(t.head)) })),
      );
      const last = s.logs?.settled[s.logs.settled.length - 1];
      if (last) {
        const prev = s.logs!.settled[s.logs!.settled.length - 2];
        const delta = prev && last.height > prev.height ? last.height - prev.height : 0n;
        stripBox.append(el('div', { class: 'strip-line' }, tag(blockLabel(last.blockNumber, t.safe)), ` ${LOCAL.lastSettlement}: ${LOCAL.settlementLine(fmtInt(last.height), fmtInt(delta), fmtInt(last.settledThroughRound), fmtBlock(last.blockNumber))} `, txLink(last.txHash)));
      } else if (s.logs) {
        stripBox.append(el('div', { class: 'strip-line muted' }, tag(s.logs.incomplete ? 'INCOMPLETE' : 'SETTLED'), ` ${LOCAL.lastSettlement}: —`));
      }
    }
    // PROVISIONAL light: the only place where "running"/"asleep" words may appear (§2.1, §6.5). Fields come from the
    // real /v1/status shape (measurement.freshness / coreStatus / rpmMilli, builder.status, settlementQueue.status).
    const api = s.api;
    const dot = el('span', { class: `dot ${api.status === 'ok' ? 'dot-provisional' : 'dot-grey'}`, title: copy.LABEL_PROVISIONAL });
    const parts: string[] = [];
    if (api.status === 'ok' && api.summary) {
      const sm = api.summary;
      if (sm.freshness) parts.push(sm.freshness);
      if (sm.coreStatus) parts.push(sm.coreStatus.toLowerCase());
      if (sm.rpm !== null) parts.push(`${sm.rpm} rpm`);
      if (sm.builderStatus && sm.builderStatus !== 'available') parts.push(`builder ${sm.builderStatus}`);
      if (sm.queueStatus && sm.queueStatus !== 'available') parts.push(`settlement queue ${sm.queueStatus}`);
      if (parts.length === 0) parts.push('ok');
    } else {
      parts.push(copy.WORD_UNKNOWN(fmtUtcHHMM(api.at ?? now())));
    }
    stripBox.append(
      el('div', { class: 'strip-line provisional' }, dot, ' ', tag('PROVISIONAL'), ` ${LOCAL.apiLine(parts.join(' · '))}`),
      el('div', { class: 'strip-note muted', text: copy.PROVISIONAL_NOTE }),
    );
    if (roundCfg && roundCfg.roundDuration > 0n) {
      const round = (BigInt(Math.floor(now() / 1000)) - roundCfg.genesisTimestamp) / roundCfg.roundDuration;
      stripBox.append(el('div', { class: 'strip-line muted' }, tag('PROVISIONAL'), ` ${copy.CURRENT_ROUND_DERIVED(fmtInt(round < 0n ? 0n : round))}`));
    }
  };

  const renderFeed = (s: AppState): void => {
    clear(feedBox);
    clear(completeLine);
    const t = s.lastGood;
    if (s.pendingTx) {
      const p = s.pendingTx;
      feedBox.append(el('li', { class: 'feed-item' }, tag('PENDING'), ` ${p.cells.length > 0 ? LOCAL.feedPendingPaint(String(p.cells.length)) : LOCAL.feedPendingJoin} · ${copy.WORD_PENDING_SENT} `, txLink(p.hash)));
    }
    if (!s.logs || !t) {
      completeLine.append(tag('UNKNOWN'), ' ', copy.WORD_UNKNOWN(fmtUtcHHMM(now())));
      return;
    }
    for (const it of feedItems(s.logs)) {
      feedBox.append(el('li', { class: `feed-item feed-${it.kind.toLowerCase()}` }, tag(blockLabel(it.blockNumber, t.safe)), ` ${it.text} `, txLink(it.txHash)));
    }
    if (s.logs.incomplete || s.logs.completeThrough === null) {
      completeLine.append(tag('INCOMPLETE'), ' ', copy.INCOMPLETE_LINE(String(s.logs.failedChunks)));
    } else {
      const through = s.logs.completeThrough < t.safe ? s.logs.completeThrough : t.safe;
      completeLine.append(copy.COMPLETE_LINE(fmtBlock(CONFIG.PIT_DEPLOY_BLOCK), fmtBlock(through)));
    }
  };

  const renderCrews = (s: AppState): void => {
    clear(crewsBox);
    const t = s.lastGood;
    if (!t || !t.pit || !s.tick || !s.tick.ok) {
      // crewScores()@B comes from the CURRENT tick only: a failed tick is UNKNOWN with a clock, never a stale number
      crewsBox.append(tag('UNKNOWN'), ' ', copy.WORD_UNKNOWN(fmtUtcHHMM(s.tick?.at ?? now())));
      return;
    }
    const rows = CREW_NAMES.map((name, i) => ({ name, i, held: t.pit!.crewScores[i] ?? 0 })).sort((a, b) => b.held - a.held);
    const table = el('table', { class: 'crew-table' });
    table.append(el('thead', {}, el('tr', {}, el('th', { text: '' }), el('th', { text: LOCAL.cellsHeld }))));
    const tb = el('tbody');
    for (const r of rows) {
      const sw = el('span', { class: 'crew-dot' });
      sw.style.setProperty('--crew', CREW_COLORS[r.i] ?? '#fff');
      tb.append(el('tr', { 'data-crew': String(r.i) }, el('td', {}, sw, ` ${r.name}`), el('td', { class: 'mono', text: fmtInt(r.held) })));
    }
    table.append(tb);
    crewsBox.append(table, el('div', { class: 'muted' }, tag(blockLabel(t.head, t.safe)), ` ${LOCAL.asOfHead(fmtBlock(t.head))}`));
  };

  const renderAll = (s: AppState): void => {
    renderTools();
    renderCanvas(s);
    renderStatusCard(s);
    renderSeasonLine(s);
    renderBatteryBox(s);
    renderQueue(s);
    joinCard.render(s);
    renderStrip(s);
    renderFeed(s);
    renderCrews(s);
    renderFlash(s);
  };

  // ---------- store subscription ----------
  const onState = (s: AppState, prev: AppState): void => {
    // settlement flash: only from a BatchSettled log whose height > lastKnownHeight AND state() at the same tick agrees
    if (s.lastKnownHeight !== null && prev.lastKnownHeight !== null && s.lastKnownHeight > prev.lastKnownHeight && s.lastGood && s.logs && s.lastGood.state.blockHeight === s.lastKnownHeight) {
      const hit = settlementFor(s.logs.settled, s.lastKnownHeight);
      if (hit && hit.log.blockNumber <= s.lastGood.head) {
        const prevH = hit.index > 0 ? s.logs.settled[hit.index - 1]!.height : prev.lastKnownHeight;
        showFlash(s, s.lastKnownHeight, s.lastKnownHeight - prevH, hit.log.blockNumber);
      }
    }
    if (flash && s.lastGood && flash.label === 'fresh' && flash.block <= s.lastGood.safe) flash.label = 'settled';
    // a pending tx that got mined: the queue stays empty, budgetOf is re-read by the next tick (main.ts)
    if (prev.pendingTx && !s.pendingTx) lastError = null;
    renderAll(s);
  };
  const unsub = store.subscribe(onState);

  // initial render + the derived-round configuration + the "X ago" clock
  renderPalette();
  renderAll(store.get());
  void configurationOf(clientFor(store.get())).then((c) => {
    roundCfg = c;
    if (!disposed) renderStrip(store.get());
  });
  const clock = setInterval(() => {
    if (disposed) return;
    const s = store.get();
    renderStatusCard(s);
    renderBatteryBox(s);
    renderStrip(s);
  }, 30_000);

  return () => {
    disposed = true;
    clearInterval(clock);
    unsub();
    sheet?.close();
    hideFlash();
    if (pulseTimer !== null) clearTimeout(pulseTimer);
    document.removeEventListener('keydown', onKey);
    canvas.destroy();
    section.remove();
    // the practice copy lives in this mount; leaving the route discards it, so the store flag must not outlive it
    if (store.get().practice) store.set({ practice: false });
  };
}

function button(text: string, onClick: () => void, disabled = false): HTMLButtonElement {
  const b = el('button', { type: 'button', class: 'btn', disabled, text });
  b.addEventListener('click', onClick);
  return b;
}

// ---------- styles (scoped to .play / .sheet / .flash; integrator may hoist into style.css) ----------

const STYLE_ID = 'play-style';
function injectStyle(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const st = document.createElement('style');
  st.id = STYLE_ID;
  st.textContent = `
.play{display:grid;grid-template-columns:minmax(0,3fr) minmax(280px,2fr);gap:16px;align-items:start}
.play-left{position:relative;min-width:0}
.play-tools{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:8px;font-size:13px}
.mode-switch{display:inline-flex;border:2px solid var(--line);border-radius:4px;box-shadow:var(--bevel)}
.mode-btn{border:0;border-radius:0;box-shadow:none;min-height:32px;padding:6px 14px 5px;font:16px/1.5 var(--pixel);text-transform:uppercase;background:var(--panel);color:var(--muted)}
.mode-btn:first-child{border-radius:2px 0 0 2px}
.mode-btn:last-child{border-radius:0 2px 2px 0}
.mode-btn:focus-visible{outline-offset:-3px}
.mode-btn:hover,.mode-btn:active{transform:none;box-shadow:none}
.mode-btn[data-mode=live][aria-pressed=true]{background:var(--amber);color:var(--ink)}
.mode-btn[data-mode=practice][aria-pressed=true]{background:var(--violet);color:#fff}
.toggle{display:inline-flex;align-items:center;gap:6px;min-height:32px;color:var(--muted);cursor:pointer}
.toggle input{accent-color:var(--amber);width:18px;height:18px;margin:0}
.zoom-box{display:inline-flex;gap:4px;align-items:center;color:var(--muted)}
.zoom-btn{min-width:36px}
.zoom-btn[aria-pressed=true]{border-color:var(--amber);color:var(--amber)}
.practice-title{font:12px var(--mono);background:var(--violet);color:#fff;border:2px solid var(--violet-edge);border-bottom:0;border-radius:6px 6px 0 0;padding:6px 10px;margin:6px 6px -6px}
.canvas-wrap{position:relative;padding:10px;margin:6px;width:calc(100% - 12px);background:#0c0912;border:2px solid var(--line);border-radius:10px;box-shadow:var(--glow);overflow:hidden}
.play[data-mode=practice] .canvas-wrap{box-shadow:var(--glow-practice)}
.canvas-wrap .pit-canvas{border:0;display:block;margin:0 auto;max-width:100%}
.tooltip{position:absolute;z-index:5;background:var(--bg-2);color:var(--fg);border:2px solid var(--line);box-shadow:var(--bevel);border-radius:3px;padding:6px 8px;font:12px var(--mono);pointer-events:none;max-width:min(360px,90vw)}
.play-rail{display:flex;flex-direction:column;gap:14px;min-width:0}
.card{border:2px solid var(--line);border-radius:6px;background:linear-gradient(var(--panel),var(--panel) 60%,#201a31);box-shadow:var(--bevel),inset 0 1px 0 var(--panel-2);padding:12px 14px}
.card h3{margin:0 0 10px;padding-top:1px;font:16px/1.5 var(--pixel);text-transform:uppercase;letter-spacing:.04em;color:var(--amber);display:flex;align-items:center;gap:8px}
.card h3::after{content:'';flex:1;height:2px;background:repeating-linear-gradient(90deg,var(--line) 0 4px,transparent 4px 8px)}
.status-card{margin-top:12px;font-size:13px}
.status-card .warn{color:var(--yellow);margin-top:6px}
.season-line{margin-top:6px;font-size:12px}
.battery-extra{font-family:var(--mono);font-size:12px;margin-top:6px}
.palette{display:grid;grid-template-columns:repeat(8,minmax(0,1fr));gap:8px;padding:8px;background:var(--bg-2);border-radius:4px;box-shadow:inset 0 2px 0 var(--shadow)}
.swatch{aspect-ratio:1;min-height:32px;border:2px solid var(--shadow);border-radius:3px;padding:0;box-shadow:var(--bevel),inset 0 2px 0 rgba(255,255,255,.18);cursor:pointer}
.swatch:hover{transform:translateY(-1px)}
.swatch:active{transform:translateY(2px);box-shadow:0 1px 0 var(--shadow)}
.swatch[aria-selected=true]{outline:3px solid var(--pink);outline-offset:2px;transform:translateY(-2px);box-shadow:0 0 0 2px var(--bg),0 0 12px rgba(255,112,166,.6)}
.swatch:focus-visible{outline:3px solid var(--cyan);outline-offset:3px}
.queue-line{font:12px var(--mono);margin-bottom:6px}
.queue-actions{display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:6px 0}
.reason{font-size:12px;color:var(--muted);min-height:1.2em;padding-left:10px;border-left:3px solid var(--line)}
.error{color:var(--red-text);font-size:12px;font-weight:700;margin-top:6px}
.strip-line{font:12px var(--mono);padding:5px 0;border-bottom:2px dotted var(--line)}
.strip-line:last-child{border:0}
.strip-note{font-size:11px;margin-bottom:6px}
.feed{list-style:none;margin:0;padding:6px 8px;background:var(--bg-2);border:2px solid var(--line);max-height:320px;overflow:auto;scrollbar-color:var(--line) var(--bg-2);font:12px var(--mono)}
.feed-item{position:relative;padding:5px 0 5px 12px;border-bottom:1px dashed var(--line);border-left:4px solid transparent}
.feed-item::before{content:'';position:absolute;left:2px;top:11px;width:5px;height:5px;background:var(--cyan)}
.feed-item.feed-batchsettled{border-left-color:var(--green)}
.complete-line{font-size:11px;margin-top:6px}
.crew-table{width:100%;border-collapse:separate;border-spacing:0;font-size:13px}
.crew-table th{text-align:left;color:var(--muted);font:11px var(--mono);text-transform:uppercase;padding:0 8px}
.crew-table td{padding:6px 8px}
.crew-table tbody tr:nth-child(odd) td{background:rgba(255,255,255,.03)}
.crew-table tr[data-crew] td:first-child{border-left:4px solid var(--crew)}
.crew-table td.mono{text-align:right}
.crew-table tbody tr:first-child td{color:var(--amber)}
.crew-dot{display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--crew,#fff);outline:2px solid var(--shadow);vertical-align:middle}
.crew-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.crew-btn,.provider-btn{display:flex;align-items:center;justify-content:flex-start;gap:8px;min-height:40px;padding:6px 12px;border:2px solid var(--line);border-radius:4px;background:linear-gradient(var(--panel-2),var(--panel));color:var(--fg);box-shadow:var(--bevel);text-align:left;cursor:pointer}
.crew-btn{border-left-width:6px;border-left-color:var(--crew)}
.provider-btn{width:100%}
.crew-btn:active,.provider-btn:active{transform:translateY(2px);box-shadow:0 1px 0 var(--shadow)}
.crew-btn[aria-pressed=true]{box-shadow:inset 0 0 0 2px var(--crew),0 0 12px rgba(255,255,255,.18);background:var(--panel-2)}
.join-step{margin-bottom:8px}
.join-step-title{font:16px/1.5 var(--pixel);text-transform:uppercase;color:var(--amber);margin:10px 0 6px;padding-top:1px}
.provider-list{display:flex;flex-direction:column;gap:6px}
.join-text{font:13px var(--sans);color:var(--muted);margin:6px 0}
.join-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.join-done,.join-pending{font-size:13px}
.faucets{font-size:12px;margin-top:4px}
.faucets a{color:var(--cyan)}
.sheet-backdrop{position:fixed;inset:0;background:rgba(10,7,18,.75);display:flex;align-items:center;justify-content:center;z-index:20;padding:16px}
.sheet{background:var(--panel);border:2px solid var(--line);border-radius:8px;box-shadow:0 6px 0 var(--shadow),0 0 40px rgba(0,0,0,.6);padding:16px;max-width:480px;width:100%;max-height:90vh;overflow:auto}
.sheet-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}
.sheet-head h3{margin:0;padding-top:1px;font:16px/1.5 var(--pixel);text-transform:uppercase;color:var(--amber)}
.sheet-line{font-size:13px;margin:6px 0;font-family:var(--mono)}
.sheet-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:12px}
.flash{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:30;pointer-events:none;padding:16px;text-align:center;background:radial-gradient(ellipse at center,rgba(255,191,105,.22),rgba(0,0,0,0) 70%);font:700 16px/1.5 var(--mono);color:var(--amber);text-shadow:2px 2px 0 var(--shadow),0 0 20px rgba(255,191,105,.7);animation:flash-fade 6s ease-out forwards}
.flash .flash-num{font:24px/1.5 var(--pixel);text-shadow:3px 3px 0 var(--shadow),0 0 20px rgba(255,191,105,.7)}
@keyframes flash-fade{0%{opacity:1}70%{opacity:1}100%{opacity:0}}
@media (prefers-reduced-motion:no-preference){.swatch{transition:transform 120ms,box-shadow 120ms}.canvas-wrap.settled-pulse{animation:settled 700ms ease-out 1}@keyframes settled{from{box-shadow:0 0 0 3px #0a0712,0 0 0 5px var(--amber),0 0 48px rgba(255,191,105,.9),0 6px 0 #0a0712}to{box-shadow:var(--glow)}}}
@media (max-width:640px){.play{grid-template-columns:1fr}.swatch{min-height:44px}.paint-btn{width:100%}.canvas-wrap{padding:6px;border-radius:8px}}
`;
  document.head.append(st);
}
