import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { NETWORKS, PROTOCOL } from '../src/shared/networks.js';

test('P2C v2 test-chain genesis metadata hashes to the published Core block identifiers', () => {
  for (const network of ['testnet3', 'testnet4', 'signet', 'regtest'] as const) {
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
    assert.match(genesis.publicKey, /^[0-9a-f]{64}$/);
  }
});

test('mainnet has no operational genesis and testnet4 uses the reset identity', () => {
  assert.equal(NETWORKS.main.launched, false);
  assert.equal(NETWORKS.main.genesis, null);
  assert.equal(NETWORKS.main.testChain, false);
  assert.equal(
    NETWORKS.testnet4.genesis?.hash,
    '38cae555fb78f44c31e7d6859d0476252b321dae8b6312afefe0a45fc3fd112a',
  );
  assert.notEqual(
    NETWORKS.testnet4.genesis?.hash,
    '06a1a1f822fed4a412aedb19315f1e85c963ad9b3c10e88ff12626b4b1389115',
  );
  assert.equal(NETWORKS.testnet4.defaultNetworkMagic, '4e3d8178');
  assert.equal(NETWORKS.testnet4.rpcPort, 48178);
  assert.equal(NETWORKS.testnet4.p2pPort, 48179);
  assert.equal(NETWORKS.testnet4.bech32Hrp, 'tcc');
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
  assert.equal(PROTOCOL.p2cProofVersion, 2);
  assert.equal(PROTOCOL.p2cRootCertificatesVersion, 1);
  assert.equal(PROTOCOL.powAlgorithm, 'randomx-v2');
  assert.equal(PROTOCOL.decimals, 10);
  assert.equal(BigInt(PROTOCOL.connectsPerCoin), 10n ** BigInt(PROTOCOL.decimals));
  assert.equal(BigInt(PROTOCOL.initialBlockSubsidyConnects), 15n * BigInt(PROTOCOL.connectsPerCoin));
  assert.equal(BigInt(PROTOCOL.maxMoneyConnects), 100_000_000n * BigInt(PROTOCOL.connectsPerCoin));
  assert.equal(PROTOCOL.maxBlockWeight, 50_000_000);
  assert.equal(PROTOCOL.maxBlockSerializedBytes, 50_000_000);
  assert.equal(PROTOCOL.coinbaseMaturity, 100);
  assert.equal(PROTOCOL.maxP2CProofBytes, 65_536);
});
