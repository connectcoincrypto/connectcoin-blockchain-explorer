import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { NETWORKS, PROTOCOL } from '../src/shared/networks.js';
import { MAINNET_GENESIS } from './fixtures/mainnet-genesis.js';

test('all genesis headers independently hash to the published Core block identifiers', () => {
  for (const network of ['main', 'testnet3', 'testnet4', 'signet', 'regtest'] as const) {
    const params = NETWORKS[network];
    assert.equal(params.launched, true);
    const genesis = params.genesis;
    assert.ok(genesis);
    const header = Buffer.alloc(80);
    header.writeInt32LE(genesis.version, 0);
    Buffer.from(genesis.merkleRoot, 'hex').reverse().copy(header, 36);
    header.writeUInt32LE(genesis.time, 68);
    header.writeUInt32LE(Number.parseInt(genesis.bits, 16), 72);
    header.writeUInt32LE(genesis.nonce, 76);
    const first = createHash('sha256').update(header).digest();
    const hash = createHash('sha256').update(first).digest().reverse().toString('hex');
    assert.equal(hash, genesis.hash, network);
    assert.equal(BigInt(genesis.rewardConnects), 10_000_000n * BigInt(PROTOCOL.connectsPerCoin));
    assert.equal(
      genesis.outputs.reduce((total, output) => total + BigInt(output.valueConnects), 0n),
      BigInt(genesis.rewardConnects),
    );
    for (const output of genesis.outputs) assert.match(output.publicKey, /^[0-9a-f]{64}$/);
    if (network === 'main') {
      assert.equal(header.toString('hex'), MAINNET_GENESIS.headerHex);
      assert.equal(genesis.outputs.length, 2);
      assert.equal(genesis.publicKey, undefined, 'mainnet has no single genesis allocation key');
    } else {
      assert.match(genesis.publicKey!, /^[0-9a-f]{64}$/);
      assert.deepEqual(genesis.outputs, [
        { valueConnects: genesis.rewardConnects, publicKey: genesis.publicKey },
      ]);
    }
  }
});

test('mainnet uses its launch identity and preserves both native P2PK allocations', () => {
  assert.equal(NETWORKS.main.launched, true);
  assert.equal(NETWORKS.main.testChain, false);
  assert.equal(NETWORKS.main.genesis?.hash, MAINNET_GENESIS.hash);
  assert.equal(NETWORKS.main.genesis?.merkleRoot, MAINNET_GENESIS.merkleRoot);
  assert.equal(NETWORKS.main.genesis?.bits, MAINNET_GENESIS.bits);
  assert.equal(NETWORKS.main.genesis?.time, MAINNET_GENESIS.time);
  assert.equal(NETWORKS.main.genesis?.nonce, MAINNET_GENESIS.nonce);
  assert.deepEqual(NETWORKS.main.genesis?.outputs, MAINNET_GENESIS.outputs);
  assert.equal(NETWORKS.main.rpcPort, 48172);
  assert.equal(NETWORKS.main.p2pPort, 48173);
  assert.equal(NETWORKS.main.bech32Hrp, 'cc');
  assert.equal(NETWORKS.main.defaultNetworkMagic, 'd951a5e2');
  assert.deepEqual(NETWORKS.main.dnsSeeds, [
    'connectcoin2.com',
    'connectcoin3.com',
    'connectcoin4.com',
    'dememzea.tplinkdns.com',
  ]);
  assert.notEqual(NETWORKS.main.genesis?.hash, NETWORKS.testnet4.genesis?.hash);
});

test('mainnet serialized coinbase independently commits to both allocation keys and amounts', () => {
  const coinbase = Buffer.from(MAINNET_GENESIS.coinbaseHex, 'hex');
  const txid = createHash('sha256')
    .update(createHash('sha256').update(coinbase).digest())
    .digest()
    .reverse()
    .toString('hex');
  assert.equal(txid, MAINNET_GENESIS.merkleRoot);
  assert.equal(txid, NETWORKS.main.genesis?.merkleRoot);
  assert.equal(coinbase.readUInt32LE(0), 1);
  assert.equal(coinbase[4], 1, 'one coinbase input');
  assert.equal(coinbase.subarray(5, 37).toString('hex'), '0'.repeat(64));
  assert.equal(coinbase.readUInt32LE(37), 0xffffffff);
  const scriptLength = coinbase[41];
  assert.equal(scriptLength, 86);
  let offset = 42 + scriptLength;
  assert.equal(coinbase.readUInt32LE(offset), 0xffffffff);
  offset += 4;
  assert.equal(coinbase[offset++], 2, 'two native typed outputs, not one aggregate allocation');
  for (const expected of NETWORKS.main.genesis!.outputs) {
    assert.equal(coinbase.readBigUInt64LE(offset).toString(), expected.valueConnects);
    offset += 8;
    assert.equal(coinbase[offset++], 1, 'pay-to-public-key output type');
    assert.equal(coinbase.subarray(offset, offset + 32).toString('hex'), expected.publicKey);
    offset += 32;
  }
  assert.equal(coinbase.readUInt32LE(offset), 0);
  assert.equal(offset + 4, coinbase.length);
});

test('testnet4 retains its reset identity after adding mainnet', () => {
  assert.equal(
    NETWORKS.testnet4.genesis?.hash,
    '710dc5910cbef40216bd82ccfb66af2273b2b1d336b034c5794966904cb603bf',
  );
  assert.notEqual(
    NETWORKS.testnet4.genesis?.hash,
    '06a1a1f822fed4a412aedb19315f1e85c963ad9b3c10e88ff12626b4b1389115',
  );
  assert.notEqual(
    NETWORKS.testnet4.genesis?.hash,
    '38cae555fb78f44c31e7d6859d0476252b321dae8b6312afefe0a45fc3fd112a',
  );
  assert.equal(NETWORKS.testnet4.defaultNetworkMagic, '77d66cbc');
  assert.equal(NETWORKS.testnet4.rpcPort, 48178);
  assert.equal(NETWORKS.testnet4.p2pPort, 48179);
  assert.equal(NETWORKS.testnet4.bech32Hrp, 'tcc');
});

test('every test-chain identity matches Core signature-mask reset values', () => {
  const identities = {
    testnet3: ['1025889d725c5d64c3ee38ab07d2de279ab57036a2482186c65806d6c0291787', 'c7291ff5'],
    testnet4: ['710dc5910cbef40216bd82ccfb66af2273b2b1d336b034c5794966904cb603bf', '77d66cbc'],
    signet: ['a694dccdc04a316a4f4fe496f311aff981392f25ea18e4b7f77d9f449b9089fc', '304c2f0c'],
    regtest: ['53c5145452f6957a2674ab904726afc2d7643c4a4fb9c2beab193ea983e500f0', '3af83be3'],
  } as const;
  for (const network of ['testnet3', 'testnet4', 'signet', 'regtest'] as const) {
    assert.equal(NETWORKS[network].genesis?.hash, identities[network][0]);
    assert.equal(NETWORKS[network].defaultNetworkMagic, identities[network][1]);
  }
});

test('network rules distinguish public test chains from local regtest parameters', () => {
  for (const network of ['main', 'testnet3', 'testnet4', 'signet'] as const) {
    const params = NETWORKS[network];
    assert.equal(params.targetSpacingSeconds, 10);
    assert.equal(params.subsidyHalvingInterval, 3_000_000);
    assert.equal(params.difficultyRetargetInterval, 8640);
    assert.equal(params.randomxEpochBlocks, 12_288);
    assert.equal(params.randomxEpochLag, 64);
  }
  assert.equal(NETWORKS.regtest.targetSpacingSeconds, 600);
  assert.equal(NETWORKS.regtest.subsidyHalvingInterval, 150);
  assert.equal(NETWORKS.regtest.difficultyRetargetInterval, 144);
  assert.equal(NETWORKS.regtest.randomxEpochBlocks, 0);
  assert.equal(NETWORKS.regtest.randomxEpochLag, 0);
  assert.equal(NETWORKS.regtest.bech32Hrp, 'ccrt');
});

test('protocol metadata preserves exact money and distinguishes proof version from root version', () => {
  assert.equal(PROTOCOL.revision, 'p2c-mask-v1-2026-09-09');
  assert.equal(PROTOCOL.p2cProofVersion, 2);
  assert.equal(PROTOCOL.p2cRootCertificatesVersion, 1);
  assert.equal(PROTOCOL.powAlgorithm, 'randomx-v2');
  assert.equal(PROTOCOL.ticker, 'CONN');
  assert.equal(PROTOCOL.decimals, 10);
  assert.equal(BigInt(PROTOCOL.connectsPerCoin), 10n ** BigInt(PROTOCOL.decimals));
  assert.equal(BigInt(PROTOCOL.initialBlockSubsidyConnects), 15n * BigInt(PROTOCOL.connectsPerCoin));
  assert.equal(BigInt(PROTOCOL.maxMoneyConnects), 100_000_000n * BigInt(PROTOCOL.connectsPerCoin));
  assert.equal(PROTOCOL.maxBlockWeight, 50_000_000);
  assert.equal(PROTOCOL.maxBlockSerializedBytes, 50_000_000);
  assert.equal(PROTOCOL.coinbaseMaturity, 100);
  assert.equal(PROTOCOL.maxP2CProofBytes, 65_536);
});
