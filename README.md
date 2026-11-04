# Pixel Pit

A multiplayer game where each wallet has a brush budget of 0–40 pixels refilled only by settled Squeek blocks; the contract rejects paints beyond budget.

Unofficial fan project. Sepolia testnet. Nothing here has value.

Pixel Pit is one ownerless Solidity contract on Sepolia that holds a shared 32x32 canvas. You call `join(crew)` once; from then on, every time SqueekCore's `state().blockHeight` rises by 1, your brush gains 1 pixel. There is no backend, no keeper and no admin key.

## Demo

GIF pending first live night.

(The GIF will come from a real settlement, with the tx hash and ETH block number in the caption. No staged clip.)

## What it is in 6 rules

1. **One canvas.** 32x32 cells, 16 colours (index 0 is pit black), `cell = y * 32 + x`. Every cell can be painted over, genesis cells included. There is no ownership and no protection.
2. **One source of budget.** `SqueekCore.state().blockHeight`, read from inside `paint()` at the block of your transaction through a gas-capped `STATICCALL`. The API, the clock, the deployer and the frontend never touch the budget.
3. **Join, then wait.** `join(crew)` fixes your crew (0 Wheel, 1 Burrow, 2 Seed, 3 Moon) and starts the brush at 0. It fills 1 pixel per settled Squeek block, up to 40 (one full brush = one active round of running).
4. **Cap 40.** A `+43` settlement fills an empty brush, `+12` adds 12, a `+318` catch-up batch still fills it only to 40. A night of sleeping gives 40, not 900.
5. **Paint 1–40 cells per transaction.** Each cell burns 1 pixel (duplicates burn each time, the last colour wins). `paint()` reverts with `InsufficientBudget(have, need)` beyond the budget. `budgetOf()` uses the same internal function as `paint()`, so the number the UI shows is the number the contract accepts.
6. **Freeze, don't fake.** If Core cannot be read (revert, gas bomb, return bomb, changed shape) or its height falls below the Pit's genesis height, `join`/`paint` revert with `CoreUnavailable()`, `budgetOf` reports `coreOk=false`, the UI says UNKNOWN, and the season freezes cleanly.

## Exact Squeekchain surface this settles on

| Surface | Used for | Where |
|---|---|---|
| `Core.state()` (selector `0xc19d93fb`, 256 bytes, word 3 = `blockHeight`) | The only budget input. Read inside `join()`, `paint()` and `budgetOf()` at the transaction block, gas cap 60,000, `returndatasize == 256` required | `src/PixelPit.sol` |
| `BatchSettled` logs (topic0 `0x66d3b3a5…`) | Ticks: Timeline, settlement flash, idle status card, cross-check of `budgetOf.coreHeight` against `cumulativeBlockUnits / 1e9` | frontend log replay |
| `Core.implementationCodeAddress()` and `Core.configuration()` | Deployment check on every load: implementation address, runtime code hash, `streamId`, `genesisTimestamp`, `targetBlocksPerActiveRound` | frontend |
| `api.squeekchain.com/v1/status` | Display only (PROVISIONAL light). Never feeds a number that matters | frontend status strip |
| `api.squeekchain.com/v1/core` | Display only: the API-reported core address is shown next to the pinned one | frontend deployment chip |

Pixel Pit only reads Squeekchain contracts. It sends no transaction to any Squeekchain contract.

## Trust model

| Topic | Behaviour |
|---|---|
| Budget source | Only `Core.state().blockHeight`, at the block of the transaction, read from inside the contract |
| Core unreadable / gas bomb / return bomb / shape changed / `H < GENESIS_HEIGHT` | `CoreUnavailable`, `coreOk=false`, UI UNKNOWN; the season freezes |
| Core shape the same but field order changed (no upper bound) | At most one silent 40-pixel fill per wallet; CAP bounds it; the frontend cross-checks against the `BatchSettled`-derived height |
| Reorg | If a settlement block is reorged the budget can change; the UI labels head reads FRESH and blocks at or below `safe` SETTLED; the cache keeps only blocks at or below `finalized` |
| Sybil | No resistance and none claimed (see bots note); the Board ranks by cells held |
| Admin | None. Nobody, the deployer included, can mint budget, wipe the canvas or close the season |

## Deployment note

This site reads the SqueekCore proxy 0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44 (release stream-game-sepolia-test-20261026-01, implementation 0x284747c4664af2203e7a90a2ee76f22b6b5e6889). docs.squeekchain.com lists 0x74665dAecA35A2303e767E76a2FF1FB6F93e119f; at the time of writing (2026-11-04), api.squeekchain.com/v1/core reports 0x980b4424…, and the last BatchSettled for 0x74665d… was on 2026-10-26 (0x502d216baff7732ac31ab59b8e3b44911b33834c6b3ca5ad3b7e1c18fbd20eb0). The Pit contract pins the proxy address as an immutable; this page additionally checks the implementation address, its runtime code hash, streamId and genesisTimestamp on every load, and shows the API-reported core address next to the pinned one. Verify yourself: api.squeekchain.com/v1/core and the latest BatchSettled transactions on eth-sepolia.blockscout.com.


## Prior art

Neutral one-liners; each project is described only after being checked.

- Wheel Canvas: signers add one stroke each through a token `approve(self, 0)` call to an artwork drawn by the hamster; no pixel choice, no block-gated budget.

## Tester

Painting through Pixel Pit is a call to the Pit contract, not to a tracked Squeekchain contract, so it does not count for The Tester.

## Bots

Sepolia wallets and Sepolia ETH are free. Anyone can create 100 wallets, join them all at noon, and paint 4,000 cells the moment the first batch settles. Pixel Pit has no sybil resistance and claims none. This board counts wallets, not people; nothing is awarded, and the only thing a bot proves is that the hamster ran. Rankings use cells held and unique cells, not raw strokes, so repainting your own cell 40 times moves nothing.

## Season 1 contract and tx hashes

- Pit (Season 1): `0x4B1D7d9f8499Ad065a8f883a6E4889B855bB38EF`, deployed 2026-11-04 in block 12063369 (tx 0xab88a5c4b911b52783f393361637f83c84f08c89788d7c31fa8b5edfda35600e), source verified on eth-sepolia.blockscout.com
- First join / first paint tx hashes: pending the first live night; they will be added here and are visible in the Feed and Timeline on the site
- `InsufficientBudget` rejection: covered by `test_T8_workedExample` and `test_T10_spendBankedWithoutNewBlocks` in `test/PixelPit.t.sol`; a live screenshot follows the first live night

## Repo layout

```
src/PixelPit.sol            the contract (no svg(); a separate renderer is post-v1)
test/PixelPit.t.sol         T1-T24 matrix, gas probes
test/PixelPit.invariant.t.sol   INV monotone / backwards suites with a handler
test/Audit.t.sol            regression tests from review findings
test/PixelPit.fork.t.sol    Sepolia fork tests (skipped without SEPOLIA_RPC_URL)
test/mocks/MockCore.sol     Core stand-in: bump/jump/drop/freeze, revert, gas bomb, return bomb, EOA modes
test/fixtures/genesis.json  genesis arrays derived from genesis/hamster.png
script/Deploy.s.sol         deploy bound to the live Core (or $CORE) with a genesis JSON
script/DeployDev.s.sol      anvil only: MockCore + dev Pit
script/check-layout.sh      storage layout diff against docs/storage-layout.json
genesis/hamster.png         32x32 source picture for the genesis cells
tools/                      genesis.ts (PNG -> arrays), bootstrap-logs.ts (build-time log file)
web/                        Vite + TypeScript + viem static frontend (no backend)
docs/ARCHITECTURE.md        storage, budget math, log replay, labels
docs/RUNBOOK.md             owner checklist (Turkish)
docs/gas-snapshot.txt       forge snapshot output
```

## Run the tests

```sh
# contract (Foundry)
forge test -vv
bash script/check-layout.sh            # storage layout must match docs/storage-layout.json
forge snapshot --match-contract '^PixelPitTest$' --snap docs/gas-snapshot.txt

# fork tests against the live Core (optional)
SEPOLIA_RPC_URL=https://ethereum-sepolia-rpc.publicnode.com forge test --match-path test/PixelPit.fork.t.sol -vv

# frontend
cd web && npm ci && npm run typecheck && npm test && npm run build

# end-to-end on a local anvil (needs anvil running, see web/e2e/README.md)
cd web && npm run e2e
```

## Gas

> Sepolia note (measured 2026-11-04): the network currently prices new storage slots and code deposit several times higher than the local Cancun schedule. The Season 1 deploy used 11,618,905 gas on-chain against 3,110,529 in the local simulation; a bare deploy of the same bytecode estimates at about 8.7M and each fresh `_cells` word adds roughly 113k. Expect `join()` and paints into untouched words to cost several times the figures below.

Measured by `test_gas_*` in `test/PixelPit.t.sol` (`forge test --match-test test_gas_ -vv`, call only, add 21,000 intrinsic for a transaction), and the whole-test totals in `docs/gas-snapshot.txt`.

| Operation | Call gas | `docs/gas-snapshot.txt` (whole test, incl. setup) |
|---|---|---|
| `join` | 87,364 | 95,850 |
| `paint(1)`, word already written | 55,021 | 274,054 |
| `paint(40)`, one row (5 words) | 151,696 | 644,694 |
| `paint(40)`, 40 words, all written | 330,396 | 1,534,571 |
| `paint(40)`, 40 words, none written (worst case) | 1,031,841 | 1,175,809 |
| `budgetOf()` (view) | 12,256 | 139,392 |
| `crewScores()` (view) | 335,242 | 1,493,612 |

Other measured figures, from the same file: `test_T1_joinGate` 5,266,219 (many joins), `test_T24_idWidthBeyond16Bits` 637,436, `test_T19_genesisFromFixture` 8,640,776 (159 genesis cells).

## Squeekchain project listing

squeekchain-project: c2c8374b-d940-4b47-9ee2-1f7dc519ffd8


## License

MIT, see `LICENSE`.
