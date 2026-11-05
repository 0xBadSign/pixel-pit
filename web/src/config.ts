// Pinned configuration (SPEC §6.1). Nothing here is taken from the API, the URL or the user.
import type { Address, Hex } from 'viem';
import deploymentJson from './deployment.json';
import devDeploymentJson from './deployment.dev.json';
import genesisJson from './genesis.json'; // script/genesis.ts output ({cells, colors}); deployment.json overrides when filled

const genesisCells: number[] = deploymentJson.GENESIS_CELLS.length ? (deploymentJson.GENESIS_CELLS as number[]) : (genesisJson.cells as number[]);
const genesisColors: number[] = deploymentJson.GENESIS_CELLS.length ? (deploymentJson.GENESIS_COLORS as number[]) : (genesisJson.colors as number[]);

export type Config = {
  chainId: number;
  chainIdHex: Hex;
  CORE: Address;
  EXPECTED_IMPL: Address;
  EXPECTED_RUNTIME_HASH: Hex;
  EXPECTED_STREAM_ID: Hex;
  EXPECTED_GENESIS_TS: bigint;
  EXPECTED_TARGET_BLOCKS: bigint;
  PIT: Address;
  PIT_DEPLOY_BLOCK: bigint;
  GENESIS_HEIGHT: bigint;
  GENESIS_CELLS: number[];
  GENESIS_COLORS: number[];
  RPC: readonly string[];
  LOGS_BOOTSTRAP: string;
  API_STATUS: string;
  API_CORE: string;
  FINALITY_TAGS: boolean;
  FALLBACK_CONFIRMATIONS: { safe: number; finalized: number };
  HEAD_STALE_SECONDS: number;
  TICK_MS: number;
  TICK_HIDDEN_MS: number;
  API_POLL_MS: number;
  LOG_CHUNK_BLOCKS: number;
  RPC_TIMEOUT_MS: number;
  EXPLORER: string;
  DEV: boolean;
};

const prod: Config = {
  chainId: 11155111,
  chainIdHex: '0xaa36a7',
  CORE: '0xfd6c166d4b8e2962e65746a13e5a0797cd4de0c4',
  EXPECTED_IMPL: '0x6869d6102696243fd17013ab955d99cd0c522ad3',
  EXPECTED_RUNTIME_HASH: '0x65b5780a4fccafedeca1260806364d2bb512b4501c097253f792ae2839565a9c',
  EXPECTED_STREAM_ID: '0xa78faebd5aad38b4f90c7f61b9c5c10e8d9b9afe74ebfc2e82ca98b7e57ed562',
  EXPECTED_GENESIS_TS: 1793735400n,
  EXPECTED_TARGET_BLOCKS: 40n,
  PIT: deploymentJson.PIT as Address, // <after deploy>
  PIT_DEPLOY_BLOCK: BigInt(deploymentJson.PIT_DEPLOY_BLOCK), // <after deploy>
  GENESIS_HEIGHT: BigInt(deploymentJson.GENESIS_HEIGHT),
  GENESIS_CELLS: genesisCells, // <script output>
  GENESIS_COLORS: genesisColors,
  RPC: ['https://sepolia.gateway.tenderly.co', 'https://ethereum-sepolia-rpc.publicnode.com'],
  LOGS_BOOTSTRAP: './logs-bootstrap.json', // build-time; Painted/Joined/BatchSettled from PIT_DEPLOY_BLOCK to BOOTSTRAP_BLOCK
  API_STATUS: 'https://api.squeekchain.com/v1/status', // display only (PROVISIONAL light)
  API_CORE: 'https://api.squeekchain.com/v1/core', // display only (reported core address next to pinned)
  FINALITY_TAGS: true, // eth_getBlockByNumber('safe'/'finalized'); fallback head-12 / head-64 if unsupported
  FALLBACK_CONFIRMATIONS: { safe: 12, finalized: 64 },
  HEAD_STALE_SECONDS: 120,
  TICK_MS: 12_000,
  TICK_HIDDEN_MS: 60_000,
  API_POLL_MS: 15_000,
  LOG_CHUNK_BLOCKS: 10_000,
  RPC_TIMEOUT_MS: 8_000,
  EXPLORER: 'https://eth-sepolia.blockscout.com',
  DEV: false,
};

function buildConfig(): Config {
  // `__PIT_DEV__` is a compile-time constant (vite.config.ts `define`). In a production build
  // it is `false`, so this branch and the dev JSON import are dropped by the bundler.
  if (__PIT_DEV__) {
    const dev = devDeploymentJson;
    return {
      ...prod,
      chainId: dev.chainId,
      chainIdHex: `0x${dev.chainId.toString(16)}` as Hex,
      CORE: dev.CORE as Address,
      PIT: dev.PIT as Address,
      PIT_DEPLOY_BLOCK: BigInt(dev.PIT_DEPLOY_BLOCK),
      GENESIS_HEIGHT: BigInt(dev.GENESIS_HEIGHT),
      GENESIS_CELLS: dev.GENESIS_CELLS as number[],
      GENESIS_COLORS: dev.GENESIS_COLORS as number[],
      RPC: dev.RPC,
      FINALITY_TAGS: false, // anvil has no safe/finalized tags
      DEV: true,
    };
  }
  return prod;
}

export const CONFIG: Config = buildConfig();

export const WIDTH = 32;
export const HEIGHT = 32;
export const CELLS = 1024;
export const CAP = 40;
export const PALETTE_SIZE = 16;
export const CREWS = 4;

/** SPEC §5.2 palette: index -> hex, name. Index 0 = pit black. */
export const PALETTE: readonly { hex: string; name: string }[] = [
  { hex: '#0b0d12', name: 'pit black' },
  { hex: '#ffffff', name: 'white' },
  { hex: '#c9ced6', name: 'light grey' },
  { hex: '#5c6370', name: 'slate' },
  { hex: '#e63946', name: 'red' },
  { hex: '#f4a261', name: 'orange' },
  { hex: '#ffd166', name: 'yellow' },
  { hex: '#8ac926', name: 'green' },
  { hex: '#2a9d8f', name: 'teal' },
  { hex: '#4cc9f0', name: 'sky' },
  { hex: '#3a86ff', name: 'blue' },
  { hex: '#7b2cbf', name: 'violet' },
  { hex: '#ff70a6', name: 'pink' },
  { hex: '#a0522d', name: 'hamster brown' },
  { hex: '#f1dcc1', name: 'hamster cream' },
  { hex: '#ffbf69', name: 'amber' },
];

/** Crews: 0 Wheel, 1 Burrow, 2 Seed, 3 Moon. Region-map tint uses the palette index listed in §5.2. */
export const CREW_NAMES = ['Wheel', 'Burrow', 'Seed', 'Moon'] as const;
export const CREW_PALETTE_INDEX = [15, 13, 7, 9] as const;
export const CREW_COLORS: readonly string[] = CREW_PALETTE_INDEX.map((i) => PALETTE[i]!.hex);

export function crewName(crew: number): string {
  return CREW_NAMES[crew] ?? `crew ${crew}`;
}

export function paletteHex(index: number): string {
  return PALETTE[index & 0xf]!.hex;
}

export function paletteName(index: number): string {
  return PALETTE[index & 0xf]!.name;
}
