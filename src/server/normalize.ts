import { bech32m } from 'bech32';
import type { BlockSummary, Network, Transaction, TxInput, TxOutput } from '../shared/types.js';

export function safeInteger(value: unknown, field = 'integer'): number {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^-?\d+$/.test(value))) {
    throw new Error(`The node returned an invalid ${field}.`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`The node returned an unsafe ${field}.`);
  return number;
}

/** Convert decimal CC to integer connects without routing its digits through Number. */
export function decimalToAtomic(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Invalid CC amount.');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Invalid CC amount.');
  const text = String(value);
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match || text.length > 1024) throw new Error('Invalid CC amount.');
  const fraction = match[3] ?? '';
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1024)
    throw new Error('Invalid CC amount exponent.');
  const digits = BigInt(match[2] + fraction);
  const shift = 10 + exponent - fraction.length;
  let atomic: bigint;
  if (shift >= 0) {
    atomic = digits * 10n ** BigInt(shift);
  } else {
    const divisor = 10n ** BigInt(-shift);
    if (digits % divisor !== 0n) throw new Error('A CC amount has more than 10 decimal places.');
    atomic = digits / divisor;
  }
  return (match[1] === '-' ? -atomic : atomic).toString();
}

function hex(value: unknown, field: string, length = 64): string {
  if (typeof value !== 'string' || value.length !== length || !/^[0-9a-f]+$/i.test(value)) {
    throw new Error(`The node returned an invalid ${field}.`);
  }
  return value.toLowerCase();
}

function optionalInteger(value: unknown, field: string): number | undefined {
  return value === undefined || value === null ? undefined : safeInteger(value, field);
}

function outputFields(raw: any, network: Network): Omit<TxOutput, 'index'> {
  if (!raw || typeof raw !== 'object') throw new Error('The node returned an invalid transaction output.');
  const type = safeInteger(raw.type, 'output type');
  const value = decimalToAtomic(raw.value);
  if (BigInt(value) < 0n) throw new Error('The node returned a negative transaction output.');
  const output: Omit<TxOutput, 'index'> = { type, value };
  if (type === 1) {
    output.pubkey = hex(raw.pubkey, 'output public key');
    const hrp = network === 'main' ? 'cc' : network === 'regtest' ? 'ccrt' : 'tcc';
    output.address =
      typeof raw.scriptPubKey?.address === 'string'
        ? raw.scriptPubKey.address
        : bech32m.encode(hrp, [1, ...bech32m.toWords(Buffer.from(output.pubkey, 'hex'))]);
  } else if (type === 2) {
    if (typeof raw.domain !== 'string' || raw.domain.length === 0)
      throw new Error('The node returned an invalid P2C domain.');
    output.domain = raw.domain;
    output.target = hex(raw.connection_work_target, 'P2C work target');
    output.rootsVersion = safeInteger(raw.root_certificates_version, 'P2C root version');
  }
  return output;
}

export function normalizeTransaction(
  raw: any,
  network: Network,
  context: { height?: number; blockHash?: string; time?: number } = {},
): Transaction {
  if (!raw || !Array.isArray(raw.vin) || !Array.isArray(raw.vout))
    throw new Error('The node returned an invalid transaction.');
  const inputs: TxInput[] = raw.vin.map((input: any, index: number) => {
    const normalized: TxInput = { index, sequence: safeInteger(input.sequence, 'input sequence') };
    if (typeof input.coinbase === 'string') normalized.coinbase = input.coinbase;
    else {
      normalized.txid = hex(input.txid, 'input transaction ID');
      normalized.vout = safeInteger(input.vout, 'previous output index');
    }
    if (Array.isArray(input.txinwitness)) {
      if (
        !input.txinwitness.every(
          (item: unknown) => typeof item === 'string' && /^(?:[0-9a-f]{2})*$/i.test(item),
        )
      ) {
        throw new Error('The node returned an invalid input witness.');
      }
      normalized.witness = input.txinwitness;
    }
    if (input.prevout) {
      const previous = outputFields(input.prevout, network);
      normalized.value = previous.value;
      normalized.outputType = previous.type;
      if (previous.address) normalized.address = previous.address;
      if (previous.pubkey) normalized.pubkey = previous.pubkey;
      if (previous.domain) normalized.domain = previous.domain;
    }
    return normalized;
  });
  return {
    txid: hex(raw.txid, 'transaction ID'),
    ...(raw.hash ? { wtxid: hex(raw.hash, 'witness transaction ID') } : {}),
    ...((context.blockHash ?? raw.blockhash)
      ? { blockHash: hex(context.blockHash ?? raw.blockhash, 'block hash') }
      : {}),
    ...((context.height ?? raw.height) !== undefined
      ? { height: safeInteger(context.height ?? raw.height, 'transaction height') }
      : {}),
    ...((context.time ?? raw.blocktime ?? raw.time) !== undefined
      ? { time: safeInteger(context.time ?? raw.blocktime ?? raw.time, 'transaction time') }
      : {}),
    size: safeInteger(raw.size, 'transaction size'),
    vsize: safeInteger(raw.vsize, 'transaction virtual size'),
    weight: safeInteger(raw.weight, 'transaction weight'),
    ...(raw.fee !== undefined ? { fee: decimalToAtomic(raw.fee) } : {}),
    inputs,
    outputs: raw.vout.map((output: any, index: number) => ({
      index: safeInteger(output.n ?? index, 'output index'),
      ...outputFields(output, network),
    })),
  };
}

export function normalizeBlock(raw: any, _network?: Network): BlockSummary {
  if (!raw || typeof raw !== 'object') throw new Error('The node returned an invalid block.');
  return {
    hash: hex(raw.hash, 'block hash'),
    height: safeInteger(raw.height, 'block height'),
    time: safeInteger(raw.time, 'block time'),
    txCount: safeInteger(raw.nTx ?? raw.tx?.length, 'block transaction count'),
    size: safeInteger(raw.size, 'block size'),
    weight: safeInteger(raw.weight, 'block weight'),
    difficulty: String(raw.difficulty ?? '0'),
    ...(raw.previousblockhash ? { previousHash: hex(raw.previousblockhash, 'previous block hash') } : {}),
    ...(raw.nextblockhash ? { nextHash: hex(raw.nextblockhash, 'next block hash') } : {}),
    version: optionalInteger(raw.version, 'block version'),
    nonce: optionalInteger(raw.nonce, 'block nonce'),
    ...(raw.bits ? { bits: hex(raw.bits, 'block bits', 8) } : {}),
    ...(raw.merkleroot ? { merkleRoot: hex(raw.merkleroot, 'merkle root') } : {}),
    ...(raw.chainwork ? { chainwork: hex(raw.chainwork, 'chain work') } : {}),
  };
}
