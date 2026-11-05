# Pixel Pit architecture

Unofficial fan project. Sepolia testnet. Nothing here has value. Scope: contract storage, budget math, frontend log replay with its integrity check, and the honesty labels. The locked spec is `SPEC.md`.

## 1. Shape of the system

```
SqueekCore proxy 0xfd6c…e0c4 (read only; Season 1 used 0x980b…3d44)
   │  state().blockHeight  (STATICCALL, gas cap 60k, 256 bytes)
   ▼
PixelPit (immutable CORE, no admin, no upgrade)  ── events: Joined, Painted, GenesisSeeded
   ▲                                   │
   │ join / paint (wallet)             │ eth_call at one pinned block: rawCells, totalStrokes, playerCount, budgetOf
   │                                   ▼
web/ static page (Vite + TS + viem) ◄── Core BatchSettled logs + Pit logs (bootstrap file + tail)
                                    ◄── api.squeekchain.com (display only: PROVISIONAL light, core address)
```

There is no server, keeper or indexer. Everything the page shows comes from an `eth_call`, a log chunk (with a completeness line), the API (PROVISIONAL), or local Practice state (PRACTICE).

## 2. Storage layout

Checked in CI: `forge inspect PixelPit storage-layout --json | diff - docs/storage-layout.json` (`script/check-layout.sh`).

| Slot | Field | Notes |
|---|---|---|
| 0..127 | `uint256[128] private _cells` | 8 cells per word, 32 bits per cell |
| 128 | `mapping(address => Player) private _players` | one slot per player |
| 129 | `address[] private _playerById` | index 0 is `address(0)` (genesis placeholder, pushed in the constructor) |
| 130 | `uint64 private _totalStrokes` | |

Immutables (bytecode, not storage): `CORE`, `GENESIS_HEIGHT`, `DEPLOY_BLOCK`. Total writable state: 131 slots plus one per player.

`Player` packs into one slot: `credited uint64`, `lastHeight uint64`, `strokes uint32`, `id uint32`, `crew uint8`, `joined bool`.

Cell record (32 bits):

```
bits  0-3   color      (0..15)
bits  4-5   crew       (0..3)
bit   6     genesis    (1 = preseeded at deploy)
bit   7     spare      (always 0)
bits  8-31  painterId  (24 bits; 0 = genesis or unpainted)

word  = cell >> 3
shift = (cell & 7) << 5
rec   = (uint32(painterId) << 8) | (genesis ? 0x40 : 0) | (crew << 4) | color
```

An untouched word is eight cells of colour 0 with painter 0, which is a valid pit-black canvas, so untouched storage is a valid state. Frontend decoding uses the same bit map: `color = rec & 0xF`, `crew = (rec >> 4) & 3`, `genesis = (rec >> 6) & 1`, `painterId = rec >> 8`.

Reading Core (`_readCore`): a raw assembly `staticcall(60000, CORE, selector 0xc19d93fb, 4 bytes, out 0x100)`. No dynamic returndata copy, so a gas bomb or return bomb cannot run `budgetOf`/`join`/`paint` out of gas. `returndatasize` must be exactly 256, word 3 is `blockHeight`, a value above `uint64.max` or below `GENESIS_HEIGHT` counts as unreadable. Unreadable means `join`/`paint` revert `CoreUnavailable()` and `budgetOf` reports `coreOk=false` with every number 0.

## 3. Budget math

Constants: `CAP = 40`, rate 1 pixel per settled Squeek block. Per player: `credited` and `lastHeight`. One internal function, `_budget(p, H)`, is used by both `paint()` and `budgetOf()`.

```
join(crew):   credited = H ; lastHeight = H                     -> budget 0

_budget(p, H):
  raw       = H > credited ? H - credited : 0
  ready     = min(CAP, raw)                    the largest n paint() accepts
  banked    = min(lastHeight - credited, ready)   left over from the last paint
  fresh     = ready - banked                   newly settled part of ready
  arrived   = H > lastHeight ? H - lastHeight : 0   blocks since the last paint
  forfeited = raw - ready                      burned above the cap

paint(n):     (ready, ...) = _budget(p, H)
              require 1 <= n <= ready
              left       = ready - n
              credited   = H - left            -> ready == left afterwards
              lastHeight = H
```

Identities: `ready = banked + fresh`; `arrived = fresh + forfeited` while banked is not clipped. If the height falls between `credited` and `lastHeight` (partial backwards move, not seen on the live Core) then `ready = banked = raw` and `fresh = arrived = forfeited = 0`; `paint` and `budgetOf` still return the same number. Below `GENESIS_HEIGHT` the Core counts as unreadable (freeze). The frontend never recomputes these values; it reads them from `budgetOf()`.

`budgetOf` detail (implementation choice, reported in review): `coreHeight` is the real height whenever `coreOk` is true, also for a wallet that has not joined (the budget numbers stay 0 until it joins). It is 0 only when `coreOk` is false, and that 0 is UNKNOWN, never "deployment changed".

### Worked example (2026-11-04 real heights, SPEC §3.5)

| Time (UTC) | Event | H | credited / lastHeight | banked | fresh | ready | arrived | forfeited |
|---|---|---|---|---|---|---|---|---|
| 14:00 | join(Moon) | 8,430 | 8,430 / 8,430 | 0 | 0 | **0** | 0 | 0 |
| 21:42 | BatchSettled +43 | 8,473 | 8,430 / 8,430 | 0 | 40 | **40** | 43 | 3 |
| 21:43 | paint(30) | 8,473 | 8,463 / 8,473 | 10 | 0 | **10** | 0 | 0 |
| 21:52 | BatchSettled +57 | 8,530 | 8,463 / 8,473 | 10 | 30 | **40** | 57 | 27 |
| 07:10 | night over, never painted | 9,322 | 8,463 / 8,473 | 10 | 30 | **40** | 849 | 819 |

This table is test `test_T8_workedExample` in `test/PixelPit.t.sol`. Consequences: a new wallet starts at 0; `+43` fills an empty brush, `+12` adds 12, `+318` still stops at 40; one night asleep gives 40, not 900; spending banked pixels needs no new block.

### Paint write path

1. Load `Player`, require `joined`; `1 <= n <= CAP`; `cells.length == colors.length`.
2. `_coreHeight()` or `CoreUnavailable`.
3. `have = _budget(p, h).ready`; `n > have` reverts `InsufficientBudget(have, n)`.
4. Loop with a one-word cache: bounds checks (`BadCell`, `BadColor`) run before the first `SSTORE`, consecutive cells in the same word cost one `SLOAD`/`SSTORE`. Duplicate cells burn one pixel each, last colour wins.
5. `credited = h - left`, `lastHeight = h`, `strokes += n`, `_totalStrokes += n`, emit `Painted(player, h, id, cells, colors, left)`.

External surface is a single `STATICCALL`: no callback to `msg.sender`, no ETH (a plain transfer reverts).

## 4. Log replay and integrity check

Source of truth for history is logs, not an indexer.

**Logs.** Pit `Joined`, Pit `Painted`, Core `BatchSettled`.

- Build time: `tools/bootstrap-logs.ts` writes `web/public/logs-bootstrap.json` (`PIT_DEPLOY_BLOCK..BOOTSTRAP_BLOCK`, chunks of at most 10,000 blocks, each with its `toBlockHash`).
- Run time: tail `BOOTSTRAP_BLOCK+1..head` in chunks of at most 10,000 blocks.
- Key: `(chainId, blockHash, txHash, logIndex)`.
- `null`, an error, a "pruned" or "range too large" message and a timeout are failures. They are never written as an empty chunk. A failed chunk is retried and the dependent table is marked INCOMPLETE meanwhile.
- Cache: localStorage `pit:<chainId>:<pit>:logs`, only blocks `<= finalized`; `finalized < block <= head` stays in memory and is refetched every tick. localStorage is optional (all access in try/catch).

**Tick (every 12 s, 60 s when the tab is hidden).** One provider for the whole tick (Tenderly first, publicnode on error; never mixed). Reads `head`, `safe`, `finalized` (fallback `head-12` / `head-64` when a node lacks the tags; such ticks never persist the cache). A head block older than 120 s makes the tick UNKNOWN. At the pinned block `B` (EIP-1898 `blockHash`): `Core.state()`, `Pit.rawCells()`, `Pit.budgetOf(wallet)`, `Pit.totalStrokes()`, `Pit.playerCount()`.

**Integrity check at `B`, every tick, same provider:**

| | Check |
|---|---|
| (a) | sum of replayed `Painted.cells.length` == `Pit.totalStrokes()@B` |
| (b) | number of replayed `Joined` == `Pit.playerCount()@B` |
| (c) | `frame(B)` (genesis cells + `Painted` events in `(blockNumber, logIndex)` order) == `rawCells()@B`, cell for cell |
| (d) | `budgetOf.coreHeight@B` == latest `BatchSettled.cumulativeBlockUnits / 1e9` up to `B`; a mismatch is the "deployment changed" state |

If (a)–(c) fail, the cache is dropped and rebuilt from `PIT_DEPLOY_BLOCK`; the banner reads `cache rebuilt from block N`. The rebuild swaps data in only if every chunk through head loaded; a failed rebuild keeps the old data and all screens render INCOMPLETE.

**Timeline frame `h`:** genesis cells plus every `Painted` with `coreHeight <= h`, ordered by `(blockNumber, logIndex)`. Test: `frame(current) == rawCells()` (vitest and the anvil e2e).

**Deployment check (every load):** `Pit.CORE() == CORE`, `Core.implementationCodeAddress() == EXPECTED_IMPL`, `keccak(eth_getCode(impl)) == EXPECTED_RUNTIME_HASH`, and `configuration()` `streamId`, `genesisTimestamp`, `targetBlocksPerActiveRound` match. The API-reported core address from `/v1/core` is shown next to the pinned one. Any mismatch: red bar, Paint closed (Join stays closed). Until the check has run, or when it is unreachable, Paint is closed too.

## 5. Honesty labels

Same colour and same word on every screen.

| Label | Colour | When | Where |
|---|---|---|---|
| SETTLED | green, solid | Core or Pit data at a block `<= safe`; Board numbers; the HUD height only if the settlement block that brought it is `<= safe` | everywhere |
| FRESH | blue thin frame | `safe < block <= head`: Pit strokes, the budget read at head, a settlement flash seen at head; tooltip "not yet safe" | canvas, battery, feed, flash |
| PENDING | hatched | your own tx, queued or sent-not-mined; counted nowhere; Paint locked | canvas, queue, battery |
| PROVISIONAL | amber dot | `api.squeekchain.com` data (running, rpm, reported core address); never next to a budget number | status strip |
| UNKNOWN | grey dash + clock | RPC/API error, stale head, `coreOk=false`, `status: unavailable`; "unknown as of HH:MM UTC", never 0 | everywhere |
| INCOMPLETE | grey italic | a log-derived table is missing chunks or failed the integrity check; lower bound | Board, Timeline panel, feed |
| PRACTICE | purple title | local copy of the canvas; no chain, no budget, cleared on reload | Play |

Fixed extras: GENESIS STROKE (visible frame, hover, Timeline frame 0), FORFEITED (`+57 arrived, 27 above cap forfeited`), CONFIRMED/RECENT (Timeline frame), `complete through ETH block N`, `current round N derived from the clock; rounds after the frontier are unknown, not zero`.

Rules: budget numbers come only from `budgetOf()` and only while `coreOk == true` (test: `coreOk=false` leaves no digits in the DOM and shows UNKNOWN); the settlement flash comes only from the chain; there is never a countdown; "asleep/running" appears only next to the PROVISIONAL light; the empirical night window always reads `(last 9 nights, history, not a promise)`; every log-derived number carries its completeness line; no staged clips, the GIF is a real settlement or the README says `GIF pending first live night`.

## 6. Build and release gates

- Contract: `forge test`, `script/check-layout.sh`, `forge snapshot`.
- Frontend: `npm run typecheck`, `npm test` (includes forbidden-words and size checks on `dist/`, budget under 200 KB), `npm run e2e` (anvil).
- `npm run release:check` in `web/` refuses pre-deploy placeholders: meta UUID, How-page marks, zero PIT address, missing `logs-bootstrap.json`, README marks.
