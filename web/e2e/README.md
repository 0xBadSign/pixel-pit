# Local end-to-end on anvil

`npm run e2e` runs `e2e/anvil.test.ts` against a local anvil chain with a MockCore and a dev Pit.
It exercises the page's own modules (dev `CONFIG`, `runTick`, `LogStore`, `frame()`, `batteryModel`,
`renderBattery`, `describeError`) against a real chain; nothing is mocked.

What it checks:

1. `deployment.dev.json` matches the chain (`Pit.CORE()`, `DEPLOY_BLOCK()`, `GENESIS_HEIGHT()`, genesis cells on chain).
2. A tick is ok, pinned to one block, `state().blockHeight` equals the mock height; before any paint `frame(logs) == rawCells()`.
3. `join` -> budget 0; `bump(43)` -> `budgetOf().ready == 40`; `paint` 30 cells -> `ready == 10`, `rawCells()` updated,
   `frame(logs) == rawCells()`, integrity (a) strokes, (b) joined, (c) frame all pass; repainting own cells holds the same pixels.
4. Partial height decrease: tick ok, `coreOk` true, numbers still shown, the backwards banner text would render.
5. Core below `GENESIS_HEIGHT` (`coreOk=false` with a working `state()`): battery is UNKNOWN with no digits besides the clock,
   `paint` reverts `CoreUnavailable` and decodes to the §6.4 sentence.
6. Core `state()` reverting: the WHOLE tick is UNKNOWN (single provider per tick), battery UNKNOWN, the raw
   `eth_estimateGas` error the Play screen sees decodes to the `CoreUnavailable` sentence; after `clearModes()` the budget is intact.

The suite takes an `evm_snapshot` first and `evm_revert`s at the end, so it can be re-run on the same anvil.

## Steps

Foundry lives in WSL in this setup; Node/npm run on Windows. Adjust paths if you run everything in one shell.

```sh
# 1. local chain (keep running)
anvil --host 127.0.0.1 --port 8545

# 2. deploy MockCore (height 8430) + dev Pit seeded from test/fixtures/genesis.json
#    anvil's default key #0 (public dev key, chain 31337 only)
cd pixel-pit
forge build
forge script script/DeployDev.s.sol --broadcast --rpc-url http://127.0.0.1:8545 \
  --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
#    DEV_HEIGHT=<n> changes the mock's starting height; GENESIS_JSON=<path> the genesis file.

# 3. write web/src/deployment.dev.json from the broadcast (addresses, deploy block, genesis arrays)
cd web
npm run dev-deployment

# 4. run
npm run e2e
```

`npm run e2e` uses `vitest.e2e.config.ts`, which defines `__PIT_DEV__ = true` so `config.ts` takes the
dev branch (chainId 31337, `http://127.0.0.1:8545`, `FINALITY_TAGS=false`), exactly like
`VITE_ENV=dev vite build`. The production build never contains these values (tree-shaken).

To look at the dev Pit in the browser: `VITE_ENV=dev npm run dev` and connect a wallet to the anvil chain
(31337). Note that MockCore emits no `BatchSettled` event, so the settlement flash, the SETTLED height label
and integrity check (d) stay inactive on anvil; everything else (budget battery, paint, feed, timeline) works.
