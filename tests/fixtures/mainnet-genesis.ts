// Public launch fixture from ConnectCoin Core d170c5803f,
// contrib/devtools/mainnet-genesis.json. Independent of the explorer catalog.
export const MAINNET_GENESIS = {
  hash: '30a3a7543f593b6343873a16aeb61005dce0fe3f4169ab34039316b2a9bb373e',
  merkleRoot: '2ff1604a1a6ed04110972a78c808d7b967f8f3d6ee754fcf33bded563edc2c8c',
  time: 1790872995,
  nonce: 215364,
  bits: '1e333300',
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
  headerHex:
    '0100000000000000000000000000000000000000000000000000000000000000000000008c2cdc3e56edbd33cf4f75eed6f3f867b9d708c8782a971041d06e1a4a60f12fa38dbe6a0033331e44490300',
  coinbaseHex:
    '01000000010000000000000000000000000000000000000000000000000000000000000000ffffffff5604ffff001d01044c4d436c6f7564666c6172652030312f4f63742f3230323620537570706f727420666f72206d6f6465726e2063727970746f6772617068696320616c676f726974686d7320696e20576f726b657273ffffffff020000c52ebca2b1000129a6b41260ed25e3019d18236192afecec9ea0b7312837bacf81a3c40d7b20340000c52ebca2b100012c83a568529b55cc93e2d20754f079f6072d77ac88266d9b054cb3e0e92a784500000000',
} as const;

export function mainnetGenesisBlock() {
  const coinbase = Buffer.from(MAINNET_GENESIS.coinbaseHex, 'hex');
  const size = 80 + 1 + coinbase.length;
  return {
    height: '0',
    hash: MAINNET_GENESIS.hash,
    time: String(MAINNET_GENESIS.time),
    nTx: '1',
    size: String(size),
    weight: String(size * 4),
    difficulty: '0.0000762939453125',
    version: '1',
    nonce: String(MAINNET_GENESIS.nonce),
    bits: MAINNET_GENESIS.bits,
    merkleroot: MAINNET_GENESIS.merkleRoot,
    tx: [
      {
        txid: MAINNET_GENESIS.merkleRoot,
        hash: MAINNET_GENESIS.merkleRoot,
        version: '1',
        locktime: '0',
        size: String(coinbase.length),
        vsize: String(coinbase.length),
        weight: String(coinbase.length * 4),
        vin: [{ coinbase: coinbase.subarray(42, 42 + coinbase[41]).toString('hex'), sequence: '4294967295' }],
        vout: MAINNET_GENESIS.outputs.map((output, n) => ({
          n: String(n),
          type: '1',
          value: '5000000.0000000000',
          pubkey: output.publicKey,
        })),
      },
    ],
  };
}
