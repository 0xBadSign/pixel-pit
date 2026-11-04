// #/timeline?h=N (SPEC §6.4 TIMELINE): full-width read-only canvas, slider over Squeek height
// GENESIS_HEIGHT..current with a tick at every height-raising BatchSettled and night separators (12:00 UTC),
// arrow keys step one settlement, Play 1x/4x/16x, side panel line, CONFIRMED/RECENT stamp, Copy link.
// Frame h = GENESIS_CELLS + Painted events with coreHeight <= h in (blockNumber, logIndex) order (§6.3).
// Everything here is derived from the store (logs snapshot + tick); no RPC call is made from this screen,
// so it works with no wallet and with no new blocks.
import { CONFIG, crewName, paletteName, type Config } from '../config';
import * as copy from '../copy';
import { el, clear, fmtInt, fmtBlock, fmtUtcHHMM } from '../format';
import { frame, genesisFrame, decodeCell, cellXY, sortPainted } from '../frame';
import { PitCanvas } from '../canvas';
import { hrefFor, parseHash, type Route } from '../router';
import type { Store, AppState } from '../state';
import type { LogsSnapshot } from '../logs';

// ---------- local copy (not in SPEC §7; factual control labels, listed for hoisting into copy.ts) ----------
export const TL = {
  PLAY: 'Play',
  PAUSE: 'Pause',
  SPEEDS: [1, 4, 16] as const,
  SPEED: (x: number) => `${x}x`,
  COPY_LINK: 'Copy link',
  COPIED: 'link copied',
  SLIDER: 'Timeline: Squeek block height',
  SQUEEK_BLOCK: (H: string) => `Squeek block ${H}`,
  NIGHT: (day: string) => `night separator 12:00 UTC ${day} (position estimated from 12 s blocks)`,
  STATE_STEP: 'height read from state() at head; its BatchSettled log is not loaded yet',
} as const;

// ---------- pure model ----------

export type TimelineStep = {
  index: number;
  height: bigint; // Squeek height after this settlement (step 0 = GENESIS_HEIGHT)
  delta: bigint; // height - previous step height
  round: bigint | null; // settledThroughRound (null for the genesis step)
  blockNumber: bigint; // ETH block of the BatchSettled (step 0: PIT_DEPLOY_BLOCK; 'state': head)
  source: 'genesis' | 'log' | 'state';
};

export type Current = { height: bigint; round: bigint; head: bigint } | null;

/** Steps = genesis + every BatchSettled that raised the height + (if state() at head is above the last log) one 'state' step. */
export function buildSteps(snap: LogsSnapshot | null, current: Current, cfg: Config = CONFIG): TimelineStep[] {
  const steps: TimelineStep[] = [{ index: 0, height: cfg.GENESIS_HEIGHT, delta: 0n, round: null, blockNumber: cfg.PIT_DEPLOY_BLOCK, source: 'genesis' }];
  let last = cfg.GENESIS_HEIGHT;
  if (snap) {
    const settled = [...snap.settled].sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex));
    for (const s of settled) {
      if (s.height <= last) continue;
      steps.push({ index: steps.length, height: s.height, delta: s.height - last, round: s.settledThroughRound, blockNumber: s.blockNumber, source: 'log' });
      last = s.height;
    }
  }
  if (current && current.height > last) {
    steps.push({ index: steps.length, height: current.height, delta: current.height - last, round: current.round, blockNumber: current.head, source: 'state' });
  }
  return steps;
}

/** Index of the last step with height <= h (0 when h is below genesis). */
export function stepForHeight(steps: readonly TimelineStep[], h: bigint): number {
  let i = 0;
  for (let k = 0; k < steps.length; k++) if (steps[k]!.height <= h) i = k;
  return i;
}

const genesisCache = new WeakMap<Config, Uint32Array>();
function genesisOf(cfg: Config): Uint32Array {
  let g = genesisCache.get(cfg);
  if (!g) {
    g = genesisFrame(cfg.GENESIS_CELLS, cfg.GENESIS_COLORS);
    genesisCache.set(cfg, g);
  }
  return g;
}

export type StepView = {
  frame: Uint32Array; // frame(h) per §6.3
  strokes: number; // Painted cells with prevHeight < coreHeight <= h
  wallets: number; // distinct painters of those strokes
  filled: number; // cells with a non-zero record (genesis or player stroke)
  lastEventBlock: bigint; // max ETH block of the settlement and of every Painted in the frame
  fresh: Set<number>; // cells whose last stroke in this frame is in a block > safe (empty when safe is null)
};

export function stepView(steps: readonly TimelineStep[], i: number, snap: LogsSnapshot | null, safe: bigint | null, cfg: Config = CONFIG): StepView {
  const step = steps[i] ?? steps[0]!;
  const prevH = i > 0 ? steps[i - 1]!.height : null;
  const painted = snap?.painted ?? [];
  const crews = snap?.crewByPlayerId ?? new Map<number, number>();
  const f = frame(step.height, painted, crews, genesisOf(cfg));
  let strokes = 0;
  const wallets = new Set<string>();
  let lastEventBlock = step.blockNumber;
  const inFrame = painted.filter((p) => p.coreHeight <= step.height);
  for (const p of inFrame) {
    if (p.blockNumber > lastEventBlock) lastEventBlock = p.blockNumber;
    if (prevH === null || p.coreHeight > prevH) {
      strokes += p.cells.length;
      wallets.add(p.player.toLowerCase());
    }
  }
  const fresh = new Set<number>();
  if (safe !== null) {
    const lastBlock = new Map<number, bigint>();
    for (const p of sortPainted(inFrame)) for (const c of p.cells) lastBlock.set(c, p.blockNumber);
    for (const [c, b] of lastBlock) if (b > safe) fresh.add(c);
  }
  let filled = 0;
  for (let c = 0; c < f.length; c++) if (f[c] !== 0) filled++;
  return { frame: f, strokes, wallets: wallets.size, filled, lastEventBlock, fresh };
}

/** CONFIRMED when the frame's last event block is <= safe, RECENT otherwise, UNKNOWN without a safe block. */
export function frameStamp(lastEventBlock: bigint, safe: bigint | null): 'CONFIRMED' | 'RECENT' | 'UNKNOWN' {
  if (safe === null) return 'UNKNOWN';
  return lastEventBlock <= safe ? 'CONFIRMED' : 'RECENT';
}

export type NightMarker = { height: number; day: string };

/**
 * 12:00 UTC boundaries between consecutive steps. Block times are ESTIMATED from the head timestamp and
 * 12 s Sepolia slots (logs carry no timestamps); the marker is a visual separator only and says so.
 */
export function nightMarkers(steps: readonly TimelineStep[], tick: { head: bigint; headTimestamp: bigint } | null): NightMarker[] {
  const out: NightMarker[] = [];
  if (!tick || steps.length < 2) return out;
  const ts = (b: bigint) => Number(tick.headTimestamp) - Number(tick.head - b) * 12;
  for (let i = 0; i + 1 < steps.length; i++) {
    const a = steps[i]!;
    const b = steps[i + 1]!;
    const t0 = ts(a.blockNumber);
    const t1 = ts(b.blockNumber);
    if (!(t1 > t0) || t0 < 0 || t1 - t0 > 400 * 86400) continue; // placeholder deploy block or nonsense: skip
    let T = Math.floor(t0 / 86400) * 86400 + 43200;
    if (T <= t0) T += 86400;
    for (; T <= t1 && out.length < 400; T += 86400) {
      const frac = (T - t0) / (t1 - t0);
      out.push({ height: Number(a.height) + Number(b.height - a.height) * frac, day: new Date(T * 1000).toISOString().slice(0, 10) });
    }
  }
  return out;
}

export function timelineHref(h: bigint): string {
  return hrefFor('/timeline', { h: h.toString() });
}

export function timelineUrl(h: bigint): string {
  const base = typeof location !== 'undefined' ? location.href.split('#')[0]! : '';
  return `${base}${timelineHref(h)}`;
}

// ---------- screen ----------

const CSS = `
.timeline{display:flex;flex-direction:column;gap:10px}
.tl-head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-family:var(--mono);font-size:13px}
.tl-stamp{display:inline-block;padding:0 5px;border-radius:3px;font-family:var(--mono);font-size:11px;font-weight:700;letter-spacing:.04em}
.tl-stamp-confirmed{background:var(--green);color:#0b0d12}
.tl-stamp-recent{border:1px solid var(--blue);color:var(--blue)}
.tl-stamp-unknown{border:1px solid var(--grey);color:var(--muted)}
.tl-incomplete .tl-panel{font-style:italic;color:var(--muted)}
.tl-canvas{width:min(100%,calc(100vh - 280px));min-width:256px;margin:0 auto}
.tl-sub{min-height:1.4em;font-family:var(--mono);font-size:12px}
.tl-controls{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-family:var(--mono);font-size:12px}
.tl-controls button{font-family:var(--mono);font-size:12px}
.tl-controls button[aria-pressed="true"]{border-color:var(--amber);color:var(--amber)}
.tl-panel{display:inline-block;padding:4px 10px;border:2px solid var(--line);border-radius:6px;background:var(--panel);box-shadow:var(--bevel)}
.tl-slider{position:relative;padding:4px 0 0}
.tl-slider input{width:100%;margin:0;display:block;min-height:32px;accent-color:var(--amber)}
.tl-ticks{position:relative;height:14px;margin-top:2px}
.tl-tick{position:absolute;top:0;width:1px;height:7px;background:var(--muted)}
.tl-tick-sel{background:var(--fg);width:2px;height:14px}
.tl-night{position:absolute;top:-2px;width:0;height:16px;border-left:1px dashed var(--amber)}
.tl-axis{display:flex;justify-content:space-between;font-family:var(--mono);font-size:11px}
.tl-complete{margin:0;font-size:12px}
@media (max-width:640px){.tl-slider input{height:44px}.tl-canvas{width:100%}}
`;

export function mount(root: HTMLElement, store: Store, route: Route = parseHash(typeof location !== 'undefined' ? location.hash : '')): () => void {
  const cfg = CONFIG;
  const section = el('section', { class: 'timeline' });
  section.append(el('style', { text: CSS }));

  // head: labels + panel line
  const head = el('div', { class: 'tl-head' });
  const canvasWrap = el('div', { class: 'tl-canvas' });
  const sub = el('div', { class: 'tl-sub muted' });
  const frame0 = el('span', { class: 'tl-frame0' });
  const hover = el('span', { class: 'tl-hover' });
  sub.append(frame0, ' ', hover);

  // controls
  const controls = el('div', { class: 'tl-controls' });
  const playBtn = el('button', { type: 'button', class: 'tl-play', text: TL.PLAY });
  const speedBtns = TL.SPEEDS.map((x) => el('button', { type: 'button', class: 'tl-speed', 'data-speed': String(x), 'aria-pressed': x === 1 ? 'true' : 'false', text: TL.SPEED(x) }));
  const copyBtn = el('button', { type: 'button', class: 'tl-copy', text: TL.COPY_LINK });
  const copied = el('span', { class: 'tl-copied muted', 'aria-live': 'polite' });
  controls.append(playBtn, ...speedBtns, copyBtn, copied);

  // slider
  const sliderWrap = el('div', { class: 'tl-slider' });
  const slider = el('input', { type: 'range', class: 'tl-range', 'aria-label': TL.SLIDER, min: '0', max: '0', step: '1', value: '0' });
  const ticks = el('div', { class: 'tl-ticks', 'aria-hidden': 'true' });
  const axis = el('div', { class: 'tl-axis muted' });
  sliderWrap.append(slider, ticks, axis);

  const complete = el('p', { class: 'tl-complete muted' });
  section.append(head, canvasWrap, sub, controls, sliderWrap, complete);
  root.append(section);

  let canvas: PitCanvas | null = null;
  try {
    canvas = new PitCanvas(canvasWrap, { showGenesisFrame: true });
  } catch (e) {
    console.warn('[timeline] canvas unavailable', e);
  }

  // ---------- state ----------
  let steps: TimelineStep[] = buildSteps(null, null, cfg);
  let snap: LogsSnapshot | null = null;
  let safe: bigint | null = null;
  let tickAt: number | null = null;
  let tickInfo: { head: bigint; headTimestamp: bigint } | null = null;
  let selected = 0;
  const hParam = route.query.get('h');
  let wantH: bigint | null = null;
  if (hParam !== null && /^\d+$/.test(hParam)) wantH = BigInt(hParam);
  let follow = wantH === null; // follow the newest step until the user picks one
  let speed: 1 | 4 | 16 = 1;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastLogs: LogsSnapshot | null | undefined;
  let lastTickAt: number | null | undefined;

  const stepHeight = (i: number) => steps[Math.max(0, Math.min(steps.length - 1, i))]!.height;

  function rebuild(s: AppState): void {
    const t = s.tick && s.tick.ok ? s.tick : s.lastGood;
    snap = s.logs;
    safe = t ? t.safe : null;
    tickAt = s.tick ? s.tick.at : null;
    tickInfo = t ? { head: t.head, headTimestamp: t.headTimestamp } : null;
    const current: Current = t ? { height: t.state.blockHeight, round: t.state.settledThroughRound, head: t.head } : null;
    steps = buildSteps(snap, current, cfg);
    if (wantH !== null) {
      // A shared link: resolve ?h only once real data exists. The router mounts this screen before the first
      // tick (logs=null, tick=null => steps=[genesis]); resolving then would land on genesis and, with `follow`
      // set, jump to the newest frame when the logs arrive.
      if (snap !== null && t) {
        selected = stepForHeight(steps, wantH);
        wantH = null;
        follow = selected === steps.length - 1;
      } else {
        selected = 0;
      }
    } else if (follow) {
      selected = steps.length - 1;
    } else if (selected > steps.length - 1) {
      selected = steps.length - 1;
    }
    renderSlider();
  }

  function renderSlider(): void {
    const lo = Number(steps[0]!.height);
    const hi = Math.max(lo, Number(steps[steps.length - 1]!.height));
    slider.min = String(lo);
    slider.max = String(hi);
    slider.disabled = hi === lo;
    clear(ticks);
    const span = hi - lo;
    const pos = (h: number) => (span === 0 ? 0 : ((h - lo) / span) * 100);
    for (const n of nightMarkers(steps, tickInfo)) {
      ticks.append(el('span', { class: 'tl-night', style: `left:${pos(n.height).toFixed(3)}%`, title: TL.NIGHT(n.day) }));
    }
    for (const st of steps) {
      if (st.index === 0) continue;
      ticks.append(el('span', { class: `tl-tick${st.index === selected ? ' tl-tick-sel' : ''}`, 'data-step': String(st.index), style: `left:${pos(Number(st.height)).toFixed(3)}%` }));
    }
    clear(axis);
    axis.append(el('span', { text: `${copy.LABEL_GENESIS} · ${TL.SQUEEK_BLOCK(fmtInt(steps[0]!.height))}` }), el('span', { text: TL.SQUEEK_BLOCK(fmtInt(steps[steps.length - 1]!.height)) }));
    renderFrame();
  }

  function renderFrame(): void {
    const step = steps[selected]!;
    slider.value = step.height.toString();
    slider.setAttribute('aria-valuetext', TL.SQUEEK_BLOCK(fmtInt(step.height)));
    for (const t of ticks.querySelectorAll<HTMLElement>('.tl-tick')) t.classList.toggle('tl-tick-sel', t.dataset.step === String(selected));
    const view = stepView(steps, selected, snap, safe, cfg);
    canvas?.setFrame(view.frame);
    canvas?.setFresh(view.fresh);

    const stamp = frameStamp(view.lastEventBlock, safe);
    const stampEl = el('span', { class: `tl-stamp tl-stamp-${stamp.toLowerCase()}`, text: stamp === 'CONFIRMED' ? copy.LABEL_CONFIRMED : stamp === 'RECENT' ? copy.LABEL_RECENT : copy.LABEL_UNKNOWN });
    const label = stamp === 'CONFIRMED' ? copy.LABEL_SETTLED : stamp === 'RECENT' ? copy.LABEL_FRESH : copy.LABEL_UNKNOWN;
    const labelEl = el('span', { class: `tag tag-${label.toLowerCase()}`, text: label });
    const incomplete = !!snap && snap.incomplete;
    section.classList.toggle('tl-incomplete', incomplete);

    const completeN = snap && snap.completeThrough !== null ? (safe !== null && safe < snap.completeThrough ? safe : snap.completeThrough) : null;
    clear(head);
    head.append(labelEl, stampEl);
    if (incomplete) head.append(el('span', { class: 'tag tag-incomplete', text: copy.LABEL_INCOMPLETE }));
    if (!snap) {
      head.append(el('span', { class: 'tl-panel', text: copy.CHIP_UNKNOWN(fmtUtcHHMM(tickAt ?? Date.now())) }));
    } else if (step.source === 'genesis') {
      head.append(el('span', { class: 'tag tag-settled', text: copy.LABEL_GENESIS }), el('span', { class: 'tl-panel', text: `${copy.GENESIS_FRAME0} · ${copy.COMPLETE_THROUGH(fmtBlock(completeN))}` }));
    } else {
      const line = copy.TIMELINE_PANEL(fmtInt(step.height), fmtInt(step.delta), step.round === null ? '—' : fmtInt(step.round), fmtInt(view.strokes), fmtInt(view.wallets), fmtInt(view.filled), fmtBlock(completeN));
      head.append(el('span', { class: 'tl-panel', title: step.source === 'state' ? TL.STATE_STEP : `ETH block ${fmtBlock(step.blockNumber)}`, text: line }));
    }
    frame0.textContent = step.source === 'genesis' ? `${copy.LABEL_GENESIS} · ${copy.GENESIS_FRAME0}` : '';

    clear(complete);
    if (!snap) {
      complete.append(el('span', { class: 'tag tag-unknown', text: copy.LABEL_UNKNOWN }), ' ', copy.CHIP_UNKNOWN(fmtUtcHHMM(tickAt ?? Date.now())));
    } else if (incomplete) {
      complete.append(el('span', { class: 'tag tag-incomplete', text: copy.LABEL_INCOMPLETE }), ' ', el('em', { text: copy.INCOMPLETE_LINE(fmtInt(snap.failedChunks)) }));
    } else {
      complete.append(el('span', { class: 'tag tag-settled', text: copy.LABEL_SETTLED }), ' ', copy.COMPLETE_LINE(fmtBlock(cfg.PIT_DEPLOY_BLOCK), fmtBlock(completeN)));
    }
    playBtn.textContent = timer ? TL.PAUSE : TL.PLAY;
  }

  function select(i: number, fromUser: boolean): void {
    const next = Math.max(0, Math.min(steps.length - 1, i));
    selected = next;
    follow = selected === steps.length - 1;
    if (fromUser && typeof history !== 'undefined' && typeof history.replaceState === 'function') {
      try {
        history.replaceState(null, '', follow ? hrefFor('/timeline') : timelineHref(stepHeight(selected)));
      } catch {
        /* ignore */
      }
    }
    renderFrame();
  }

  // ---------- play ----------
  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    playBtn.textContent = TL.PLAY;
  }
  function play(): void {
    stop();
    if (steps.length < 2) return;
    if (selected >= steps.length - 1) select(0, true);
    timer = setInterval(() => {
      if (selected >= steps.length - 1) {
        stop();
        return;
      }
      select(selected + 1, true);
    }, Math.round(1000 / speed));
    playBtn.textContent = TL.PAUSE;
  }
  playBtn.addEventListener('click', () => (timer ? stop() : play()));
  for (const b of speedBtns) {
    b.addEventListener('click', () => {
      speed = Number(b.dataset.speed) as 1 | 4 | 16;
      for (const o of speedBtns) o.setAttribute('aria-pressed', o === b ? 'true' : 'false');
      if (timer) play();
    });
  }

  // ---------- copy link ----------
  copyBtn.addEventListener('click', () => {
    const url = timelineUrl(stepHeight(selected));
    const done = () => {
      copied.textContent = `${TL.COPIED} · ${timelineHref(stepHeight(selected))}`;
    };
    const fail = () => {
      copied.textContent = url;
    };
    try {
      const cb = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
      if (cb && typeof cb.writeText === 'function') cb.writeText(url).then(done, fail);
      else fail();
    } catch {
      fail();
    }
  });

  // ---------- slider + keys ----------
  slider.addEventListener('input', () => {
    const v = BigInt(Math.round(Number(slider.value) || 0));
    stop();
    select(stepForHeight(steps, v), true);
  });
  const onKey = (ev: KeyboardEvent) => {
    const t = ev.target as HTMLElement | null;
    if (t && t !== slider) {
      const tag = t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable) return;
    }
    const onSlider = t === slider;
    let d = 0;
    if (ev.key === 'ArrowLeft' || (onSlider && ev.key === 'ArrowDown')) d = -1;
    else if (ev.key === 'ArrowRight' || (onSlider && ev.key === 'ArrowUp')) d = 1;
    else if (onSlider && ev.key === 'Home') d = -steps.length;
    else if (onSlider && ev.key === 'End') d = steps.length;
    else return;
    ev.preventDefault();
    stop();
    select(selected + d, true);
  };
  document.addEventListener('keydown', onKey);

  // ---------- hover ----------
  canvas?.onHoverCell((h) => {
    if (!h) {
      hover.textContent = '';
      return;
    }
    const rec = canvas!.getFrame()[h.cell] ?? 0;
    const c = decodeCell(rec);
    const { x, y } = cellXY(h.cell);
    let text = `${x},${y} · ${paletteName(c.color)}`;
    if (c.genesis) text += ` · ${copy.GENESIS_HOVER}`;
    else if (c.painterId !== 0) text += ` · ${crewName(c.crew)} · painter #${c.painterId}`;
    hover.textContent = text;
  });

  // ---------- store ----------
  const onState = (s: AppState) => {
    if (s.logs === lastLogs && (s.tick ? s.tick.at : null) === lastTickAt) return;
    lastLogs = s.logs;
    lastTickAt = s.tick ? s.tick.at : null;
    rebuild(s);
  };
  onState(store.get());
  const unsub = store.subscribe(onState);

  return () => {
    stop();
    unsub();
    document.removeEventListener('keydown', onKey);
    canvas?.destroy();
    section.remove();
  };
}
