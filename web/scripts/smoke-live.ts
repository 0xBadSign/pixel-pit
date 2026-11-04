// Read-only live smoke test against Sepolia: one tick (primary -> fallback) + the §6.2 deployment check.
// Run from web/:  npx vite-node scripts/smoke-live.ts
import { makeHttpClients, runTick } from '../src/rpc';
import { checkDeployment } from '../src/deployment-check';
import { CONFIG } from '../src/config';

const clients = makeHttpClients(CONFIG.RPC);
const t = await runTick(clients, {});
if (t.ok) {
  console.log('tick ok', { provider: t.provider, head: t.head, safe: t.safe, finalized: t.finalized, finalityTags: t.finalityTags, headAgeS: Math.floor(Date.now() / 1000) - Number(t.headTimestamp) });
  console.log('core state', { blockHeight: t.state.blockHeight, settledThroughRound: t.state.settledThroughRound, cumulativeBlockUnits: t.state.cumulativeBlockUnits, paused: t.state.paused });
  console.log('pit reads', t.pit ? 'present' : 'skipped (PIT placeholder)');
} else {
  console.log('tick FAILED', t);
}
const d = await checkDeployment(clients[0]!);
if (d.status === 'ok' || d.status === 'changed') {
  console.log('deployment', d.status, { impl: d.impl, runtimeHash: d.runtimeHash, streamId: d.streamId, genesisTimestamp: d.genesisTimestamp, targetBlocks: d.targetBlocks, mismatches: d.mismatches });
} else {
  console.log('deployment', d);
}
