export type Network = 'main' | 'testnet3' | 'testnet4' | 'signet' | 'regtest';
export const OUTPUT_NAMES: Record<number, string> = { 1: 'pay-to-public-key', 2: 'pay-to-connect' };
export function outputLabel(type: number): string {
  return `output type: ${type} (${OUTPUT_NAMES[type] ?? 'unknown'})`;
}
// All monetary values crossing the application boundary are integer connects encoded as strings.
export interface TxInput {
  index: number;
  txid?: string;
  vout?: number;
  coinbase?: string;
  sequence: number;
  value?: string;
  outputType?: number;
  address?: string;
  pubkey?: string;
  domain?: string;
  signatureAlgorithmsMask?: number;
  witness?: string[];
}
export interface TxOutput {
  index: number;
  value: string;
  type: number;
  address?: string;
  pubkey?: string;
  domain?: string;
  target?: string;
  rootsVersion?: number;
  signatureAlgorithmsMask?: number;
  spent?: { txid: string; inputIndex: number; confirmed: boolean };
}
export interface Transaction {
  txid: string;
  wtxid?: string;
  blockHash?: string;
  height?: number;
  time?: number;
  size: number;
  vsize: number;
  weight: number;
  fee?: string;
  inputs: TxInput[];
  outputs: TxOutput[];
}
export interface BlockSummary {
  hash: string;
  height: number;
  time: number;
  txCount: number;
  size: number;
  weight: number;
  difficulty: string;
  previousHash?: string;
  nextHash?: string;
  version?: number;
  nonce?: number;
  bits?: string;
  merkleRoot?: string;
  chainwork?: string;
  powHash?: string;
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}
export interface TransactionSummary {
  txid: string;
  height?: number;
  time?: number;
  outputCount: number;
  inputCount: number;
  totalOutput: string;
  p2cCount: number;
  fee?: string;
}
export interface Bounty extends TxOutput {
  txid: string;
  height: number;
  time: number;
}
export interface AccountSummary {
  query: string;
  kind: 'address' | 'domain';
  balance: string;
  totalReceived: string;
  totalSent: string;
  outputCount: number;
  unspentCount: number;
  transactions: Page<TransactionSummary>;
}
export interface IndexOverview {
  height: number;
  blockCount: number;
  transactionCount: number;
  bountyCount: number;
  availableBountyCount: number;
  availableBountyValue: string;
}
export interface ExplorerStatus {
  title: string;
  network: Network;
  chain?: string;
  connected: boolean;
  error?: string;
  nodeHeight?: number;
  headers?: number;
  indexedHeight: number;
  syncing: boolean;
  initialBlockDownload?: boolean;
  verificationProgress?: number;
  connections?: number;
  difficulty?: string;
  networkHashps?: number;
  mempoolCount?: number;
  mempoolBytes?: number;
  lastUpdated?: number;
  genesis?: string;
}
