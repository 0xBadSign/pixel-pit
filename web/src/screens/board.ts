// Board screen (SPEC §4 social layer, §6.4 "#/board", §6.5 labels, §7.4 bots note, §7.15 completeness line).
//
// Tabs: Crews (first, primary: cells held from crewScores() at the pinned block, total strokes from logs) and
// Wallets (surviving pixels [primary], unique cells, total strokes, crew, join height; filter "active on >= 2
// nights", default on once two nights exist in the data). Every log-derived number is bounded by the SAFE
// block of the last good tick (so it is SETTLED, or INCOMPLETE while chunks are missing) and sits under a §7.15
// completeness line. The only head-read number is crewScores()@B, which carries its own FRESH/SETTLED tag
// and "as of ETH block N (head)" line. Nothing here is ever called "final".
//
// STUBS (not in v1, SPEC §4 stretch B): the Nights tab (`mountNightsTab`) and the painter card
// (`#/board?p=0x…`, `mountPainterCard`) render a marked placeholder only.
import type { Address } from 'viem';
import { CONFIG, CREWS, CREW_COLORS, crewName } from '../config';
import * as copy from '../copy';
import { el, clear, fmtBlock, fmtInt, fmtUtcHHMM, shortAddr } from '../format';
import { frame, genesisFrame, decodeCell } from '../frame';
import { blockLabel, type AppState, type Store } from '../state';
import type { Route } from '../router';
import type { LogsSnapshot, PaintedLog, JoinedEvent } from '../logs';

export type BoardTab = 'crews' | 'wallets';

// ---------- strings not in §7 (factual, listed in the agent report for the integrator) ----------
const TAB_CREWS = 'Crews';
const TAB_WALLETS = 'Wallets';
const TAB_NIGHTS = 'Nights';
const NOT_IN_V1 = 'not in v1 (stretch B)';
const FILTER_ACTIVE_NIGHTS = 'active on ≥ 2 nights'; // SPEC §4 wording
const FILTER_NIGHTS_HOW = 'nights counted from 12:00 UTC boundaries; block times estimated from block numbers (12 s per slot)';
const COL_CREW = 'crew';
const COL_CELLS_HELD = 'cells held';
const COL_TOTAL_STROKES = 'total strokes';
const COL_WALLET = 'wallet';
const COL_JOIN_HEIGHT = 'join height';
const COL_SURVIVING = 'surviving pixels';
const COL_UNIQUE = 'unique cells';
const SRC_CREW_SCORES = 'crewScores()';
const SRC_LOGS = 'Painted/Joined logs';

// ---------- pure helpers (unit-tested in board.test.ts) ----------

export type Completeness =
  | { kind: 'complete'; from: bigint; through: bigint } // logs contiguous from `from` through `through` (= safe)
  | { kind: 'incomplete'; failed: number; through: bigint | null };

/** Log-derived numbers are bounded by `safe`; they are complete when the contiguous coverage reaches it. */
export function completeness(logs: LogsSnapshot, safe: bigint, from: bigint = CONFIG.PIT_DEPLOY_BLOCK): Completeness {
  if (logs.completeThrough !== null && logs.completeThrough >= safe) return { kind: 'complete', from, through: safe };
  return { kind: 'incomplete', failed: Math.max(1, logs.failedChunks), through: logs.completeThrough };
}

export const SECONDS_PER_SLOT = 12n;
export const NIGHT_BOUNDARY_SEC = 43_200n; // 12:00 UTC

/** Night id: whole days since the epoch, counted from 12:00 UTC boundaries (SPEC §4 Nights). */
export function nightId(tsSec: bigint): number {
  const shifted = tsSec - NIGHT_BOUNDARY_SEC;
  // floor division for negatives too
  return Number(shifted >= 0n ? shifted / 86_400n : -((-shifted + 86_399n) / 86_400n));
}

/** Estimated timestamp of an ETH block from the head block (12 s slots; drifts a few minutes per day). */
export function estimateBlockTime(block: bigint, head: bigint, headTs: bigint): bigint {
  return headTs - (head - block) * SECONDS_PER_SLOT;
}

export type WalletRow = {
  address: Address;
  playerId: number;
  crew: number;
  joinHeight: bigint;
  surviving: number; // cells whose painterId == playerId in frame(<= upTo)
  unique: number; // distinct cells this wallet ever painted (<= upTo)
  strokes: number; // sum of Painted.cells.length (<= upTo)
  nights: number; // distinct night ids over this wallet's Painted events
};

export type WalletBoardInput = {
  joined: readonly JoinedEvent[];
  painted: readonly PaintedLog[];
  crewByPlayerId: ReadonlyMap<number, number>;
  upTo: bigint; // only events with blockNumber <= upTo count (the safe block)
  genesis: Uint32Array;
  nightOf: (blockNumber: bigint) => number;
};

/** One row per Joined wallet (<= upTo). Unsorted; see sortWalletRows. */
export function walletRows(i: WalletBoardInput): WalletRow[] {
  const joined = i.joined.filter((j) => j.blockNumber <= i.upTo);
  const painted = i.painted.filter((p) => p.blockNumber <= i.upTo);
  const f = frame(null, painted, i.crewByPlayerId, i.genesis);
  const surviving = new Map<number, number>();
  for (let c = 0; c < f.length; c++) {
    const cell = decodeCell(f[c]!);
    if (cell.painterId === 0 || cell.genesis) continue;
    surviving.set(cell.painterId, (surviving.get(cell.painterId) ?? 0) + 1);
  }
  const unique = new Map<number, Set<number>>();
  const strokes = new Map<number, number>();
  const nights = new Map<number, Set<number>>();
  for (const p of painted) {
    let u = unique.get(p.playerId);
    if (!u) unique.set(p.playerId, (u = new Set()));
    for (const c of p.cells) u.add(c);
    strokes.set(p.playerId, (strokes.get(p.playerId) ?? 0) + p.cells.length);
    let n = nights.get(p.playerId);
    if (!n) nights.set(p.playerId, (n = new Set()));
    n.add(i.nightOf(p.blockNumber));
  }
  return joined.map((j) => ({
    address: j.player,
    playerId: j.playerId,
    crew: j.crew,
    joinHeight: j.coreHeight,
    surviving: surviving.get(j.playerId) ?? 0,
    unique: unique.get(j.playerId)?.size ?? 0,
    strokes: strokes.get(j.playerId) ?? 0,
    nights: nights.get(j.playerId)?.size ?? 0,
  }));
}

/** Primary surviving pixels, secondary unique cells, tertiary total strokes, then join order (SPEC §4). */
export function sortWalletRows(rows: readonly WalletRow[]): WalletRow[] {
  return [...rows].sort(
    (a, b) => b.surviving - a.surviving || b.unique - a.unique || b.strokes - a.strokes || a.playerId - b.playerId,
  );
}

/** Distinct nights with at least one Painted event (<= upTo). The >= 2 nights filter defaults on at 2. */
export function nightsSeen(painted: readonly PaintedLog[], upTo: bigint, nightOf: (blockNumber: bigint) => number): number {
  const s = new Set<number>();
  for (const p of painted) if (p.blockNumber <= upTo) s.add(nightOf(p.blockNumber));
  return s.size;
}

export type CrewRow = { crew: number; name: string; held: number | null; strokes: number };

/** cells held from crewScores()@B (null when not readable), total strokes from Painted logs (<= upTo) by crew. */
export function crewRows(
  crewScores: readonly number[] | null,
  painted: readonly PaintedLog[],
  crewByPlayerId: ReadonlyMap<number, number>,
  upTo: bigint,
): CrewRow[] {
  const strokes = new Array<number>(CREWS).fill(0);
  for (const p of painted) {
    if (p.blockNumber > upTo) continue;
    const crew = crewByPlayerId.get(p.playerId);
    if (crew === undefined || crew < 0 || crew >= CREWS) continue;
    strokes[crew] = (strokes[crew] ?? 0) + p.cells.length;
  }
  const rows: CrewRow[] = [];
  for (let c = 0; c < CREWS; c++) {
    const held = crewScores && crewScores[c] !== undefined ? crewScores[c]! : null;
    rows.push({ crew: c, name: crewName(c), held, strokes: strokes[c] ?? 0 });
  }
  return rows.sort((a, b) => (b.held ?? -1) - (a.held ?? -1) || b.strokes - a.strokes || a.crew - b.crew);
}

// ---------- screen ----------
let currentTab: BoardTab = 'crews';
let activeFilter: boolean | null = null; // null = follow the default (on once 2 nights exist)

// Scoped styles (integrator may hoist into style.css). INCOMPLETE tables: grey italic numbers (SPEC §6.5).
const STYLE =
  '.board-tabs{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}' +
  '.board-tab{font:16px/1.5 var(--pixel);text-transform:uppercase;padding-top:7px;color:var(--muted)}' +
  '.board-tab[aria-selected=true]{color:var(--amber);box-shadow:inset 0 -3px 0 var(--amber)}' +
  '.board-line,.board-filter{font-family:var(--mono);font-size:12px;color:var(--muted);margin:8px 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap}' +
  '.board-wrap{overflow-x:auto;border:2px solid var(--line);border-radius:6px;background:var(--panel);box-shadow:var(--bevel);padding:6px}' +
  '.board-table{width:100%;border-collapse:collapse;font-family:var(--mono);font-size:13px}' +
  '.board-table th,.board-table td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}' +
  '.board-table th{color:var(--muted);font-weight:400;font-size:11px;text-transform:uppercase}.board-table tbody tr:nth-child(odd) td{background:rgba(255,255,255,.03)}.board-table .num{text-align:right}' +
  '.board-incomplete td.num{color:var(--muted);font-style:italic}.board-table td.unknown{color:var(--muted)}' +
  '.board-swatch{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:middle}' +
  '.board-table .board-you td{background:rgba(255,191,105,.12)}.board-you td:first-child{border-left:3px solid var(--amber)}.board-note{max-width:72ch;margin-top:16px;font-size:12px}';

type Lbl = 'SETTLED' | 'FRESH' | 'UNKNOWN' | 'INCOMPLETE';

export function mount(root: HTMLElement, store: Store, route?: Route): void | (() => void) {
  const q = route?.query.get('tab');
  if (q === 'wallets' || q === 'crews') currentTab = q;
  const painter = route?.query.get('p');

  const tabs = el('div', { class: 'board-tabs', role: 'tablist' });
  const body = el('section', { class: 'board-body' });
  root.append(el('style', { text: STYLE }), tabs);
  if (painter) root.append(mountPainterCard(painter));
  root.append(body);

  const render = (s: AppState) => {
    const again = () => render(store.get());
    renderTabs(tabs, again);
    clear(body);
    if (currentTab === 'crews') renderCrews(body, s);
    else renderWallets(body, s, again);
    body.append(el('p', { class: 'muted board-note', text: copy.BOARD_BOTS_NOTE }));
  };
  render(store.get());
  return store.subscribe((s, prev) => {
    if (s.tick !== prev.tick || s.logs !== prev.logs || s.lastGood !== prev.lastGood || s.wallet !== prev.wallet) render(s);
  });
}

function renderTabs(tabs: HTMLElement, rerender: () => void): void {
  clear(tabs);
  const mk = (id: BoardTab, label: string) => {
    const b = el('button', { class: 'btn board-tab', type: 'button', role: 'tab', 'aria-selected': String(currentTab === id), text: label });
    b.addEventListener('click', () => {
      currentTab = id;
      rerender();
    });
    return b;
  };
  tabs.append(mk('crews', TAB_CREWS), mk('wallets', TAB_WALLETS), mountNightsTab());
}

/** STUB — Nights tab is stretch B (SPEC §4); a disabled tab marks the slot. */
export function mountNightsTab(): HTMLElement {
  return el('button', { class: 'btn board-tab', type: 'button', role: 'tab', disabled: true, 'aria-selected': 'false', title: NOT_IN_V1, text: TAB_NIGHTS });
}

/** STUB — painter card `#/board?p=0x…` is stretch B (SPEC §4); renders a marked placeholder only. */
export function mountPainterCard(address: string): HTMLElement {
  return el('p', { class: 'muted board-line', title: address, text: `${shortAddr(address)} · ${NOT_IN_V1}` });
}

function tag(label: Lbl, title?: string): HTMLElement {
  return el('span', { class: `tag tag-${label.toLowerCase()}`, title, text: label });
}

type LogView = {
  logs: LogsSnapshot;
  safe: bigint;
  c: Completeness;
  label: 'SETTLED' | 'INCOMPLETE';
  nightOf: (blockNumber: bigint) => number;
};

/** Log-derived view bounded by the safe block of the last good tick; null when no logs/tick exist yet. */
function logView(s: AppState): LogView | null {
  if (!s.logs || !s.lastGood) return null;
  const { safe, head, headTimestamp } = s.lastGood;
  const c = completeness(s.logs, safe);
  return { logs: s.logs, safe, c, label: c.kind === 'complete' ? 'SETTLED' : 'INCOMPLETE', nightOf: (bn) => nightId(estimateBlockTime(bn, head, headTimestamp)) };
}

/** §7.15 completeness line (above every log-derived table). */
function completenessLine(s: AppState, v: LogView | null): HTMLElement {
  const line = (t: HTMLElement, text: string) => el('p', { class: 'board-line' }, t, el('span', { text }));
  if (!v) return line(tag('UNKNOWN'), copy.WORD_UNKNOWN(fmtUtcHHMM(s.tick?.at ?? Date.now())));
  if (v.c.kind === 'complete') {
    const from = fmtBlock(v.c.from);
    const to = fmtBlock(v.c.through);
    return line(tag('SETTLED', copy.BOARD_COMPLETE(from, to)), copy.COMPLETE_LINE(from, to));
  }
  const k = String(v.c.failed);
  return line(tag('INCOMPLETE', copy.BOARD_INCOMPLETE(k)), copy.INCOMPLETE_LINE(k));
}

function unknownCell(at: number): HTMLElement {
  return el('td', { class: 'num unknown', 'data-label': copy.LABEL_UNKNOWN, title: copy.WORD_UNKNOWN(fmtUtcHHMM(at)), text: '—' });
}

function numCell(n: number | bigint, label: string, title?: string): HTMLElement {
  return el('td', { class: 'num', 'data-label': label, title, text: fmtInt(n) });
}

function crewCell(crew: number): HTMLElement {
  return el('td', null, el('span', { class: 'board-swatch', style: `background:${CREW_COLORS[crew] ?? 'transparent'}` }), crewName(crew));
}

function th(text: string, label?: Lbl): HTMLElement {
  return el('th', { class: label ? 'num' : undefined }, label ? `${text} ` : text, label ? tag(label) : null);
}

function table(incomplete: boolean, head: HTMLElement[], rows: HTMLElement[]): HTMLElement {
  const t = el('table', { class: `board-table${incomplete ? ' board-incomplete' : ''}` });
  t.append(el('thead', null, el('tr', null, ...head)), el('tbody', null, ...rows));
  return el('div', { class: 'board-wrap' }, t);
}

// ---------- Crews tab ----------

function renderCrews(body: HTMLElement, s: AppState): void {
  const v = logView(s);
  body.append(completenessLine(s, v));

  // on-chain column: crewScores()@B from the CURRENT tick only (a failed tick => UNKNOWN, never a stale number)
  const t = s.tick;
  const on =
    t && t.ok && t.pit
      ? { scores: t.pit.crewScores, label: blockLabel(t.head, t.safe), pinned: copy.CHIP_SQUEEK_BLOCK(fmtInt(t.state.blockHeight), fmtBlock(t.head), blockLabel(t.head, t.safe)) }
      : null;
  const at = t?.at ?? Date.now();
  const heldLabel: Lbl = on ? on.label : 'UNKNOWN';
  const src = el('p', { class: 'board-line' }, el('span', { text: `${COL_CELLS_HELD}: ${SRC_CREW_SCORES}` }));
  if (on) src.append(el('span', { text: on.pinned.replace(` · ${on.label}`, '') }), tag(on.label));
  else src.append(tag('UNKNOWN'), el('span', { text: copy.CHIP_UNKNOWN(fmtUtcHHMM(at)) }));
  body.append(src);

  const strokesLabel: Lbl = v ? v.label : 'UNKNOWN';
  const rows = crewRows(on ? on.scores : null, v ? v.logs.painted : [], v ? v.logs.crewByPlayerId : new Map(), v ? v.safe : -1n).map((r) =>
    el(
      'tr',
      { 'data-crew': String(r.crew) },
      crewCell(r.crew),
      r.held === null || !on ? unknownCell(at) : numCell(r.held, heldLabel, on.pinned),
      v ? numCell(r.strokes, v.label, SRC_LOGS) : unknownCell(at),
    ),
  );
  body.append(table(!!v && v.c.kind === 'incomplete', [th(COL_CREW), th(COL_CELLS_HELD, heldLabel), th(COL_TOTAL_STROKES, strokesLabel)], rows));
}

// ---------- Wallets tab ----------

function renderWallets(body: HTMLElement, s: AppState, rerender: () => void): void {
  const v = logView(s);
  body.append(completenessLine(s, v));
  if (!v) return;

  const seen = nightsSeen(v.logs.painted, v.safe, v.nightOf);
  const filterOn = activeFilter === null ? seen >= 2 : activeFilter;
  const cb = el('input', { type: 'checkbox', id: 'board-filter-nights' });
  cb.checked = filterOn;
  cb.disabled = seen < 2;
  cb.addEventListener('change', () => {
    activeFilter = cb.checked;
    rerender();
  });
  body.append(el('label', { class: 'board-filter', for: 'board-filter-nights', title: FILTER_NIGHTS_HOW }, cb, FILTER_ACTIVE_NIGHTS));

  const genesis = genesisFrame(CONFIG.GENESIS_CELLS, CONFIG.GENESIS_COLORS);
  let rows = sortWalletRows(walletRows({ joined: v.logs.joined, painted: v.logs.painted, crewByPlayerId: v.logs.crewByPlayerId, upTo: v.safe, genesis, nightOf: v.nightOf }));
  if (filterOn) rows = rows.filter((r) => r.nights >= 2);
  const me = s.wallet.status === 'connected' ? s.wallet.address.toLowerCase() : null;
  const L = v.label;

  const trs = rows.map((r, idx) =>
    el(
      'tr',
      { class: me && r.address.toLowerCase() === me ? 'board-you' : undefined, 'data-player': String(r.playerId) },
      numCell(idx + 1, L),
      el('td', null, el('a', { href: `${CONFIG.EXPLORER}/address/${r.address}`, target: '_blank', rel: 'noopener', title: r.address, text: shortAddr(r.address) })),
      crewCell(r.crew),
      numCell(r.joinHeight, L, SRC_LOGS),
      numCell(r.surviving, L, SRC_LOGS),
      numCell(r.unique, L, SRC_LOGS),
      numCell(r.strokes, L, SRC_LOGS),
    ),
  );
  if (trs.length === 0) trs.push(el('tr', null, el('td', { colspan: '7', class: 'muted', text: '—' })));
  body.append(
    table(v.c.kind === 'incomplete', [th('#', L), th(COL_WALLET), th(COL_CREW), th(COL_JOIN_HEIGHT, L), th(COL_SURVIVING, L), th(COL_UNIQUE, L), th(COL_TOTAL_STROKES, L)], trs),
  );
}
