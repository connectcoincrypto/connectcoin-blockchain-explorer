import type { Network } from './types.js';

// Consensus defaults from ConnectCoin Core 88360e0e5d (mainnet launch 2026-10-01;
// test chains retain the P2C mask v1 reset of 2026-09-09):
// src/kernel/chainparams.cpp, src/chainparamsbase.cpp, src/consensus/{amount,consensus,p2c}.h.
// The required output signature mask is layout v1; TLS proofs remain version 2 only.
// Runtime chain height, difficulty, peer counts and balances must still come from RPC.
export const PROTOCOL = {
  revision: 'p2c-mask-v1-2026-09-09',
  p2cProofVersion: 2,
  p2cRootCertificatesVersion: 1,
  maxP2CProofBytes: 64 * 1024,
  maxP2CCertificateMessageBytes: 48 * 1024,
  maxP2CCertificates: 8,
  maxP2CCertificateBytes: 16 * 1024,
  powAlgorithm: 'randomx-v2',
  ticker: 'CONN',
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

export interface GenesisAllocation {
  readonly valueConnects: string;
  readonly publicKey: string;
}

export interface GenesisParameters {
  readonly hash: string;
  readonly merkleRoot: string;
  readonly version: number;
  readonly time: number;
  readonly nonce: number;
  readonly bits: string;
  readonly rewardConnects: string;
  // Legacy single-output field; absent for the two-output mainnet genesis.
  readonly publicKey?: string;
  readonly outputs: readonly GenesisAllocation[];
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

function singleOutputGenesis(
  parameters: Omit<GenesisParameters, 'outputs'> & { readonly publicKey: string },
): GenesisParameters {
  return {
    ...parameters,
    outputs: [{ valueConnects: parameters.rewardConnects, publicKey: parameters.publicKey }],
  };
}

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
    launched: true,
    genesis: {
      version: 1,
      hash: '30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e',
      merkleRoot: '2ff1604a1a6ed04110972a78c808d7b967f8f3d6ee754fcf33bded563edc2c8c',
      time: 1790872995,
      nonce: 215364,
      bits: '1e333300',
      rewardConnects: '100000000000000000',
      outputs: [
        {
          valueConnects: '50000000000000000',
          publicKey: '29a6b41260ed25e3019d18236192afecec9ea0b7312837bacf81a3c40d7b2034',
        },
        {
          valueConnects: '50000000000000000',
          publicKey: '2c83a568529b55cc93e2d20754f079f6072d77ac88266d9b054cb3e0e92a7845',
        },
      ],
    },
    defaultNetworkMagic: 'd951a5e2',
    dnsSeeds: ['connectcoin2.com', 'connectcoin3.com', 'connectcoin4.com', 'dememzea.tplinkdns.com'],
  },
  testnet3: {
    ...publicTestDefaults,
    chain: 'test',
    rpcPort: 48175,
    p2pPort: 48176,
    directory: 'testnet3',
    genesis: singleOutputGenesis({
      ...genesisDefaults,
      hash: '1025889d725c5d64c3ee38ab07d2de279ab57036a2482186c65806d6c0291787',
      merkleRoot: '2e2e1a9fdad577fc8832a2e582f0149de3ab2032764a978c7e469b18f1c4099e',
      time: 1788912000,
      nonce: 66621,
    }),
    defaultNetworkMagic: 'c7291ff5',
  },
  testnet4: {
    ...publicTestDefaults,
    chain: 'testnet4',
    rpcPort: 48178,
    p2pPort: 48179,
    directory: 'testnet4',
    genesis: singleOutputGenesis({
      ...genesisDefaults,
      hash: '710dc5910cbef40216bd82ccfb66af2273b2b1d336b034c5794966904cb603bf',
      merkleRoot: 'e09a12d2aca740a06be984897fa268d4f03317c2363748d4ab69768ed92ca555',
      publicKey: '2ef316afd6177619f68ecfc6521fc3fcbf7faa2b25273f6ddea7971fae0de144',
      time: 1788912001,
      nonce: 913,
    }),
    defaultNetworkMagic: '77d66cbc',
    dnsSeeds: ['connectcoin1.com'],
  },
  signet: {
    ...publicTestDefaults,
    chain: 'signet',
    title: 'ConnectCoin Signet Explorer',
    rpcPort: 48181,
    p2pPort: 48182,
    directory: 'signet',
    genesis: singleOutputGenesis({
      ...genesisDefaults,
      hash: 'a694dccdc04a316a4f4fe496f311aff981392f25ea18e4b7f77d9f449b9089fc',
      merkleRoot: 'e9b9c33924f02701bc84751dc4701a1eef9b5c865fdc030b34843ed45db74dbf',
      time: 1788912002,
      nonce: 2069,
    }),
    defaultNetworkMagic: '304c2f0c',
  },
  regtest: {
    ...publicTestDefaults,
    chain: 'regtest',
    title: 'ConnectCoin Regtest Explorer',
    rpcPort: 48184,
    p2pPort: 48185,
    directory: 'regtest',
    bech32Hrp: 'ccrt',
    genesis: singleOutputGenesis({
      ...genesisDefaults,
      hash: '53c5145452f6957a2674ab904726afc2d7643c4a4fb9c2beab193ea983e500f0',
      merkleRoot: '9fee3081f6d76758b63691d412ce44408c471b02d0e5ae443aa5adf3a7345c9e',
      publicKey: '738a50e0af6185956d5e0c393859830eb70ea92351b19facbd47259cd7a10c27',
      time: 1296688602,
      nonce: 20,
      bits: '207fffff',
    }),
    targetSpacingSeconds: 600,
    subsidyHalvingInterval: 150,
    difficultyRetargetInterval: 144,
    randomxEpochBlocks: 0,
    randomxEpochLag: 0,
    defaultNetworkMagic: '3af83be3',
    dnsSeeds: ['dummySeed.invalid.'],
  },
};
