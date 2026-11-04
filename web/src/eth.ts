// Thin JSON-RPC helpers over a viem Client (raw `client.request` + viem's ABI codec).
//
// Why not viem/actions (readContract, getBlock, getCode, getBalance, getTransactionReceipt): those pull the
// generic `call` pipeline (CCIP-read, multicall3/deployless bytecode, contract error wrappers, block and
// receipt formatters) into the bundle, about 30 KB raw, for behaviour this page never uses. The spec budget
// is < 200 KB for the whole build (SPEC §6.1). Every helper here issues exactly one JSON-RPC request and
// fails loudly: a missing contract ("0x" from eth_call) throws instead of decoding garbage, so the tick that
// called it fails as a whole (SPEC §6.3 single-provider-per-tick) and the UI shows UNKNOWN, never a 0.
import {
  decodeFunctionResult,
  encodeFunctionData,
  type Abi,
  type Address,
  type Client,
  type ContractFunctionArgs,
  type ContractFunctionName,
  type ContractFunctionReturnType,
  type Hex,
} from 'viem';

export type BlockTag = 'latest' | 'safe' | 'finalized' | 'earliest' | 'pending';
/** A tag, an exact block number, or an EIP-1898 block hash (reads pinned to one exact block even across a reorg). */
export type BlockRef = BlockTag | bigint | { blockHash: Hex };

export type BlockHeader = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint };

export type BlockParam = Hex | BlockTag | { blockHash: Hex; requireCanonical?: boolean };

export function blockParam(b: BlockRef | undefined): BlockParam {
  if (typeof b === 'bigint') return `0x${b.toString(16)}` as Hex;
  if (b && typeof b === 'object') return { blockHash: b.blockHash };
  return b ?? 'latest';
}

type RawBlockHeader = { number: Hex | null; hash: Hex | null; parentHash: Hex; timestamp: Hex } | null;

/** eth_getBlockByNumber(tag|number, false) or eth_getBlockByHash: number/hash/parentHash/timestamp only. Throws when the block is unknown. */
export async function getBlockHeader(client: Client, block: BlockRef = 'latest'): Promise<BlockHeader> {
  const param = blockParam(block);
  const b =
    typeof param === 'object'
      ? ((await client.request({ method: 'eth_getBlockByHash', params: [param.blockHash, false] })) as RawBlockHeader)
      : ((await client.request({ method: 'eth_getBlockByNumber', params: [param, false] })) as RawBlockHeader);
  if (!b || !b.number || !b.hash) throw new Error(`block ${typeof param === 'object' ? param.blockHash : param} not found`);
  return { number: BigInt(b.number), hash: b.hash, parentHash: b.parentHash, timestamp: BigInt(b.timestamp) };
}

export type EthCallParams<
  abi extends Abi,
  fn extends ContractFunctionName<abi, 'pure' | 'view'>,
  args extends ContractFunctionArgs<abi, 'pure' | 'view', fn>,
> = {
  address: Address;
  abi: abi;
  functionName: fn;
  args?: args;
  /** pinned block; defaults to 'latest' */
  block?: BlockRef;
};

/** eth_call pinned to `block`, decoded with the ABI. "0x" (no contract / selfdestructed) throws. */
export async function ethCall<
  const abi extends Abi,
  fn extends ContractFunctionName<abi, 'pure' | 'view'>,
  const args extends ContractFunctionArgs<abi, 'pure' | 'view', fn>,
>(client: Client, p: EthCallParams<abi, fn, args>): Promise<ContractFunctionReturnType<abi, 'pure' | 'view', fn, args>> {
  const data = encodeFunctionData({ abi: p.abi as Abi, functionName: p.functionName as string, args: p.args as readonly unknown[] | undefined });
  const out = (await client.request({ method: 'eth_call', params: [{ to: p.address, data }, blockParam(p.block) as never] })) as Hex;
  if (!out || out === '0x') throw new Error(`eth_call ${String(p.functionName)} at ${p.address} returned no data`);
  return decodeFunctionResult({ abi: p.abi as Abi, functionName: p.functionName as string, data: out }) as ContractFunctionReturnType<abi, 'pure' | 'view', fn, args>;
}

/** eth_getCode; null when the address holds no code. */
export async function getCodeAt(client: Client, address: Address, block: BlockRef = 'latest'): Promise<Hex | null> {
  const code = (await client.request({ method: 'eth_getCode', params: [address, blockParam(block) as never] })) as Hex;
  return code && code !== '0x' ? code : null;
}

/** eth_getBalance pinned to `block` (the tick's head, so it carries the same label as the rest of the page). */
export async function getBalanceAt(client: Client, address: Address, block: BlockRef = 'latest'): Promise<bigint> {
  const wei = (await client.request({ method: 'eth_getBalance', params: [address, blockParam(block) as never] })) as Hex;
  return BigInt(wei);
}

/** eth_getTransactionCount pinned to `block` ('pending' = next nonce the node would assign). */
export async function getTransactionCount(client: Client, address: Address, block: BlockRef = 'latest'): Promise<number> {
  const n = (await client.request({ method: 'eth_getTransactionCount', params: [address, blockParam(block) as never] })) as Hex;
  return Number(BigInt(n));
}

export type ReceiptSummary = { blockNumber: bigint; status: 'success' | 'reverted'; transactionHash: Hex };

type RawReceipt = { blockNumber: Hex; status: Hex; transactionHash: Hex } | null;

/** eth_getTransactionReceipt; null while the tx is not mined. */
export async function getReceipt(client: Client, hash: Hex): Promise<ReceiptSummary | null> {
  const r = (await client.request({ method: 'eth_getTransactionReceipt', params: [hash] })) as RawReceipt;
  if (!r || !r.blockNumber) return null;
  return { blockNumber: BigInt(r.blockNumber), status: BigInt(r.status) === 1n ? 'success' : 'reverted', transactionHash: r.transactionHash };
}
