// Top bar (SPEC §6.4): wordmark PIXEL PIT · nav Play / Timeline / Board / How · chips · wallet button.
// Overlay is a stretch route; it is reachable by hash but not shown in the nav until it exists.
import { el } from '../format';
import { hrefFor, parseHash } from '../router';
import type { Store } from '../state';
import { mountStatus, type StatusActions } from './status';

export const NAV: readonly { path: string; label: string }[] = [
  { path: '/', label: 'Play' },
  { path: '/timeline', label: 'Timeline' },
  { path: '/board', label: 'Board' },
  { path: '/how', label: 'How' },
];

export function mountTopbar(host: HTMLElement, store: Store, actions: StatusActions): () => void {
  const bar = el('header', { class: 'topbar', role: 'banner' });
  const brand = el('a', { class: 'wordmark', href: '#/' }, 'PIXEL PIT');
  const nav = el('nav', { class: 'nav', 'aria-label': 'Main' });
  const links = NAV.map((n) => el('a', { href: hrefFor(n.path), 'data-path': n.path }, n.label));
  nav.append(...links);
  const chips = el('div', { class: 'chips' });
  bar.append(brand, nav, chips);
  host.prepend(bar);

  const setActive = () => {
    const { path } = parseHash(location.hash);
    for (const a of links) {
      if (a.dataset.path === path) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  };
  setActive();
  window.addEventListener('hashchange', setActive);
  const unsub = mountStatus(chips, store, actions);
  return () => {
    unsub();
    window.removeEventListener('hashchange', setActive);
    bar.remove();
  };
}

/** Banner strip under the top bar (paused / deployment changed / stale / cache rebuilt). */
export function mountBanners(host: HTMLElement, store: Store): () => void {
  const strip = el('div', { class: 'banners', role: 'status', 'aria-live': 'polite' });
  host.insertBefore(strip, host.children[1] ?? null);
  const render = () => {
    strip.replaceChildren(...store.get().banners.map((b) => el('div', { class: `banner banner-${b.kind}`, 'data-id': b.id, text: b.text })));
  };
  render();
  const unsub = store.subscribe(render);
  return () => {
    unsub();
    strip.remove();
  };
}
