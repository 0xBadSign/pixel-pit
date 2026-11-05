// How screen (SPEC §6.4 "#/how", §7). A static explainer: 60-second rules opening with the §1 mechanic
// sentence, the exact Squeekchain surface used, the §6.5 trust model + label legend, the §7.10 deployment
// note ({date}/{tx} marked as not filled yet), the §7.11 season note, prior art, bots/genesis notes, known
// limits, faucets, addresses + Blockscout + repo placeholder and the `forge snapshot` placeholder.
// Every §7 string comes from copy.ts. Strings that §7 does not pin (rules, surface, trust rows, prior art,
// limits, headings) live in HOW below so the integrator can hoist them into copy.ts in one move.
import gasSnapshot from '../gas-snapshot.txt?raw';
import * as copy from '../copy';
import { CONFIG, CAP } from '../config';
import { el, shortAddr } from '../format';
import type { Store, AppState } from '../state';
import type { Route } from '../router';

const ZERO = '0x0000000000000000000000000000000000000000';
const TODO = 'not filled yet';
/** Facts filled at the Season 2 deploy (2026-11-05); the live deployment check below re-verifies the Core side on every load. */
const DEPLOY_FACTS = {
  date: '2026-11-05',
  lastDocsSettleDate: '2026-11-03',
  lastDocsSettleTx: 'contract 0x4B1D7d9f8499Ad065a8f883a6E4889B855bB38EF',
  repoUrl: 'https://github.com/0xBadSign/pixel-pit',
} as const;

// ---- strings not pinned by §7 (factual, from SPEC §1, §3.4, §6.3, §6.4, §6.5, §10.1, §11 C-5) ----
const HOW = {
  title: 'How Pixel Pit works',
  mechanic:
    'A multiplayer game where each wallet has a brush budget of 0–40 pixels refilled only by settled Squeek blocks; the contract rejects paints beyond budget.',
  hRules: 'The rules in 60 seconds',
  rules: [
    'Connect a Sepolia wallet and join once, picking one of four crews: Wheel, Burrow, Seed or Moon. ' + copy.JOIN_BUDGET_P2,
    copy.JOIN_BUDGET_P1,
    `Paint 1–${CAP} cells in one transaction. Every cell costs 1 pixel, repainting the same cell or the same colour costs again, and there are no refunds. Any paint beyond your budget is rejected by the contract with InsufficientBudget.`,
    `Whatever arrives above the cap is forfeited: a wallet that sleeps through a night wakes up with ${CAP}, not 900. Pixels you already hold can be spent while no new blocks settle.`,
    'No cell ownership, no protection: anyone can overpaint any cell, genesis included. Crews compete for cells held at dawn and for surviving pixels; the Timeline rewinds the whole fight by Squeek block. No backend, no keeper, no admin key.',
  ],
  hSurface: 'Exact Squeekchain surface used',
  surface: [
    'Core.state().blockHeight — read by the Pit contract itself inside join(), paint() and budgetOf() through a gas-capped, fixed-size staticcall, at the block your transaction lands in. If a settlement block is reorged, the budget can change.',
    'BatchSettled logs (Core) — the tick and the settlement flash; the height is cumulativeBlockUnits / 1e9 and is cross-checked against state() at the same block. A flash never comes from the API.',
    'implementationCodeAddress(), the implementation runtime code hash and configuration() (streamId, genesisTimestamp, targetBlocksPerActiveRound) — the deployment check on every load.',
    'api.squeekchain.com /v1/status — only the PROVISIONAL light; /v1/core — only the reported core address shown next to the pinned one. Neither ever touches a budget number.',
  ],
  hTrust: 'Trust model',
  trustHead: ['Topic', 'Behaviour'],
  trust: [
    ['Budget source', 'Only Core.state().blockHeight, at the block of your transaction, read from inside the contract.'],
    ['Core unreadable / gas bomb / return bomb / shape changed / height below GENESIS_HEIGHT', 'CoreUnavailable; budgetOf.coreOk = false; the UI shows UNKNOWN; the season freezes.'],
    ['Core shape the same but field order changed (no upper-bound check)', `At most one silent ${CAP}-pixel fill per wallet; the cap bounds it; the frontend cross-checks against the BatchSettled-derived height and shows "deployment changed" on mismatch.`],
    ['Reorg', 'If a settlement block is reorged the budget can change; head reads are labelled FRESH, blocks at or below safe SETTLED; the log cache keeps only blocks at or below finalized.'],
    ['Sybil', 'No resistance and none claimed (see the bots note); the Board ranks by cells held, not wallets.'],
    ['Admin', 'None. Nobody, the deployer included, can mint budget, wipe the canvas or close the season.'],
  ],
  hLabels: 'Labels (same colour and word on every screen)',
  labels: [
    ['SETTLED', 'tag-settled', 'block ≤ safe'],
    ['FRESH', 'tag-fresh', 'safe < block ≤ head'],
    ['PENDING', 'tag-pending', 'your tx, not mined; counted nowhere'],
    ['PROVISIONAL', 'tag-provisional', 'api.squeekchain.com, display only'],
    ['UNKNOWN', 'tag-unknown', 'RPC/API failure or coreOk = false; never 0'],
    ['INCOMPLETE', 'tag-incomplete', 'log chunks missing; lower bound'],
    ['PRACTICE', 'tag-practice', 'local copy, nothing on-chain'],
  ],
  hDeployment: 'Deployment note',
  thisLoad: 'This load:',
  hSeason: 'Season',
  hPrior: 'Prior art',
  prior: [
    ['Wheel Canvas', 'signers add one stroke each through a token approve(self, 0) call to an artwork drawn by the hamster; no pixel choice, no block-gated budget.'],
    ['Night Canvas', 'art rendered from settlement telemetry; no players, nothing to paint.'],
    ['Squeek Garden', 'reads the Core event feed and renders it; viewing only, no per-wallet paint budget.'],
  ],
  priorPh: 'one-line difference — verify the project before describing it',
  hBots: 'Bots',
  rejected:
    'Rejected on purpose: tx.origin, SIWE or X account linking, an ETH join fee, CAPTCHA, cell ownership and a per-cell lock. A per-cell lock would not stop a raid (the first writer still takes the cell), would remove the right to paint a cell back in the same tick, and cannot be undone in an immutable contract.',
  hGenesis: 'Genesis strokes',
  hLimits: 'Known limits',
  limits: [
    'No sybil resistance: Sepolia wallets are free, so the Board counts wallets, not people.',
    'No cell cooldown and no cell ownership: any cell can be overpainted at any time, genesis included.',
    'Offensive pixel art cannot be erased on-chain and there is no moderation; 32×32 cells and 16 colours limit detail, and anyone can overpaint it.',
    'Settlement gaps: when no Squeek block settles, nobody’s brush fills. No countdown or estimate is shown because nobody knows when he runs.',
    'Public RPC endpoints only (Tenderly, publicnode). When both fail the page shows UNKNOWN, never 0; log-derived tables show INCOMPLETE while a chunk is missing.',
    'If Squeekchain redeploys or upgrades Core in a way the Pit cannot read, the current season freezes (see Season).',
  ],
  hFaucets: 'Sepolia ETH (gas only)',
  hContracts: 'Contracts and source',
  corePinned: 'SqueekCore proxy (pinned)',
  implExpected: 'Expected Core implementation',
  pitSeason: 'Pixel Pit, Season 2',
  repo: 'Source repository',
  verifiedOn: 'verified source on Blockscout',
  repoPh: 'repo URL',
  pitPh: 'PIT address, filled after the Season 2 deploy',
  hGas: 'Gas (forge snapshot)',
  gasPh: 'paste the `forge snapshot` output (.gas-snapshot) here',
  gasNote: 'Local Foundry measurements (whole tests, Cancun gas schedule). Sepolia itself currently prices new storage much higher: the Season 1 deploy used 11,618,905 gas on-chain versus 3,110,529 in the local simulation (measured 2026-11-04), so expect join() and fresh-word paint() calls to cost several times the local figures.',
} as const;

// ---- helpers ----
function ph(text: string): HTMLElement {
  return el('mark', { class: 'how-ph', title: TODO }, `{${text} — ${TODO}}`);
}

/** Render a §7 template whose placeholders were left as literal `{name}` tokens, marking each token. */
function withPlaceholders(text: string, names: Record<string, string>): (Node | string)[] {
  const re = new RegExp(`(${Object.keys(names).map((n) => `\\{${n}\\}`).join('|')})`, 'g');
  return text.split(re).map((part) => {
    const m = /^\{(\w+)\}$/.exec(part);
    return m && names[m[1]!] !== undefined ? ph(names[m[1]!]!) : part;
  });
}

function section(title: string, ...children: (Node | string | null)[]): HTMLElement {
  return el('section', null, el('h2', { text: title }), ...children);
}

function explorerAddr(addr: string): string {
  return `${CONFIG.EXPLORER}/address/${addr}?tab=contract`;
}

function addrRow(label: string, addr: string | null, phText: string): HTMLElement {
  const dt = el('dt', { text: label });
  const dd = el('dd', { class: 'addr mono' });
  if (addr) dd.append(addr, ' · ', el('a', { href: explorerAddr(addr), target: '_blank', rel: 'noopener noreferrer' }, HOW.verifiedOn));
  else dd.append(ph(phText));
  return el('div', { class: 'addr-row' }, dt, dd);
}

/** Live deployment-check line (§6.2): reuses the DEPCHECK_* copy; the API part is PROVISIONAL. */
function depLine(s: AppState): HTMLElement {
  const d = s.deployment;
  const line = el('div', { class: 'live' }, el('span', { class: 'muted', text: `${HOW.thisLoad} ` }));
  if (d.status === 'checking') {
    line.append(copy.DEPCHECK_CHECKING);
    return line;
  }
  if (d.status === 'unreachable') {
    line.append(el('span', { class: 'tag tag-unknown', text: copy.LABEL_UNKNOWN }), ` ${copy.DEPCHECK_CORE_UNREACHABLE}`);
    return line;
  }
  if (d.status === 'ok') line.append(el('span', { class: 'chip-ok', text: copy.DEPCHECK_OK(shortAddr(CONFIG.CORE), shortAddr(CONFIG.EXPECTED_IMPL)) }));
  else line.append(el('span', { class: 'chip-bad', title: d.mismatches.join('; '), text: copy.DEPCHECK_CHANGED }));
  line.append(' · ', el('span', { class: 'dot dot-provisional', title: copy.LABEL_PROVISIONAL }), ' ');
  if (d.apiCore) {
    const match = d.apiCore.toLowerCase() === CONFIG.CORE.toLowerCase();
    line.append(match ? copy.DEPCHECK_API_MATCH(shortAddr(d.apiCore)) : copy.DEPCHECK_API_MISMATCH(shortAddr(d.apiCore)));
  } else line.append(copy.DEPCHECK_API_UNKNOWN);
  return line;
}

// Screen-local styles (hoist into style.css if the integrator prefers one sheet).
const STYLE = `
.how{max-width:860px;margin:0 auto}.how h1{font:24px/1.5 var(--pixel);text-transform:uppercase;color:var(--amber);text-shadow:2px 2px 0 var(--shadow);margin:0 0 6px;padding-top:1px}
.how h2{font:16px/1.5 var(--pixel);text-transform:uppercase;color:var(--amber);margin:0 0 8px;padding-top:1px}
.how section{border:2px solid var(--line);border-radius:6px;background:var(--panel);box-shadow:var(--bevel);padding:12px 14px;margin:14px 0}
.how p,.how li,.how dd{line-height:1.55}.how p{margin:8px 0}.how ol,.how ul{padding-left:22px;margin:6px 0}.how li{margin:6px 0}
.how .lead{font-size:15px;font-weight:600}
.how table{border-collapse:collapse;width:100%;font-size:13px}.how th,.how td{border:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}.how th{background:var(--panel)}
.how .legend{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:baseline}
.how-ph{background:#3a2d12;color:var(--yellow);border:1px dashed var(--yellow);border-radius:3px;padding:0 4px;font-family:var(--mono);font-size:12px}
.how pre{background:var(--panel);border:1px solid var(--line);padding:10px;overflow:auto;font-size:12px;white-space:pre-wrap}
.how dl{margin:0}.how .addr-row{margin:8px 0}.how dt{color:var(--muted);font-size:12px}.how dd{margin:0;word-break:break-all;font-size:13px}
.how .live{border:1px solid var(--line);border-radius:6px;padding:8px 10px;background:var(--panel);font-family:var(--mono);font-size:12px;margin:10px 0}
.how .chip-ok{color:var(--green)}.how .chip-bad{color:var(--red-text)}.how .faucets a{word-break:break-all}
`;

export function mount(root: HTMLElement, store: Store, _route?: Route): () => void {
  const style = el('style', { text: STYLE });
  const page = el('article', { class: 'how' });
  const pitSet = CONFIG.PIT.toLowerCase() !== ZERO;

  // header + rules (opens with the §1 mechanic sentence)
  page.append(el('h1', { text: HOW.title }), el('p', { class: 'lead', text: HOW.mechanic }));
  page.append(section(HOW.hRules, el('ol', null, el('li', { text: HOW.mechanic }), ...HOW.rules.map((r) => el('li', { text: r })))));

  // Squeekchain surface
  page.append(section(HOW.hSurface, el('ul', null, ...HOW.surface.map((r) => el('li', { text: r })))));

  // trust model + labels
  const table = el('table', null, el('thead', null, el('tr', null, ...HOW.trustHead.map((h) => el('th', { text: h })))), el('tbody', null, ...HOW.trust.map(([k, v]) => el('tr', null, el('td', { text: k }), el('td', { text: v })))));
  const legend = el('div', { class: 'legend' });
  for (const [word, cls, when] of HOW.labels) legend.append(el('span', { class: `tag ${cls}`, text: word }), el('span', { text: when }));
  page.append(section(HOW.hTrust, table), section(HOW.hLabels, legend, el('p', { class: 'muted mono', text: copy.WORDING_LINE })));

  // deployment note (§7.10) with {date}/{tx} placeholders + live check line
  let live = depLine(store.get());
  page.append(section(HOW.hDeployment, el('p', { text: copy.DEPLOYMENT_NOTE(DEPLOY_FACTS.date, DEPLOY_FACTS.lastDocsSettleDate, DEPLOY_FACTS.lastDocsSettleTx) }), live));

  // season note (§7.11)
  page.append(section(HOW.hSeason, el('p', null, ...(pitSet ? [copy.SEASON_NOTE(CONFIG.PIT)] : withPlaceholders(copy.SEASON_NOTE('{PIT}'), { PIT: HOW.pitPh })))));

  // prior art: one neutral line each; unknown projects stay a visible placeholder rather than a guess
  page.append(section(HOW.hPrior, el('ul', null, ...HOW.prior.map(([name, line]) => el('li', null, el('strong', { text: `${name} — ` }), line ?? ph(HOW.priorPh))))));

  // bots (§7.4) + rejected measures, genesis (§7.5), known limits
  page.append(section(HOW.hBots, el('p', { text: copy.BOARD_BOTS_NOTE }), el('p', { class: 'muted', text: HOW.rejected })));
  page.append(section(HOW.hGenesis, el('p', { text: copy.GENESIS_NOTE })));
  page.append(section(HOW.hLimits, el('ul', null, ...HOW.limits.map((r) => el('li', { text: r })))));

  // faucets
  page.append(section(HOW.hFaucets, el('ul', { class: 'faucets' }, ...copy.FAUCETS.map((f) => el('li', null, el('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, f.name), ' ', el('span', { class: 'muted mono', text: f.url }))))));

  // contracts + repo
  page.append(
    section(
      HOW.hContracts,
      el('dl', null, addrRow(HOW.corePinned, CONFIG.CORE, ''), addrRow(HOW.implExpected, CONFIG.EXPECTED_IMPL, ''), addrRow(HOW.pitSeason, pitSet ? CONFIG.PIT : null, HOW.pitPh), el('div', { class: 'addr-row' }, el('dt', { text: HOW.repo }), el('dd', { class: 'addr mono' }, el('a', { href: DEPLOY_FACTS.repoUrl, target: '_blank', rel: 'noopener noreferrer' }, DEPLOY_FACTS.repoUrl.replace('https://', ''))))),
    ),
  );

  // forge snapshot placeholder (§5.10: estimates are replaced by the real snapshot; no unlabelled numbers here)
  page.append(section(HOW.hGas, el('p', { class: 'muted', text: HOW.gasNote }), el('pre', { text: gasSnapshot.trimEnd() })));

  root.append(style, page);

  const unsub = store.subscribe((s, prev) => {
    if (s.deployment !== prev.deployment) {
      const next = depLine(s);
      live.replaceWith(next);
      live = next;
    }
  });
  return () => {
    unsub();
    style.remove();
  };
}
