// Every user-facing string from SPEC §7.1-§7.16, verbatim (English). Screens import from here and never
// invent copy. Template strings take their numbers from a data source whose label is visible (§6.4 hard rule).

// §7.1 Footer (every route). Also present as static HTML in index.html.
export const FOOTER =
  'Unofficial fan project. Not affiliated with or endorsed by Squeekchain. Runs on the Sepolia testnet; nothing here has value.';

// §7.2 Overlay watermark (cannot be dismissed)
export const OVERLAY_WATERMARK = 'unofficial · Sepolia testnet · no value';

// §7.3 Join sheet + How (budget)
export const JOIN_BUDGET_P1 =
  'Your brush starts EMPTY. It fills 1 pixel per Squeek block that SqueekCore settles after you join, up to 40 (one full brush = one active round of running). If no new blocks are settling right now, you will paint when they arrive (over the last 9 nights that was 21:00–07:00 UTC; history, not a promise). You only need Sepolia ETH for gas.';
export const JOIN_BUDGET_P2 = 'Your crew is fixed once you join. Overpainting is allowed and expected.';

// §7.4 Board (bots note)
export const BOARD_BOTS_NOTE =
  'Sepolia wallets and Sepolia ETH are free. Anyone can create 100 wallets, join them all at noon, and paint 4,000 cells the moment the first batch settles. Pixel Pit has no sybil resistance and claims none. This board counts wallets, not people; nothing is awarded, and the only thing a bot proves is that the hamster ran. Rankings use cells held and unique cells, not raw strokes, so repainting your own cell 40 times moves nothing.';

// §7.5 Genesis (frame + hover + How)
export const GENESIS_NOTE =
  'Genesis strokes: the hamster outline was preseeded by the deployer at deploy time. It is paint-by-numbers, not player activity, and anyone can overpaint it.';
export const GENESIS_HOVER = 'genesis stroke (preseeded at deploy, not a player)';
export const GENESIS_FRAME0 = 'genesis strokes (preseeded at deploy, not a player)';

// §7.6 Idle status card (measured fact, not the hamster's mood)
export function IDLE_STATUS(H: string, X: string, N: string): string {
  return `No new Squeek blocks settled since block ${H} (${X} ago, ETH block ${N}). Squeektoshi may be resting, or settlement may be delayed. Over the last 9 nights new blocks arrived between 21:00–07:00 UTC; this is history, not a promise.`;
}
export function IDLE_HOLD(n: string): string {
  return `You still hold ${n} pixels from the last run. You can spend them now; the next settlement refills up to 40.`;
}
export const IDLE_LONG_GAP =
  'Longer than usual gap. Check sepolia.squeekchain.com for incidents. No estimate is shown because nobody knows when he runs.';
export function IDLE_STALE(HHMM: string, N: string): string {
  return `Unknown as of ${HHMM} UTC — the RPC head is stale (block ${N}). Numbers are unknown, not zero.`;
}

// §7.7 Provisional light (status strip)
export const PROVISIONAL_NOTE =
  'Measured by the device, reported by api.squeekchain.com. Display only. Not settled, never creates budget.';

// §7.8 Core paused
export const CORE_PAUSED =
  'Core paused by the Guardian. Reads still work; the Squeek block height cannot move, so no brush refills until it resumes. Pixels you already hold can be spent.';

// §7.9 Deployment changed
export const DEPLOYMENT_CHANGED =
  'Deployment changed: the SqueekCore implementation, configuration or API-reported address no longer matches the values this site was built against (expected implementation 0x284747c4…6889, expected core 0x980b4424…3d44). Season 1 of Pixel Pit stays bound to the old Core. Painting is disabled until this site is updated; Timeline and Board still work.';

// §7.10 Deployment note (How + README). {date} and {tx} are filled right before submission.
export function DEPLOYMENT_NOTE(date: string, lastDate: string, tx: string): string {
  return `This site reads the SqueekCore proxy 0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4 (installation sepolia-core-sepolia-20261103, implementation 0x6869d6102696243fd17013ab955d99cd0c522ad3), which api.squeekchain.com/v1/core reports as of ${date}. The previous proxy 0x980b4424… stopped producing Squeek blocks at height 8,430 when Squeekchain moved to the new installation on ${lastDate}; Season 1 of Pixel Pit (${tx}) stays frozen there. The Pit contract pins the proxy address as an immutable; this page additionally checks the implementation address, its runtime code hash, streamId and genesisTimestamp on every load, and shows the API-reported core address next to the pinned one. Verify yourself: api.squeekchain.com/v1/core and the latest BatchSettled transactions on eth-sepolia.blockscout.com.`;
}

// §7.11 Season note (How)
export function SEASON_NOTE(PIT: string): string {
  return `Season 2 is this deployment: contract ${PIT}. The canvas is persistent and there is no on-chain reset. If Squeekchain redeploys or upgrades Core in a way the Pit cannot read, or the Core height falls below this season's genesis height, the season freezes at its last height and a new Pit is deployed as the next season. Weekly windows on the Board (Mondays 12:00 UTC) are a display filter, not an on-chain season.`;
}

// §7.12 Pending / unknown / fresh wording
export const WORDING_LINE =
  'pending (not sent) · pending (sent, not mined; Paint locked) · fresh (mined, not yet safe) · settled (at or below the safe block) · unknown as of {HH:MM} UTC — numbers are unknown, not zero';
export const WORD_PENDING_NOT_SENT = 'pending (not sent)';
export const WORD_PENDING_SENT = 'pending (sent, not mined; Paint locked)';
export const WORD_FRESH = 'fresh (mined, not yet safe)';
export const WORD_SETTLED = 'settled (at or below the safe block)';
export function WORD_UNKNOWN(HHMM: string): string {
  return `unknown as of ${HHMM} UTC — numbers are unknown, not zero`;
}
export function BUDGET_FOOTNOTE(N: string, label: 'FRESH' | 'SETTLED'): string {
  return `as of ETH block ${N} (head) · ${label}. The contract reads Core at the block your transaction lands in; a reorg of a settlement can change this number.`;
}

// §7.13 X intent text (v2; no share button in v1)
export function X_INTENT(H: string, url: string): string {
  return `Pixel Pit canvas as of Squeek block ${H}. Multiplayer pixel game where paint budget only comes from settled Squeek blocks. Unofficial, Sepolia testnet, no value. ${url}#/timeline?h=${H}`;
}

// §7.14 Practice canvas (title, cannot be dismissed)
export const PRACTICE_TITLE = 'PRACTICE · local only · nothing is sent on-chain · no budget · cleared on reload';

// §7.15 Completeness line (every log-derived table/stat)
export function COMPLETE_LINE(PIT_DEPLOY_BLOCK: string, N: string): string {
  return `Data: on-chain Painted/Joined/BatchSettled events replayed from block ${PIT_DEPLOY_BLOCK}; complete through ETH block ${N} (safe).`;
}
export function INCOMPLETE_LINE(k: string): string {
  return `INCOMPLETE: ${k} log chunks failed to load; these numbers are a lower bound, not a final count.`;
}

// §7.16 Core height moved backwards
export function HEIGHT_BACKWARDS(H: string, Hprev: string): string {
  return `Core height moved backwards (now ${H}, was ${Hprev}). The budget shown is exactly what the contract will accept at this height.`;
}

// §6.4 error / empty states (not routes). Canvas stays visible in every case.
export function ERR_RPC_UNREACHABLE(N: string, HHMM: string): string {
  return `RPC unreachable: showing canvas as of Ethereum block ${N} (${HHMM} UTC); numbers are unknown, not zero`;
}
export function ERR_RPC_STALE(N: string, HHMM: string): string {
  return `RPC head is stale (block ${N}, ${HHMM} UTC); numbers are unknown`;
}
export const ERR_CORE_PAUSED_SHORT = 'Core paused by Guardian: reads work, budget cannot grow';
export function ERR_DEPLOYMENT_CHANGED_SHORT(got: string): string {
  return `Core deployment changed: expected implementation 0x2847…, got ${got}; painting disabled`;
}
export function ERR_HEIGHT_BACKWARDS_SHORT(H: string, Hprev: string): string {
  return `Core height moved backwards (now ${H}, was ${Hprev}); budget shown is what the contract will accept`;
}
export const ERR_WRONG_NETWORK = 'Wrong network';
export const ERR_NO_WALLET = 'No wallet found (install one, or just watch)';
export function ERR_CACHE_REBUILT(N: string): string {
  return `cache rebuilt from block ${N}`;
}
export const ERR_CORE_BELOW_GENESIS = "Core height below this season's genesis; season frozen";
export const ERR_SEASON2 = 'The next season will be a new Pit deployment';

// §6.2 / §2.2 deployment chip (top bar)
export function DEPCHECK_OK(core: string, impl: string): string {
  return `Core ${core} / impl ${impl} ok`;
}
export const DEPCHECK_CHANGED = 'deployment changed — painting disabled';
export function DEPCHECK_CHANGED_API(addr: string): string {
  return `deployment changed (API reports ${addr})`;
}
export function DEPCHECK_API_MATCH(addr: string): string {
  return `api /v1/core reports ${addr} · matches pinned`;
}
export function DEPCHECK_API_MISMATCH(addr: string): string {
  return `api /v1/core reports ${addr} · differs from pinned`;
}
export const DEPCHECK_API_UNKNOWN = 'api /v1/core unknown';
export const DEPCHECK_CHECKING = 'checking deployment…';
export const DEPCHECK_CORE_UNREACHABLE = 'Core unreachable, painting disabled';
export const I_UNDERSTAND = 'I understand';

// §6.4 top bar chip
export function CHIP_SQUEEK_BLOCK(H: string, N: string, label: 'FRESH' | 'SETTLED'): string {
  return `Squeek block ${H} · as of ETH block ${N} (head) · ${label}`;
}
export function CHIP_UNKNOWN(HHMM: string): string {
  return `unknown as of ${HHMM} UTC`;
}
export const CHIP_PAUSED = 'paused';

// §2 / §6.4 budget battery
export function BATTERY_READY(ready: string, banked: string, fresh: string): string {
  return `READY ${ready} = banked ${banked} + fresh ${fresh} (cap 40)`;
}
export function BATTERY_ARRIVED(arrived: string, forfeited: string): string {
  return `+${arrived} arrived, ${forfeited} forfeited above cap`;
}
export function BATTERY_PENDING(n: string): string {
  return `PENDING ${n}`;
}
export function BATTERY_UNKNOWN(HHMM: string): string {
  return `UNKNOWN as of ${HHMM} UTC`;
}
export function BATTERY_IDLE(H: string, X: string): string {
  return `READY 0 · no new settled blocks since block ${H} (${X} ago)`;
}
export function BATTERY_HOLD(n: string): string {
  return `you still hold ${n} pixels from the last run`;
}

// §2.4 settlement flash
export function FLASH_SETTLED(H: string, delta: string, label: 'fresh' | 'settled', ready: string): string {
  return `Block ${H} settled: +${delta} · ${label}. Your brush is ${ready}/40.`;
}
export function FEED_JOINED(H: string, crew: string): string {
  return `Joined at Squeek block ${H} as ${crew}.`;
}

// §6.4 queue / paint button reasons
export function QUEUED(n: string, cap: string): string {
  return `queued ${n} / ${cap}`;
}
export function PAINT_N(n: string): string {
  return `Paint ${n}`;
}
export const REASON_BRUSH_EMPTY = 'brush empty';
export const REASON_WRONG_NETWORK = 'wrong network';
export const REASON_CORE_UNREACHABLE = 'Core unreachable';
export const REASON_DEPLOYMENT_CHANGED = 'deployment changed';
export function REASON_WAITING_TX(tx: string): string {
  return `waiting for tx ${tx} to be mined`;
}
export const REASON_NOT_JOINED = 'join first';
export const REASON_NO_WALLET = 'connect a wallet';
export const PAINT_SHEET_DESTINATION = 'goes to the Pit contract on Sepolia';

// §2.1 / §6.4 misc
export function SEASON_STARTED(N: string): string {
  return `Season 2 started at Squeek block ${N}; first night pending.`;
}
export function CURRENT_ROUND_DERIVED(round: string): string {
  return `current round ${round} derived from the clock; rounds after the frontier are unknown, not zero`;
}
export function TIMELINE_PANEL(H: string, delta: string, round: string, strokes: string, wallets: string, filled: string, N: string): string {
  return `at block ${H}: +${delta} · round ${round} · ${strokes} strokes by ${wallets} wallets · cells filled ${filled}/1024 · complete through ETH block ${N}`;
}
export function COMPLETE_THROUGH(N: string): string {
  return `complete through ETH block ${N}`;
}
export function BOARD_COMPLETE(from: string, N: string): string {
  return `complete from block ${from} to ETH block ${N} (safe)`;
}
export function BOARD_INCOMPLETE(k: string): string {
  return `INCOMPLETE — ${k} chunks failed, numbers are a lower bound`;
}
export const TOOLTIP_NOT_YET_SAFE = 'not yet safe';
export const LABEL_SETTLED = 'SETTLED';
export const LABEL_FRESH = 'FRESH';
export const LABEL_PENDING = 'PENDING';
export const LABEL_PROVISIONAL = 'PROVISIONAL';
export const LABEL_UNKNOWN = 'UNKNOWN';
export const LABEL_INCOMPLETE = 'INCOMPLETE';
export const LABEL_PRACTICE = 'PRACTICE';
export const LABEL_GENESIS = 'GENESIS STROKE';
export const LABEL_FORFEITED = 'FORFEITED';
export const LABEL_CONFIRMED = 'CONFIRMED';
export const LABEL_RECENT = 'RECENT';

// Wallet (§2.2, §6.4 join sheet)
export const WALLET_CONNECT = 'Connect';
export const WALLET_SWITCH = 'Switch to Sepolia';
export const WALLET_LOW_BALANCE = 'Low balance: you need a little Sepolia ETH for gas.';
export const FAUCETS: readonly { name: string; url: string }[] = [
  { name: 'Google Cloud Sepolia faucet', url: 'https://cloud.google.com/application/web3/faucet/ethereum/sepolia' },
  { name: 'Alchemy Sepolia faucet', url: 'https://www.alchemy.com/faucets/ethereum-sepolia' },
  { name: 'pk910 PoW faucet', url: 'https://sepolia-faucet.pk910.de/' },
];
// Custom error -> plain sentence (§6.4 Join sheet)
export const ERR_SENTENCES: Record<string, string> = {
  AlreadyJoined: 'This wallet already joined; the crew is fixed.',
  NotJoined: 'This wallet has not joined yet.',
  BadCrew: 'Unknown crew.',
  PlayerLimit: 'The player limit was reached.',
  EmptyStroke: 'Nothing to paint: the queue is empty.',
  TooManyCells: 'Too many cells in one paint (max 40).',
  LengthMismatch: 'Cells and colours do not match.',
  BadCell: 'A cell index was out of range.',
  BadColor: 'A colour index was out of range.',
  CoreUnavailable: 'Core unreachable',
};
export function ERR_INSUFFICIENT_BUDGET(have: string, need: string): string {
  return `You have ${have} pixels, tried to paint ${need}`;
}
export const ERR_USER_REJECTED = 'You rejected the request in your wallet.';
export const ERR_TX_FAILED = 'The transaction failed.';
