// Deployment check (SPEC §6.2), one short function, run on every load against the tick provider:
// Pit.CORE() == CORE, Core.implementationCodeAddress() == EXPECTED_IMPL, keccak(eth_getCode(impl)) ==
// EXPECTED_RUNTIME_HASH, configuration().streamId / genesisTimestamp / targetBlocksPerActiveRound match.
// The api /v1/core address is a separate display-only comparison merged in by the caller.
import { keccak256, type Address, type Hex } from 'viem';
import { ethCall, getCodeAt } from './eth';
import { CONFIG, type Config } from './config';
import { coreAbi, pixelPitAbi } from './abi';
import { ZERO_ADDRESS, type RpcClient } from './rpc';
import type { DeploymentCheck } from './state';

export async function checkDeployment(client: RpcClient, cfg: Config = CONFIG, apiCore: Address | null = null): Promise<DeploymentCheck> {
  const pub = client.pub;
  const checkedAt = Date.now();
  try {
    const pitConfigured = cfg.PIT.toLowerCase() !== ZERO_ADDRESS;
    if (cfg.DEV) {
      // anvil MockCore has no proxy, implementation or configuration(): only Pit.CORE() is checked (dev builds only;
      // this branch is tree-shaken out of production where cfg.DEV is the constant false).
      const pitCoreDev = pitConfigured ? await ethCall(pub, { address: cfg.PIT, abi: pixelPitAbi, functionName: 'CORE' }) : null;
      const mm = pitCoreDev && pitCoreDev.toLowerCase() !== cfg.CORE.toLowerCase() ? [`Pit.CORE() ${pitCoreDev}`] : [];
      const apiMm = apiCore !== null && apiCore.toLowerCase() !== cfg.CORE.toLowerCase();
      return { status: mm.length === 0 && !apiMm ? 'ok' : 'changed', pitCore: pitCoreDev ?? null, impl: null, runtimeHash: null, streamId: null, genesisTimestamp: null, targetBlocks: null, mismatches: mm, apiCore, apiMismatch: apiMm, checkedAt };
    }
    const [pitCore, impl, configuration] = await Promise.all([
      pitConfigured ? ethCall(pub, { address: cfg.PIT, abi: pixelPitAbi, functionName: 'CORE' }) : Promise.resolve(null),
      ethCall(pub, { address: cfg.CORE, abi: coreAbi, functionName: 'implementationCodeAddress' }),
      ethCall(pub, { address: cfg.CORE, abi: coreAbi, functionName: 'configuration' }),
    ]);
    const code = await getCodeAt(pub, impl);
    const runtimeHash: Hex | null = code ? keccak256(code) : null;

    const mismatches: string[] = [];
    if (pitCore && pitCore.toLowerCase() !== cfg.CORE.toLowerCase()) mismatches.push(`Pit.CORE() ${pitCore}`);
    if (impl.toLowerCase() !== cfg.EXPECTED_IMPL.toLowerCase()) mismatches.push(`implementation ${impl}`);
    if (!runtimeHash || runtimeHash.toLowerCase() !== cfg.EXPECTED_RUNTIME_HASH.toLowerCase()) mismatches.push(`runtime hash ${runtimeHash ?? 'none'}`);
    if (configuration.streamId.toLowerCase() !== cfg.EXPECTED_STREAM_ID.toLowerCase()) mismatches.push(`streamId ${configuration.streamId}`);
    if (configuration.genesisTimestamp !== cfg.EXPECTED_GENESIS_TS) mismatches.push(`genesisTimestamp ${configuration.genesisTimestamp}`);
    if (configuration.targetBlocksPerActiveRound !== cfg.EXPECTED_TARGET_BLOCKS) mismatches.push(`targetBlocksPerActiveRound ${configuration.targetBlocksPerActiveRound}`);

    const apiMismatch = apiCore !== null && apiCore.toLowerCase() !== cfg.CORE.toLowerCase();
    return {
      status: mismatches.length === 0 && !apiMismatch ? 'ok' : 'changed',
      pitCore: pitCore ?? null,
      impl,
      runtimeHash,
      streamId: configuration.streamId,
      genesisTimestamp: configuration.genesisTimestamp,
      targetBlocks: configuration.targetBlocksPerActiveRound,
      mismatches,
      apiCore,
      apiMismatch,
      checkedAt,
    };
  } catch (e) {
    return { status: 'unreachable', error: e instanceof Error ? (e.message.split('\n')[0] ?? e.message) : String(e), checkedAt };
  }
}

/** Re-evaluate only the API part of an existing result (the /v1/core poll arrives later than the RPC check). */
export function withApiCore(d: DeploymentCheck, apiCore: Address | null, cfg: Config = CONFIG): DeploymentCheck {
  if (d.status !== 'ok' && d.status !== 'changed') return d;
  const apiMismatch = apiCore !== null && apiCore.toLowerCase() !== cfg.CORE.toLowerCase();
  return { ...d, apiCore, apiMismatch, status: d.mismatches.length === 0 && !apiMismatch ? 'ok' : 'changed' };
}
