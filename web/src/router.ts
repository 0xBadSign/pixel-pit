// Hash router: #/ #/timeline #/board #/how #/overlay (SPEC §6.4). Query after the path (#/timeline?h=N).
import type { Store } from './state';

export type Route = { path: string; query: URLSearchParams };

export type ScreenMount = (root: HTMLElement, store: Store, route: Route) => void | (() => void);

export type ScreenRegistry = Record<string, ScreenMount>;

export function parseHash(hash: string): Route {
  let h = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!h.startsWith('/')) h = `/${h}`;
  const q = h.indexOf('?');
  const path = (q >= 0 ? h.slice(0, q) : h).replace(/\/+$/, '') || '/';
  const query = new URLSearchParams(q >= 0 ? h.slice(q + 1) : '');
  return { path, query };
}

export function hrefFor(path: string, query?: Record<string, string>): string {
  const qs = query ? new URLSearchParams(query).toString() : '';
  return `#${path}${qs ? `?${qs}` : ''}`;
}

export type Router = {
  current(): Route;
  navigate(path: string, query?: Record<string, string>): void;
  onChange(cb: (r: Route) => void): () => void;
  start(): void;
  stop(): void;
};

export function createRouter(root: HTMLElement, store: Store, screens: ScreenRegistry, notFound: ScreenMount): Router {
  let route = parseHash(location.hash);
  let cleanup: (() => void) | void;
  const listeners = new Set<(r: Route) => void>();

  const render = () => {
    route = parseHash(location.hash);
    if (typeof cleanup === 'function') cleanup();
    root.replaceChildren();
    const mount = screens[route.path] ?? notFound;
    cleanup = mount(root, store, route);
    root.dataset.route = route.path;
    for (const l of listeners) l(route);
  };

  const onHash = () => render();

  return {
    current: () => route,
    navigate(path, query) {
      location.hash = hrefFor(path, query);
    },
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    start() {
      window.addEventListener('hashchange', onHash);
      render();
    },
    stop() {
      window.removeEventListener('hashchange', onHash);
      if (typeof cleanup === 'function') cleanup();
    },
  };
}
