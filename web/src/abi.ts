// ABIs (SPEC §5.1). `pixelPitAbi` is generated from the compiled contract (out/PixelPit.sol/PixelPit.json)
// by scripts/gen-abi.mjs and pinned by sha256 in src/abi-hash.json; `coreAbi` is generated from the §5.1
// human-readable Core strings kept in that script. JSON `as const` instead of parseAbi(strings) keeps the
// human-readable parser out of the production bundle; tests/abi.test.ts re-derives both and compares.
import { keccak256, toBytes } from 'viem';

export { pixelPitAbi, coreAbi } from './abi.generated';

/** Core.state() selector, pinned (SPEC §3.2). */
export const CORE_STATE_SELECTOR = '0xc19d93fb' as const;

/** Event signatures (used for topic0 pinning and the bootstrap/tail log filters). */
export const EVENT_SIGNATURES = {
  Joined: 'Joined(address,uint32,uint8,uint64)',
  Painted: 'Painted(address,uint64,uint32,uint16[],uint8[],uint8)',
  GenesisSeeded: 'GenesisSeeded(uint16,uint64)',
  BatchSettled: 'BatchSettled(bytes32,address,uint64,uint256,uint64,uint16,uint64,uint96)',
} as const;

export const TOPIC0 = {
  Joined: keccak256(toBytes(EVENT_SIGNATURES.Joined)),
  Painted: keccak256(toBytes(EVENT_SIGNATURES.Painted)),
  GenesisSeeded: keccak256(toBytes(EVENT_SIGNATURES.GenesisSeeded)),
  BatchSettled: keccak256(toBytes(EVENT_SIGNATURES.BatchSettled)),
} as const;

/** 1e9 block units per Squeek block: blockHeight = cumulativeBlockUnits / 1e9 (SPEC §3.2). */
export const BLOCK_UNITS_PER_BLOCK = 1_000_000_000n;
