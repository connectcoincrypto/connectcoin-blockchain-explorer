import type { Network } from './types.js';

// Consensus defaults from ConnectCoin Core's P2C v2 reset (2026-09-09):
// src/kernel/chainparams.cpp, src/chainparamsbase.cpp, src/consensus/{amount,consensus,p2c}.h.
// Runtime chain height, difficulty, peer counts and balances must still come from RPC.
export const PROTOCOL = {
  revision: 'p2c-v2-2026-09-09',
  p2cProofVersion: 2,
  p2cRootCertificatesVersion: 1,
  maxP2CProofBytes: 64 * 1024,
  maxP2CCertificateMessageBytes: 48 * 1024,
  maxP2CCertificates: 8,
  maxP2CCertificateBytes: 16 * 1024,
  powAlgorithm: 'randomx-v2',
  ticker: 'CC',
  atomicUnit: 'connect',
  decimals: 10,
  connectsPerCoin: '10000000000',
  // MAX_MONEY is a validation bound, not a claim about circulating/total supply.
  maxMoneyConnects: '1000000000000000000',
  initialBlockSubsidyConnects: '150000000000',
  blockSubsidyPenaltyDivisor: 10,
  maxBlockWeight: 50_000_000,
  maxBlockSerializedBytes: 50_000_000,
  coinbaseMaturity: 100,
} as const;

export interface GenesisParameters {
  readonly hash: string;
  readonly merkleRoot: string;
  readonly version: number;
  readonly time: number;
  readonly nonce: number;
  readonly bits: string;
  readonly rewardConnects: string;
  readonly publicKey: string;
}

export interface NetworkParameters {
  readonly chain: string;
  readonly title: string;
  readonly rpcPort: number;
  readonly p2pPort: number;
  readonly directory: string;
  readonly bech32Hrp: string;
  readonly testChain: boolean;
  readonly launched: boolean;
  readonly genesis: GenesisParameters | null;
  readonly targetSpacingSeconds: number;
  readonly subsidyHalvingInterval: number;
  readonly difficultyRetargetInterval: number;
  readonly randomxEpochBlocks: number;
  readonly randomxEpochLag: number;
  // Signet's message start changes with a custom challenge; this is the default profile.
  readonly defaultNetworkMagic: string;
  readonly dnsSeeds: readonly string[];
}

const publicTestDefaults = {
  title: 'ConnectCoin Testnet Explorer',
  bech32Hrp: 'tcc',
  testChain: true,
  launched: true,
  targetSpacingSeconds: 10,
  subsidyHalvingInterval: 3_000_000,
  difficultyRetargetInterval: 8640,
  randomxEpochBlocks: 12_288,
  randomxEpochLag: 64,
  dnsSeeds: [],
} as const;

const genesisDefaults = {
  version: 1,
  bits: '1f00ffff',
  rewardConnects: '100000000000000000',
  publicKey: 'da12a44d69673e42ba95ac1d2bd4e5c76c3709a1765edbc5f52b8e5e643b0609',
} as const;

export const NETWORKS: Readonly<Record<Network, NetworkParameters>> = {
  main: {
    ...publicTestDefaults,
    chain: 'main',
    title: 'ConnectCoin Explorer',
    rpcPort: 48172,
    p2pPort: 48173,
    directory: '',
    bech32Hrp: 'cc',
    testChain: false,
    launched: false,
    // A zero hash in Core's utility output means no operational genesis, not block zero.
    genesis: null,
    defaultNetworkMagic: 'd951a5e2',
  },
  testnet3: {
    ...publicTestDefaults,
    chain: 'test',
    rpcPort: 48175,
    p2pPort: 48176,
    directory: 'testnet3',
    genesis: {
      ...genesisDefaults,
      hash: 'ca89051d3a1bcf96be2ed4943d347687af47b6fd0a155fc2b15ddcc103bd75af',
      merkleRoot: '3477a829a66de337c0b0db26685a1f6294287f4e9655bd892245d85e3d51ee6d',
      time: 1788912000,
      nonce: 38388,
    },
    defaultNetworkMagic: '0db1484d',
  },
  testnet4: {
    ...publicTestDefaults,
    chain: 'testnet4',
    rpcPort: 48178,
    p2pPort: 48179,
    directory: 'testnet4',
    genesis: {
      ...genesisDefaults,
      hash: '38cae555fb78f44c31e7d6859d0476252b321dae8b6312afefe0a45fc3fd112a',
      merkleRoot: 'e70bc6f9408b4997f2b8f4f227bddd122282ceb4cc5b58d326081ee411441d4e',
      publicKey: '2ef316afd6177619f68ecfc6521fc3fcbf7faa2b25273f6ddea7971fae0de144',
      time: 1788912001,
      nonce: 199567,
    },
    defaultNetworkMagic: '4e3d8178',
    dnsSeeds: ['connectcoin1.com', 'connectcoin2.com', 'connectcoin3.com', 'dememzea.tplinkdns.com'],
  },
  signet: {
    ...publicTestDefaults,
    chain: 'signet',
    title: 'ConnectCoin Signet Explorer',
    rpcPort: 48181,
    p2pPort: 48182,
    directory: 'signet',
    genesis: {
      ...genesisDefaults,
      hash: '2a62fd84425bc1f6dce0343ec3f6c08b782d76df54d52e5e3b8153f5d27d94b4',
      merkleRoot: '374929cb89e0db3685b45adde158b63ccb00be549aeaa8f7b8eeda01b51c23d0',
      time: 1788912002,
      nonce: 27113,
    },
    defaultNetworkMagic: '4c48f3b3',
  },
  regtest: {
    ...publicTestDefaults,
    chain: 'regtest',
    title: 'ConnectCoin Regtest Explorer',
    rpcPort: 48184,
    p2pPort: 48185,
    directory: 'regtest',
    bech32Hrp: 'ccrt',
    genesis: {
      ...genesisDefaults,
      hash: 'de48ff31cbff58a91ef359100fef13e6472f165e6f0410e52efcdacb1861f65a',
      merkleRoot: 'a26cc36202eb5e29223338940ab72e985db833ef1c14340fce37bfded3e0f595',
      publicKey: '738a50e0af6185956d5e0c393859830eb70ea92351b19facbd47259cd7a10c27',
      time: 1296688602,
      nonce: 26,
      bits: '207fffff',
    },
    targetSpacingSeconds: 600,
    subsidyHalvingInterval: 150,
    difficultyRetargetInterval: 144,
    randomxEpochBlocks: 0,
    randomxEpochLag: 0,
    defaultNetworkMagic: '8d6e0191',
    dnsSeeds: ['dummySeed.invalid.'],
  },
};
