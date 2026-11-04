// Small formatting helpers shared by the UI. No data source lives here.

export function shortAddr(addr: string, head = 6, tail = 4): string {
  if (!addr || addr.length < head + tail + 2) return addr;
  return `${addr.slice(0, head)}…${addr.slice(-tail)}`;
}

export function shortHash(h: string): string {
  return shortAddr(h, 6, 4);
}

export function fmtInt(n: bigint | number): string {
  const s = typeof n === 'bigint' ? n.toString() : Math.trunc(n).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** "12,061,0xx" style: full number with commas; the spec's examples mask trailing digits only in prose. */
export function fmtBlock(n: bigint | number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  return fmtInt(n);
}

export function fmtUtcHHMM(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export function fmtUtcTime(ms: number): string {
  return `${fmtUtcHHMM(ms)} UTC`;
}

/** "3h 12m" / "45m" / "20s" */
export function fmtAgo(fromMs: number, nowMs: number = Date.now()): string {
  let s = Math.max(0, Math.floor((nowMs - fromMs) / 1000));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function fmtEth(wei: bigint, digits = 4): string {
  const whole = wei / 10n ** 18n;
  const frac = wei % 10n ** 18n;
  const fracStr = frac.toString().padStart(18, '0').slice(0, digits);
  return `${whole.toString()}.${fracStr}`;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | boolean | undefined> | null,
  ...children: (Node | string | null | undefined)[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === false) continue;
      if (k === 'class') e.className = String(v);
      else if (k === 'text') e.textContent = String(v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

export function clear(node: HTMLElement): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
