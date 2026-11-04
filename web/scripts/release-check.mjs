#!/usr/bin/env node
// Release gate (run after `npm run build`): refuses a build that still carries pre-deploy placeholders.
//   npm run release:check
// Fails (exit 1) when
//   - dist/ is missing, or any dist file contains "PLACEHOLDER-UUID" or "TODO before submit",
//   - src/deployment.json still has the zero PIT address / PIT_DEPLOY_BLOCK 0 / empty GENESIS_CELLS,
//   - public/logs-bootstrap.json is missing or is for another chain / Pit (tools/bootstrap-logs.ts output),
//   - no README (repo root README.md or docs/WEB-NOTES.md) carries the §7.3 Tester line, or it still says "TODO before submit",
//   - the built index.html lost the squeekchain-project meta or the §7.1 footer.
// Everything it checks is a fact of the build on disk; it never talks to the network.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const repo = join(web, '..');
const dist = join(web, 'dist');
const ZERO = '0x0000000000000000000000000000000000000000';
const FORBIDDEN_MARKS = ['PLACEHOLDER-UUID', 'TODO before submit'];
const TESTER_LINE = 'Painting through Pixel Pit is a call to the Pit contract, not to a tracked Squeekchain contract, so it does not count for The Tester.';
const FOOTER = 'Unofficial fan project. Not affiliated with or endorsed by Squeekchain. Runs on the Sepolia testnet; nothing here has value.';

const problems = [];
const fail = (msg) => problems.push(msg);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(js|html|css|json|svg|txt|map)$/.test(name)) out.push(p);
  }
  return out;
}

// 1) dist and its placeholders
if (!existsSync(dist)) {
  fail('dist/ missing: run `npm run build` first');
} else {
  const files = walk(dist);
  if (files.length === 0) fail('dist/ is empty');
  for (const f of files) {
    const text = readFileSync(f, 'utf8');
    for (const mark of FORBIDDEN_MARKS) {
      const i = text.indexOf(mark);
      if (i >= 0) fail(`${relative(web, f)} contains "${mark}" (…${text.slice(Math.max(0, i - 60), i + mark.length + 20).replace(/\s+/g, ' ')}…)`);
    }
  }
  const html = join(dist, 'index.html');
  if (existsSync(html)) {
    const text = readFileSync(html, 'utf8');
    const meta = /<meta name="squeekchain-project" content="([^"]*)"/.exec(text);
    if (!meta) fail('dist/index.html: <meta name="squeekchain-project"> missing');
    else if (!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(meta[1])) fail(`dist/index.html: squeekchain-project meta is not a UUID ("${meta[1]}")`);
    if (!text.includes(FOOTER)) fail('dist/index.html: §7.1 footer line missing');
  }
}

// 2) deployment.json
const depPath = join(web, 'src', 'deployment.json');
try {
  const dep = JSON.parse(readFileSync(depPath, 'utf8'));
  if (typeof dep.PIT !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(dep.PIT)) fail('src/deployment.json: PIT is not an address');
  else if (dep.PIT.toLowerCase() === ZERO) fail('src/deployment.json: PIT is the zero address (not deployed yet)');
  if (!Number.isInteger(dep.PIT_DEPLOY_BLOCK) || dep.PIT_DEPLOY_BLOCK <= 0) fail('src/deployment.json: PIT_DEPLOY_BLOCK is 0');
  if (!Number.isInteger(dep.GENESIS_HEIGHT) || dep.GENESIS_HEIGHT <= 0) fail('src/deployment.json: GENESIS_HEIGHT is 0');
  if (!Array.isArray(dep.GENESIS_CELLS) || dep.GENESIS_CELLS.length === 0) fail('src/deployment.json: GENESIS_CELLS is empty (the genesis frame would come from genesis.json, not the deployed Pit)');
  if (Array.isArray(dep.GENESIS_CELLS) && Array.isArray(dep.GENESIS_COLORS) && dep.GENESIS_CELLS.length !== dep.GENESIS_COLORS.length) fail('src/deployment.json: GENESIS_CELLS / GENESIS_COLORS length mismatch');

  // 3) logs bootstrap
  const bootPath = join(web, 'public', 'logs-bootstrap.json');
  if (!existsSync(bootPath)) fail('public/logs-bootstrap.json missing: run tools/bootstrap-logs.ts (PIT, PIT_DEPLOY_BLOCK env) before building');
  else {
    try {
      const boot = JSON.parse(readFileSync(bootPath, 'utf8'));
      if (boot.chainId !== 11155111) fail(`public/logs-bootstrap.json: chainId ${boot.chainId} is not Sepolia`);
      if (typeof boot.pit !== 'string' || boot.pit.toLowerCase() !== String(dep.PIT).toLowerCase()) fail(`public/logs-bootstrap.json: pit ${boot.pit} != deployment.json PIT ${dep.PIT}`);
      if (!Array.isArray(boot.chunks) || boot.chunks.length === 0) fail('public/logs-bootstrap.json: no chunks');
      else {
        const first = boot.chunks[0];
        if (String(first.fromBlock) !== String(dep.PIT_DEPLOY_BLOCK)) fail(`public/logs-bootstrap.json: first chunk starts at ${first.fromBlock}, PIT_DEPLOY_BLOCK is ${dep.PIT_DEPLOY_BLOCK}`);
        for (const c of boot.chunks) if (!/^0x[0-9a-fA-F]{64}$/.test(String(c.toBlockHash))) fail(`public/logs-bootstrap.json: chunk ${c.fromBlock}-${c.toBlock} has no toBlockHash`);
      }
    } catch (e) {
      fail(`public/logs-bootstrap.json unreadable: ${e.message}`);
    }
    if (existsSync(dist) && !existsSync(join(dist, 'logs-bootstrap.json'))) fail('dist/logs-bootstrap.json missing (public/ was not copied: rebuild after creating the bootstrap)');
  }
} catch (e) {
  fail(`src/deployment.json unreadable: ${e.message}`);
}

// 4) README (SPEC §7.3 Tester line lives ONLY in the README; the product never says it)
const readmes = [join(repo, 'README.md'), join(web, 'README.md')].filter(existsSync);
if (readmes.length === 0) fail('no README.md (repo root or web/): §7.3 Tester line, trust table and GIF note are required');
else {
  const withTester = readmes.filter((f) => readFileSync(f, 'utf8').includes(TESTER_LINE));
  if (withTester.length === 0) fail(`README.md does not contain the §7.3 Tester line verbatim: "${TESTER_LINE}"`);
  for (const f of readmes) {
    const text = readFileSync(f, 'utf8');
    for (const mark of [...FORBIDDEN_MARKS, '{date}', '{tx}', '{PIT}']) if (text.includes(mark)) fail(`${relative(repo, f)} still contains "${mark}"`);
  }
}

if (problems.length) {
  console.error(`release:check FAILED (${problems.length})`);
  for (const p of problems) console.error(` - ${p}`);
  process.exit(1);
}
console.log('release:check ok');
