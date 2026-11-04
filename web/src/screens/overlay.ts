// Overlay screen (SPEC §6.4 "#/overlay", stretch A, minimal but functional). Transparent background for an
// OBS browser source, 1920x1080 title-safe inset, no wallet, no sound, no canvas. Top-left block chip
// `SQUEEK BLOCK H · settled HH:MM UTC` + FRESH/SETTLED label; on a height-increasing settlement a 6 s edge
// glow + `+N BLOCKS SETTLED · brushes refilled · fresh|settled`; otherwise `no new settled blocks for X`;
// `Core paused` while paused; §7.2 watermark that cannot be dismissed. Polling is the core 12 s ticker;
// this screen only reads the store. The flash fires only when the store's lastKnownHeight (state() at the
// pinned block) rose AND a BatchSettled log at that height is known (heightSettledAtBlock), per §6.3.
import { getBlockHeader } from '../eth';
import * as copy from '../copy';
import { fmtAgo, fmtInt, fmtUtcHHMM, el, clear } from '../format';
import { heightLabel, type Store, type AppState } from '../state';
import type { Route } from '../router';
import type { Actions } from '../main';

// ---- strings from SPEC §6.4 overlay paragraph (not in copy.ts; hoist candidates) ----
function OV_BLOCK(H: string): string {
  return `SQUEEK BLOCK ${H}`;
}
function OV_SETTLED_AT(HHMM: string): string {
  return `settled ${HHMM} UTC`;
}
function OV_FLASH(delta: string, label: 'fresh' | 'settled'): string {
  return `+${delta} BLOCKS SETTLED · brushes refilled · ${label}`;
}
function OV_IDLE(X: string): string {
  return `no new settled blocks for ${X}`;
}
const OV_PAUSED = 'Core paused';

const FLASH_MS = 6_000;
const IDLE_AFTER_MS = 60_000;

const STYLE = `
html[data-overlay],html[data-overlay] body{background:transparent!important}
/* DEVIATION from §7.1 (footer on every route), recorded in the README: the §7.2 watermark replaces the footer on the
   OBS source, where a second disclaimer line would burn into the stream. */
html[data-overlay] .topbar,html[data-overlay] .banners,html[data-overlay] #footer{display:none!important}
html[data-overlay] #app>main{padding:0;max-width:none}
.ov{position:fixed;inset:0;pointer-events:none;font-family:var(--mono);color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.8)}
.ov-safe{position:absolute;inset:54px 96px}
.ov-box{display:inline-flex;align-items:center;gap:12px;background:rgba(11,13,18,.82);border:1px solid rgba(255,255,255,.18);border-radius:8px;padding:8px 16px;white-space:nowrap}
.ov-chip{position:absolute;left:0;top:0;font-size:26px;font-weight:700;letter-spacing:.04em}
.ov-sub{position:absolute;left:0;top:64px;font-size:18px;color:#c9ced6}
.ov-flash{position:absolute;left:0;top:116px;font-size:28px;font-weight:700;background:rgba(58,134,255,.88);border-color:rgba(255,255,255,.4)}
.ov-glow{position:fixed;inset:0;pointer-events:none}
.ov-glow.on{animation:ovglow ${FLASH_MS}ms ease-out forwards}
@keyframes ovglow{0%{box-shadow:inset 0 0 140px 28px rgba(58,134,255,.95)}100%{box-shadow:inset 0 0 0 0 rgba(58,134,255,0)}}
.ov-wm{position:absolute;right:0;bottom:0;font-size:16px;letter-spacing:.06em}
.ov .tag{font-size:14px;vertical-align:middle}
`;

type Flash = { delta: bigint; block: bigint; until: number };

export function mount(root: HTMLElement, store: Store, _route?: Route): () => void {
  const style = el('style', { text: STYLE });
  document.documentElement.dataset.overlay = '1';

  const glow = el('div', { class: 'ov-glow' });
  const chip = el('div', { class: 'ov-box ov-chip' });
  const sub = el('div', { class: 'ov-box ov-sub' });
  const flashEl = el('div', { class: 'ov-box ov-flash' });
  const wm = el('div', { class: 'ov-box ov-wm', text: copy.OVERLAY_WATERMARK, 'aria-label': copy.OVERLAY_WATERMARK });
  const safe = el('div', { class: 'ov-safe' }, chip, sub, flashEl, wm);
  const layer = el('div', { class: 'ov', role: 'status', 'aria-live': 'polite' }, glow, safe);
  root.append(style, layer);

  let flash: Flash | null = null;
  let flashTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  // Settlement timestamp: the ETH block that brought the current height (store.heightSettledAtBlock) has no
  // timestamp in the store, so read that block's header from the same provider as the tick, cached per block.
  // Local helper (core has none); the Play idle card needs the same value, so it is a hoist candidate.
  const tsCache = new Map<string, number>();
  let inflight: string | null = null;
  const pit = () => (window as unknown as { pit?: Actions }).pit;
  function settlementTime(s: AppState): number | null {
    const b = s.heightSettledAtBlock;
    const t = s.tick;
    if (b === null) return null;
    const key = b.toString();
    const hit = tsCache.get(key);
    if (hit !== undefined) return hit;
    if (t && t.ok && t.head === b) {
      const ms = Number(t.headTimestamp) * 1000;
      tsCache.set(key, ms);
      return ms;
    }
    if (inflight !== key) {
      inflight = key;
      const client = pit()?.clients[t && t.ok ? t.providerIndex : 0];
      if (client) {
        getBlockHeader(client.pub, b)
          .then((bl) => {
            tsCache.set(key, Number(bl.timestamp) * 1000);
            if (inflight === key) inflight = null;
            if (!disposed) render(store.get());
          })
          .catch(() => {
            if (inflight === key) inflight = null;
          });
      } else inflight = null;
    }
    return null;
  }

  function render(s: AppState): void {
    const t = s.tick;
    const now = Date.now();
    clear(chip);
    clear(sub);
    sub.hidden = true;
    flashEl.hidden = true;

    if (!t || !t.ok) {
      const at = t?.at ?? now;
      chip.append(el('span', { class: 'tag tag-unknown', text: copy.LABEL_UNKNOWN }), copy.CHIP_UNKNOWN(fmtUtcHHMM(at)));
      return;
    }

    const label = heightLabel(s.heightSettledAtBlock, t.safe);
    const ts = settlementTime(s);
    chip.append(OV_BLOCK(fmtInt(t.state.blockHeight)));
    if (ts !== null) chip.append(` · ${OV_SETTLED_AT(fmtUtcHHMM(ts))}`);
    chip.append(el('span', { class: label === 'SETTLED' ? 'tag tag-settled' : 'tag tag-fresh', text: label }));

    if (flash && flash.until > now) {
      const fl = flash.block <= t.safe ? 'settled' : 'fresh';
      flashEl.hidden = false;
      flashEl.textContent = OV_FLASH(fmtInt(flash.delta), fl);
    } else if (t.state.paused) {
      sub.hidden = false;
      sub.append(OV_PAUSED);
    } else if (ts !== null && now - ts >= IDLE_AFTER_MS) {
      sub.hidden = false;
      sub.append(OV_IDLE(fmtAgo(ts, now)));
    }
  }

  function startFlash(delta: bigint, block: bigint): void {
    flash = { delta, block, until: Date.now() + FLASH_MS };
    glow.classList.remove('on');
    void glow.offsetWidth; // restart the CSS animation
    glow.classList.add('on');
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(() => {
      glow.classList.remove('on');
      render(store.get());
    }, FLASH_MS + 50);
  }

  const unsub = store.subscribe((s, prev) => {
    // §6.3 flash rule: BatchSettled-derived height rose AND state() at that block agrees (both are what
    // main.ts requires before it sets lastKnownHeight + heightSettledAtBlock together).
    if (prev.lastKnownHeight !== null && s.lastKnownHeight !== null && s.lastKnownHeight > prev.lastKnownHeight && s.heightSettledAtBlock !== null) {
      startFlash(s.lastKnownHeight - prev.lastKnownHeight, s.heightSettledAtBlock);
    }
    render(s);
  });
  const clock = setInterval(() => render(store.get()), 30_000); // keeps "for 3h 12m" current between ticks
  render(store.get());

  return () => {
    disposed = true;
    unsub();
    clearInterval(clock);
    if (flashTimer) clearTimeout(flashTimer);
    delete document.documentElement.dataset.overlay;
    style.remove();
    layer.remove();
  };
}
