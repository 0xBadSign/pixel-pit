// @vitest-environment node
// ABI pin (SPEC §5.1): src/abi.generated.ts must equal the compiled contract, its sha256 must match
// src/abi-hash.json, and the §5.1 human-readable strings must describe the same functions/events/errors
// as the compiled artifact (signatures, mutability, indexed flags). Known, accepted difference: the
// compiled budgetOf names its third output `coreHeight_` (the spec says `coreHeight`); the page decodes
// budgetOf positionally (rpc.ts decodeBudget), so only the position/type is load-bearing.
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAbi, toFunctionSelector, toEventSelector, type Abi, type AbiFunction, type AbiEvent } from 'viem';
import { pixelPitAbi, coreAbi, CORE_STATE_SELECTOR, TOPIC0, EVENT_SIGNATURES } from '../src/abi';
import abiHash from '../src/abi-hash.json';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const artifactPath = join(web, '..', 'out', 'PixelPit.sol', 'PixelPit.json');

/** SPEC §5.1 PixelPit surface, human-readable (the form the spec pins). */
const SPEC_PIXEL_PIT_STRINGS = [
  'function WIDTH() view returns (uint16)',
  'function HEIGHT() view returns (uint16)',
  'function CELLS() view returns (uint16)',
  'function PALETTE_SIZE() view returns (uint8)',
  'function CREWS() view returns (uint8)',
  'function CAP() view returns (uint8)',
  'function MAX_PLAYERS() view returns (uint32)',
  'function CORE() view returns (address)',
  'function GENESIS_HEIGHT() view returns (uint64)',
  'function DEPLOY_BLOCK() view returns (uint64)',
  'event GenesisSeeded(uint16 cellCount, uint64 coreHeight)',
  'event Joined(address indexed player, uint32 indexed playerId, uint8 crew, uint64 coreHeight)',
  'event Painted(address indexed player, uint64 indexed coreHeight, uint32 indexed playerId, uint16[] cells, uint8[] colors, uint8 budgetLeft)',
  'error AlreadyJoined()',
  'error NotJoined()',
  'error BadCrew(uint8 crew)',
  'error PlayerLimit()',
  'error EmptyStroke()',
  'error TooManyCells(uint256 n)',
  'error LengthMismatch()',
  'error BadCell(uint16 cell)',
  'error BadColor(uint8 color)',
  'error InsufficientBudget(uint8 have, uint256 need)',
  'error CoreUnavailable()',
  'function join(uint8 crew)',
  'function paint(uint16[] cells, uint8[] colors)',
  'function budgetOf(address p) view returns (bool joined, bool coreOk, uint64 coreHeight, uint8 ready, uint8 banked, uint8 fresh, uint64 arrived, uint64 forfeited)',
  'function coreHeight() view returns (uint64)',
  'function players(address p) view returns ((uint64 credited, uint64 lastHeight, uint32 strokes, uint32 id, uint8 crew, bool joined))',
  'function playerCount() view returns (uint32)',
  'function playerAt(uint32 id) view returns (address)',
  'function totalStrokes() view returns (uint64)',
  'function cell(uint16 index) view returns (uint8 color, uint8 crew, uint32 painterId, bool genesis)',
  'function rawCells() view returns (uint256[128])',
  'function crewScores() view returns (uint16[4] held)',
  'function seasonId() pure returns (uint8)',
] as const;

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

function strip(x: unknown): Json {
  if (Array.isArray(x)) return x.map(strip);
  if (x && typeof x === 'object') {
    const o: { [k: string]: Json } = {};
    for (const [k, v] of Object.entries(x as Record<string, unknown>)) if (k !== 'internalType') o[k] = strip(v);
    return o;
  }
  return x as Json;
}

function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

type Param = { type: string; name?: string; indexed?: boolean; components?: readonly Param[] };
/** Comparable shape: signature + mutability + per-input indexed flag + output types (names of outputs ignored). */
function shape(e: Abi[number]): string {
  const ins = (p: readonly Param[]) => p.map((i) => `${i.type}${i.indexed ? ' indexed' : ''} ${i.name ?? ''}`).join(',');
  const outs = (p: readonly Param[]) => p.map((o) => o.type + (o.components ? `(${o.components.map((c) => `${c.type} ${c.name ?? ''}`).join(',')})` : '')).join(',');
  switch (e.type) {
    case 'function':
      return `function ${e.name}(${ins(e.inputs as Param[])}) ${e.stateMutability} -> (${outs(e.outputs as Param[])})`;
    case 'event':
      return `event ${e.name}(${ins(e.inputs as Param[])})`;
    case 'error':
      return `error ${e.name}(${ins(e.inputs as Param[])})`;
    default:
      return `${e.type}`;
  }
}

describe('ABI pin (SPEC §5.1)', () => {
  it('abi.generated.ts matches the sha256 pinned in abi-hash.json', () => {
    expect(sha256(JSON.stringify(pixelPitAbi))).toBe(abiHash.PixelPit.sha256);
    expect(sha256(JSON.stringify(coreAbi))).toBe(abiHash.Core.sha256);
    expect(pixelPitAbi.length).toBe(abiHash.PixelPit.entries);
    expect(coreAbi.length).toBe(abiHash.Core.entries);
  });

  it('abi.generated.ts equals the compiled artifact (when out/ is present)', () => {
    if (!existsSync(artifactPath)) {
      console.warn('out/PixelPit.sol/PixelPit.json missing (run forge build); skipping artifact comparison');
      return;
    }
    const art = JSON.parse(readFileSync(artifactPath, 'utf8')) as { abi: unknown };
    expect(strip(pixelPitAbi)).toEqual(strip(art.abi));
  });

  it('the §5.1 human-readable PixelPit strings describe the compiled contract (constructor aside)', () => {
    const spec = parseAbi(SPEC_PIXEL_PIT_STRINGS) as unknown as Abi;
    const compiled = (pixelPitAbi as unknown as Abi).filter((e) => e.type !== 'constructor');
    const ctor = (pixelPitAbi as unknown as Abi).find((e) => e.type === 'constructor');
    expect(ctor).toBeDefined();
    expect(new Set(compiled.map(shape))).toEqual(new Set(spec.map(shape)));
    expect(compiled.length).toBe(spec.length);
  });

  it('budgetOf: compiled output 2 is named coreHeight_ (spec: coreHeight); same position and type', () => {
    const f = (pixelPitAbi as unknown as Abi).find((e) => e.type === 'function' && e.name === 'budgetOf') as AbiFunction;
    expect(f.outputs[2]).toMatchObject({ name: 'coreHeight_', type: 'uint64' });
    expect(f.outputs.map((o) => o.type)).toEqual(['bool', 'bool', 'uint64', 'uint8', 'uint8', 'uint8', 'uint64', 'uint64']);
  });

  it('selectors and topic0 are the pinned values', () => {
    const state = (coreAbi as unknown as Abi).find((e) => e.type === 'function' && e.name === 'state') as AbiFunction;
    expect(toFunctionSelector(state)).toBe(CORE_STATE_SELECTOR);
    const settled = (coreAbi as unknown as Abi).find((e) => e.type === 'event' && e.name === 'BatchSettled') as AbiEvent;
    expect(toEventSelector(settled)).toBe(TOPIC0.BatchSettled);
    expect(TOPIC0.BatchSettled.startsWith('0x66d3b3a5')).toBe(true);
    for (const name of ['Joined', 'Painted', 'GenesisSeeded'] as const) {
      const ev = (pixelPitAbi as unknown as Abi).find((e) => e.type === 'event' && e.name === name) as AbiEvent;
      expect(toEventSelector(ev)).toBe(TOPIC0[name]);
      expect(toEventSelector(EVENT_SIGNATURES[name])).toBe(TOPIC0[name]);
    }
  });
});
