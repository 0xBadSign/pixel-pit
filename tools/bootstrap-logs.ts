// Build web/public/logs-bootstrap.json (SPEC §6.3).
// Env: RPC_URL (single provider; dry-run: optional comma list, default tenderly+publicnode),
//      PIT, PIT_DEPLOY_BLOCK, BOOTSTRAP_BLOCK (default head), CORE (default Sepolia proxy), CHUNK (<=10000).
// --dry-run: Core BatchSettled only, from 9,900,000 (or PIT_DEPLOY_BLOCK) to latest, nothing written.
import { createPublicClient, http, parseAbi, type Log } from 'viem';
import { sepolia } from 'viem/chains';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const TENDERLY = 'https://sepolia.gateway.tenderly.co';
const PUBLICNODE = 'https://ethereum-sepolia-rpc.publicnode.com';
const CORE = (process.env.CORE ?? '0x980b4424c007caf7a1f3670b48c8eaef7ebc3d44') as `0x${string}`;
const CHUNK = Math.min(Number(process.env.CHUNK ?? 10000), 10000);
const CONC = Number(process.env.CONCURRENCY ?? 2);
const dry = process.argv.includes('--dry-run');

const coreAbi = parseAbi([
  'event BatchSettled(bytes32 indexed digest,address indexed reporter,uint64 indexed settledThroughRound,uint256 nonce,uint64 previousSettledThroughRound,uint16 activeRoundCount,uint64 cumulativeWork,uint96 cumulativeBlockUnits)',
]);
const pitAbi = parseAbi([
  'event Joined(address indexed player, uint32 indexed playerId, uint8 crew, uint64 coreHeight)',
  'event Painted(address indexed player, uint64 indexed coreHeight, uint32 indexed playerId, uint16[] cells, uint8[] colors, uint8 budgetLeft)',
]);

const ser = (v: unknown) => JSON.stringify(v, (_, x) => (typeof x === 'bigint' ? x.toString() : x));
const hex = (n: bigint | number) => `0x${BigInt(n).toString(16)}`;

/** The exact shape web/src/logs.ts RawLog expects (hex blockNumber/logIndex, no decoded args). */
function toRawLog(l: Log) {
  if (l.blockNumber === null || l.blockHash === null || l.transactionHash === null || l.logIndex === null) throw new Error('pending log in a mined range');
  return { address: l.address, topics: l.topics, data: l.data, blockNumber: hex(l.blockNumber), blockHash: l.blockHash, transactionHash: l.transactionHash, logIndex: hex(l.logIndex) };
}

async function retry<T>(f: () => Promise<T>, what: string): Promise<T> {
  let err: unknown;
  for (let i = 0; i < 6; i++) {
    try { return await f(); } catch (e) { err = e; await new Promise((r) => setTimeout(r, Math.min(500 * 2 ** i, 5000))); }
  }
  throw new Error(`${what} failed: ${(err as Error).message?.split('\n')[0]}`);
}

async function fetchChunks(rpc: string, from: bigint, to: bigint, sources: { address: `0x${string}`; abi: any }[]) {
  const client = createPublicClient({ chain: sepolia, transport: http(rpc, { timeout: 20000, retryCount: 0 }) });
  const ranges: [bigint, bigint][] = [];
  for (let a = from; a <= to; a += BigInt(CHUNK)) ranges.push([a, a + BigInt(CHUNK) - 1n > to ? to : a + BigInt(CHUNK) - 1n]);
  const out = new Array(ranges.length);
  let next = 0;
  await Promise.all(Array.from({ length: CONC }, async () => {
    while (next < ranges.length) {
      const i = next++; const [a, b] = ranges[i];
      const block = await retry(() => client.getBlock({ blockNumber: b }), `block ${b}`);
      if (!block?.hash) throw new Error(`null block ${b}`);
      const logs: Log[] = [];
      for (const s of sources) {
        const l = await retry(() => client.getLogs({ address: s.address, events: s.abi, fromBlock: a, toBlock: b, strict: true }), `logs ${a}-${b}`);
        if (!Array.isArray(l)) throw new Error(`non-array logs ${a}-${b}`); // never write failure as empty chunk
        logs.push(...(l as Log[]));
      }
      logs.sort((x, y) => Number(x.blockNumber! - y.blockNumber!) || x.logIndex! - y.logIndex!);
      out[i] = { fromBlock: a, toBlock: b, toBlockHash: block.hash, logs: logs.map(toRawLog) };
    }
  }));
  return { client, chunks: out as { fromBlock: bigint; toBlock: bigint; toBlockHash: string; logs: ReturnType<typeof toRawLog>[] }[] };
}

async function main() {
  if (dry) {
    const from = BigInt(process.env.PIT_DEPLOY_BLOCK ?? 9_900_000);
    const rpcs = (process.env.RPC_URL ?? `${TENDERLY},${PUBLICNODE}`).split(',');
    for (const rpc of rpcs) {
      const t0 = Date.now();
      try {
        const c = createPublicClient({ chain: sepolia, transport: http(rpc, { timeout: 20000 }) });
        const head = await c.getBlockNumber();
        const { chunks } = await fetchChunks(rpc, from, head, [{ address: CORE, abi: coreAbi }]);
        const n = chunks.reduce((s, k) => s + k.logs.length, 0);
        console.log(`${rpc}: from=${from} head=${head} chunks=${chunks.length} BatchSettled logs=${n} time=${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (e) {
        console.log(`${rpc}: FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s: ${(e as Error).message}`);
      }
    }
    return;
  }
  const rpc = process.env.RPC_URL ?? TENDERLY;
  const pit = process.env.PIT as `0x${string}` | undefined;
  if (!pit || !process.env.PIT_DEPLOY_BLOCK) throw new Error('PIT and PIT_DEPLOY_BLOCK env required');
  const client = createPublicClient({ chain: sepolia, transport: http(rpc, { timeout: 20000 }) });
  const head = await client.getBlockNumber();
  const to = process.env.BOOTSTRAP_BLOCK ? BigInt(process.env.BOOTSTRAP_BLOCK) : head;
  if (head < to) throw new Error(`provider head ${head} < toBlock ${to}`);
  const from = BigInt(process.env.PIT_DEPLOY_BLOCK);
  const { chunks } = await fetchChunks(rpc, from, to, [{ address: pit, abi: pitAbi }, { address: CORE, abi: coreAbi }]);
  // web/src/logs.ts BootstrapFile: { version, chainId, pit, core, fromBlock, bootstrapBlock, chunks[] } — chunk logs are RawLog-shaped
  const doc = { version: 1, chainId: sepolia.id, pit, core: CORE, fromBlock: from, bootstrapBlock: to, toBlockHash: chunks[chunks.length - 1].toBlockHash, generatedAt: new Date().toISOString(), rpc, chunks };
  const file = fileURLToPath(new URL('../web/public/logs-bootstrap.json', import.meta.url));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, ser(doc) + '\n');
  console.log(`wrote ${file}: ${chunks.length} chunks, ${chunks.reduce((s, k) => s + k.logs.length, 0)} logs`);
}
main().catch((e) => { console.error(e.message); process.exit(1); });
