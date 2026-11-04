#!/usr/bin/env node
// Writes src/deployment.dev.json from the latest `forge script script/DeployDev.s.sol --broadcast` run
// against a local anvil (chain 31337): MockCore + dev PixelPit addresses, the Pit's deploy block and the
// genesis arrays the Pit was seeded with. Only VITE_ENV=dev builds and `npm run e2e` read this file.
//
//   node scripts/write-dev-deployment.mjs [path/to/run-latest.json] [--genesis test/fixtures/genesis.json]
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(web, '..');
const argv = process.argv.slice(2);
const genesisFlag = argv.indexOf('--genesis');
const genesisPath = genesisFlag >= 0 ? join(repo, argv[genesisFlag + 1]) : join(repo, 'test', 'fixtures', 'genesis.json');
const runPath = argv.find((a, i) => !a.startsWith('--') && (genesisFlag < 0 || i !== genesisFlag + 1)) ?? join(repo, 'broadcast', 'DeployDev.s.sol', '31337', 'run-latest.json');
const out = join(web, 'src', 'deployment.dev.json');

if (!existsSync(runPath)) {
  console.error(`broadcast file missing: ${runPath}\nrun: forge script script/DeployDev.s.sol --broadcast --rpc-url http://127.0.0.1:8545 --private-key <anvil key #0>`);
  process.exit(1);
}
const run = JSON.parse(readFileSync(runPath, 'utf8'));
const creates = run.transactions.filter((t) => t.transactionType === 'CREATE');
const core = creates.find((t) => t.contractName === 'MockCore');
const pit = creates.find((t) => t.contractName === 'PixelPit');
if (!core || !pit) {
  console.error('run-latest.json has no MockCore/PixelPit CREATE transactions');
  process.exit(1);
}
const receipt = (run.receipts ?? []).find((r) => r.transactionHash?.toLowerCase() === pit.hash?.toLowerCase());
const pitDeployBlock = receipt ? Number(BigInt(receipt.blockNumber)) : null;
if (pitDeployBlock === null) {
  console.error('no receipt for the PixelPit deploy tx in run-latest.json');
  process.exit(1);
}

// GENESIS_HEIGHT: the constructor arg of MockCore (DEV_HEIGHT) is the Pit's GENESIS_HEIGHT (Pit reads Core at construction).
const mockHeight = core.arguments?.[0] !== undefined ? Number(core.arguments[0]) : 8430;

let genesis = { cells: [], colors: [] };
if (existsSync(genesisPath)) {
  const g = JSON.parse(readFileSync(genesisPath, 'utf8'));
  genesis = { cells: g.cells ?? [], colors: g.colors ?? [] };
}

const json = {
  _comment: 'Local anvil / MockCore + dev Pit, written by scripts/write-dev-deployment.mjs from broadcast/DeployDev.s.sol/31337/run-latest.json. Only compiled into VITE_ENV=dev builds (tree-shaken out of production).',
  chainId: Number(run.chain ?? 31337),
  CORE: core.contractAddress,
  PIT: pit.contractAddress,
  PIT_DEPLOY_BLOCK: pitDeployBlock,
  GENESIS_HEIGHT: mockHeight,
  GENESIS_CELLS: genesis.cells,
  GENESIS_COLORS: genesis.colors,
  RPC: ['http://127.0.0.1:8545'],
};
writeFileSync(out, JSON.stringify(json, null, 2) + '\n');
console.log(`wrote ${relative(web, out)}: CORE ${json.CORE} PIT ${json.PIT} deployBlock ${json.PIT_DEPLOY_BLOCK} genesisHeight ${json.GENESIS_HEIGHT} genesisCells ${json.GENESIS_CELLS.length}`);
