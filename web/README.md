# Pixel Pit — web

Unofficial fan project. Not affiliated with or endorsed by Squeekchain. Runs on the Sepolia testnet; nothing here has value.

A multiplayer game where each wallet has a brush budget of 0–40 pixels refilled only by settled Squeek blocks; the contract rejects paints beyond budget. This folder is the static frontend (Vite + TypeScript + viem, no backend, no keeper, no admin key). The contract lives in `../src/PixelPit.sol`.

Painting through Pixel Pit is a call to the Pit contract, not to a tracked Squeekchain contract, so it does not count for The Tester.

## Demo

GIF pending first live night.

(The README GIF comes from a real settlement, with the tx hash and ETH block number in the caption. No staged clip.)

## Budget (SPEC §7.3)

Your brush starts EMPTY. It fills 1 pixel per Squeek block that SqueekCore settles after you join, up to 40 (one full brush = one active round of running). If no new blocks are settling right now, you will paint when they arrive (over the last 9 nights that was 21:00–07:00 UTC; history, not a promise). You only need Sepolia ETH for gas.

Your crew is fixed once you join. Overpainting is allowed and expected.

## Trust model

| Topic | Behaviour |
|---|---|
| Budget source | Only `Core.state().blockHeight`, at the block of your transaction, read from inside the contract. |
| Core unreadable / gas bomb / return bomb / shape changed / height below `GENESIS_HEIGHT` | `CoreUnavailable`; `budgetOf.coreOk = false`; the UI shows UNKNOWN; the season freezes. |
| Core shape the same but field order changed (no upper-bound check) | At most one silent 40-pixel fill per wallet; the cap bounds it; the frontend cross-checks against the BatchSettled-derived height and shows "deployment changed" on mismatch. |
| Reorg | If a settlement block is reorged the budget can change; head reads are labelled FRESH, blocks at or below safe SETTLED; the log cache keeps only blocks at or below finalized (and only when the node served real `safe`/`finalized` tags). |
| Sybil | No resistance and none claimed (see the bots note on the Board); the Board ranks by cells held, not wallets. |
| Admin | None. Nobody, the deployer included, can mint budget, wipe the canvas or close the season. |

Labels (same colour and word on every screen): SETTLED (block ≤ safe) · FRESH (safe < block ≤ head, "not yet safe") · PENDING (your tx, counted nowhere) · PROVISIONAL (api.squeekchain.com, display only) · UNKNOWN (RPC/API failure or `coreOk = false`; never 0) · INCOMPLETE (log chunks missing or the integrity check failed; lower bound) · PRACTICE (local copy).

## Deployment note (SPEC §7.10)

This site reads the SqueekCore proxy 0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44 (release stream-game-sepolia-test-20261026-01, implementation 0x284747c4664af2203e7a90a2ee76f22b6b5e6889). docs.squeekchain.com lists 0x74665dAecA35A2303e767E76a2FF1FB6F93e119f; at the time of writing ({date}), api.squeekchain.com/v1/core reports 0x980b4424…, and the last BatchSettled for 0x74665d… was on {date} ({tx}). The Pit contract pins the proxy address as an immutable; this page additionally checks the implementation address, its runtime code hash, streamId and genesisTimestamp on every load, and shows the API-reported core address next to the pinned one. Verify yourself: api.squeekchain.com/v1/core and the latest BatchSettled transactions on eth-sepolia.blockscout.com.

The date and tx placeholders are filled right before submission. Note for the spec owner: on 2026-11-04 the live API reported `installationId` `stream-game-sepolia-test-20261025-01` (one day earlier than the release identifier in the spec); the frontend copy follows the spec verbatim until the spec is corrected.

## Season (SPEC §7.11)

Season 1 is this deployment: contract {PIT}. The canvas is persistent and there is no on-chain reset. If Squeekchain redeploys or upgrades Core in a way the Pit cannot read, or the Core height falls below Season 1's genesis height, Season 1 freezes at its last height and a new Pit is deployed as Season 2. Weekly windows on the Board (Mondays 12:00 UTC) are a display filter, not an on-chain season.

## Recorded deviations from the spec

- `#/overlay` hides the §7.1 footer line: the §7.2 watermark (`unofficial · Sepolia testnet · no value`, cannot be dismissed) carries the disclaimer on the OBS browser source, where a second line would burn into the stream. Every other route shows the footer.
- The §7.6 idle card, when the loaded logs hold no `BatchSettled` for the current height (true until the first post-deploy settlement, because `GENESIS_HEIGHT` was reached before `PIT_DEPLOY_BLOCK`), prints the gap as a lower bound: `(≥ X ago, ETH block ≤ PIT_DEPLOY_BLOCK)` under an INCOMPLETE tag, never SETTLED. Without even that bound it prints `unknown as of HH:MM UTC`.

## Build, test, release

```sh
npm ci
npm run typecheck
npm test            # unit + jsdom screen tests (also builds dist/ for the forbidden-words and size checks)
npm run e2e         # anvil end-to-end, see e2e/README.md
npm run build
npm run release:check   # refuses pre-deploy placeholders (meta UUID, How-page marks, zero PIT, missing public/logs-bootstrap.json, README marks)
```

Before submitting: fill `src/deployment.json` from the Season 1 deploy, run `tools/bootstrap-logs.ts` (writes `public/logs-bootstrap.json`), set the `squeekchain-project` meta UUID in `index.html`, fill the date / tx / PIT placeholders in `src/copy.ts`, this README and the How page, paste the `forge snapshot` output, then `npm run build && npm run release:check`.
