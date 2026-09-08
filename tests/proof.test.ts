import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import test from 'node:test';
import { decodeP2CProof } from '../src/server/proof.js';

// Small public TLS test certificate also used by ConnectCoin Core p2c_tests.cpp
// (PolarSSL test EC certificate). Synthetic handshakes below are not signed.
const CERTIFICATE = new X509Certificate(`-----BEGIN CERTIFICATE-----
MIICIDCCAaWgAwIBAgIBCTAKBggqhkjOPQQDAjA+MQswCQYDVQQGEwJOTDERMA8G
A1UECgwIUG9sYXJTU0wxHDAaBgNVBAMME1BvbGFyc3NsIFRlc3QgRUMgQ0EwHhcN
MjMwNTE3MDcxMDM2WhcNMzMwNTE0MDcxMDM2WjA0MQswCQYDVQQGEwJOTDERMA8G
A1UECgwIUG9sYXJTU0wxEjAQBgNVBAMMCWxvY2FsaG9zdDBZMBMGByqGSM49AgEG
CCqGSM49AwEHA0IABDfMVtl2CR5acj7HWS3/IG7ufPkGkXTQrRS192giWWKSTuUA
2CMR/+ov0jRdXRa9iojCa3cNVc2KKg76Aci07f+jgZ0wgZowCQYDVR0TBAIwADAd
BgNVHQ4EFgQUUGGlj9QH2deCAQzlZX+MY0anE74wbgYDVR0jBGcwZYAUnW0gJEkB
PyvLeLUZvH4kydv7NnyhQqRAMD4xCzAJBgNVBAYTAk5MMREwDwYDVQQKDAhQb2xh
clNTTDEcMBoGA1UEAwwTUG9sYXJzc2wgVGVzdCBFQyBDQYIJAMFD4n5iQ8zoMAoG
CCqGSM49BAMCA2kAMGYCMQDg6p7PPfr2+n7nGvya3pU4ust3k7Obk4/tZX+uHHRQ
qaccsyULeFNzkyRvWHFeT5sCMQCzDJX79Ii7hILYza/iXWJe/BjJEE8MteCRGXDN
06jC+BLgOH1KQV9ArqEh3AhOhEg=
-----END CERTIFICATE-----`).raw;
const TXID = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f';

function number(value: number, size: number): Buffer {
  const result = Buffer.alloc(size);
  result.writeUIntBE(value, 0, size);
  return result;
}
const concat = (...parts: Buffer[]) => Buffer.concat(parts);
const vector = (bytes: Buffer, size = 2) => concat(number(bytes.length, size), bytes);
const handshake = (type: number, body: Buffer) => concat(number(type, 1), vector(body, 3));
const extension = (type: number, body: Buffer) => concat(number(type, 2), vector(body));
function hash(tag: string, body: Buffer): Buffer {
  const tagHash = createHash('sha256').update(tag).digest();
  return createHash('sha256')
    .update(concat(tagHash, tagHash, body))
    .digest();
}
function challenge(index: number): Buffer {
  const inputIndex = Buffer.alloc(4);
  inputIndex.writeUInt32LE(index);
  return hash('ConnectCoin/P2C/claim/v1', concat(Buffer.from(TXID, 'hex').reverse(), inputIndex));
}

function fixture(
  options: {
    signature?: Buffer;
    certificate?: Buffer;
    count?: number;
    context?: Buffer;
    extraClientExtension?: Buffer;
    serverCipher?: number;
    certificateScheme?: number;
  } = {},
): Buffer[] {
  const domain = Buffer.from('localhost');
  const share = concat(number(0x001d, 2), vector(Buffer.alloc(32, 1)));
  const clientExtensions = concat(
    extension(0, vector(concat(number(0, 1), vector(domain)))),
    extension(43, vector(number(0x0304, 2), 1)),
    extension(13, vector(number(0x0403, 2))),
    extension(51, vector(share)),
    options.extraClientExtension ?? Buffer.alloc(0),
  );
  const client = concat(
    number(0x0303, 2),
    challenge(7),
    number(0, 1),
    vector(number(0x1301, 2)),
    Buffer.from([1, 0]),
    vector(clientExtensions),
  );
  const server = concat(
    number(0x0303, 2),
    Buffer.alloc(32, 3),
    number(0, 1),
    number(options.serverCipher ?? 0x1301, 2),
    number(0, 1),
    vector(concat(extension(43, number(0x0304, 2)), extension(51, share))),
  );
  const entry = concat(vector(options.certificate ?? CERTIFICATE, 3), number(0, 2));
  const certificates = concat(
    vector(options.context ?? Buffer.alloc(0), 1),
    vector(concat(...Array.from({ length: options.count ?? 1 }, () => entry)), 3),
  );
  const verify = concat(
    number(options.certificateScheme ?? 0x0403, 2),
    vector(options.signature ?? Buffer.from([0x30])),
  );
  return [
    handshake(1, client),
    handshake(2, server),
    handshake(8, Buffer.from([0, 0])),
    handshake(11, certificates),
    handshake(15, verify),
  ];
}
const proof = (messages = fixture()) => concat(Buffer.from([1]), ...messages);
const decode = (bytes: Buffer, target?: string) => decodeP2CProof(bytes.toString('hex'), TXID, 7, target);

test('decodes complete v1 profile and JSON-safe certificate display metadata', () => {
  const bytes = proof();
  const result = decode(bytes);
  assert.equal(result.version, 1);
  assert.equal(result.byteLength, bytes.length);
  assert.equal(result.domain, 'localhost');
  assert.equal(result.challengeMatches, true);
  assert.deepEqual(
    result.messages.map((message) => message.type),
    [1, 2, 8, 11, 15],
  );
  assert.equal(
    result.messages.reduce((size, message) => size + message.length, 1),
    bytes.length,
  );
  assert.match(result.certificates[0].subject, /CN=localhost/);
  assert.match(result.certificates[0].issuer, /Polarssl Test EC CA/);
  assert.equal(result.certificates[0].serialNumber, '09');
  assert.equal(result.certificates[0].fingerprint256, new X509Certificate(CERTIFICATE).fingerprint256);
  assert.equal(result.cipherSuite.code, 0x1301);
  assert.equal(result.signatureScheme.name, 'ecdsa_secp256r1_sha256');
  assert.equal('meetsTarget' in result, false);
  assert.match(result.validationScope, /Display checks only/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('work hash excludes version and compares target in uint256 display order including equality', () => {
  const bytes = proof();
  const expected = hash('ConnectCoin/P2C/work/v1', bytes.subarray(1)).reverse().toString('hex');
  assert.equal(decode(bytes).workHash, expected);
  assert.notEqual(decode(bytes).workHash, hash('ConnectCoin/P2C/work/v1', bytes).reverse().toString('hex'));
  assert.equal(decode(bytes, expected).meetsTarget, true);
  assert.equal(
    decode(bytes, (BigInt(`0x${expected}`) - 1n).toString(16).padStart(64, '0')).meetsTarget,
    false,
  );
  assert.equal(decode(bytes, 'f'.repeat(64)).meetsTarget, true);
  assert.equal(decode(bytes, '0'.repeat(64)).meetsTarget, false);
});

test('challenge binds the non-witness txid and little-endian input index without a witness hash cycle', () => {
  const first = decode(proof());
  const changedWitness = decode(proof(fixture({ signature: Buffer.from([0x30, 1]) })));
  assert.equal(first.expectedChallenge, challenge(7).toString('hex'));
  assert.equal(first.expectedChallenge, changedWitness.expectedChallenge);
  assert.notEqual(first.workHash, changedWitness.workHash);
  const changedIndex = decodeP2CProof(proof().toString('hex'), TXID, 8);
  const changedTxid = decodeP2CProof(proof().toString('hex'), '12'.repeat(32), 7);
  assert.equal(changedIndex.challengeMatches, false);
  assert.equal(changedTxid.challengeMatches, false);
  assert.notEqual(first.expectedChallenge, changedIndex.expectedChallenge);
  const wrongByteOrder = hash(
    'ConnectCoin/P2C/claim/v1',
    concat(Buffer.from(TXID, 'hex'), Buffer.from([7, 0, 0, 0])),
  );
  assert.notEqual(first.expectedChallenge, wrongByteOrder.toString('hex'));
});

test('rejects every truncated prefix and trailing bytes', () => {
  const bytes = proof();
  for (let size = 0; size < bytes.length; size++) assert.throws(() => decode(bytes.subarray(0, size)));
  assert.throws(() => decode(concat(bytes, Buffer.from([0]))), /Trailing bytes/);
});

test('rejects malformed proof encoding, version, IDs, indexes and targets', () => {
  for (const malformed of ['', '0', 'gg', '01 ff', '01\n']) {
    assert.throws(() => decodeP2CProof(malformed, TXID, 0), /P2C proof/);
  }
  const version = proof();
  version[0] = 2;
  assert.throws(() => decode(version), /version/);
  for (const index of [-1, 0.5, 0x100000000, NaN])
    assert.throws(() => decodeP2CProof(proof().toString('hex'), TXID, index), /index/);
  assert.throws(() => decodeP2CProof(proof().toString('hex'), 'aa', 0), /transaction ID/);
  assert.throws(() => decode(proof(), '0x01'), /target/);
});

test('rejects oversized proof, each oversized handshake and wrong message order', () => {
  assert.throws(() => decode(Buffer.alloc(64 * 1024 + 1)), /size/);
  const maxima = [4096, 2048, 4096, 48 * 1024, 8192];
  maxima.forEach((maximum, index) => {
    const messages = fixture();
    messages[index] = handshake(messages[index][0], Buffer.alloc(maximum - 3));
    assert.throws(() => decode(proof(messages)), /size limit/);
  });
  const messages = fixture();
  [messages[0], messages[1]] = [messages[1], messages[0]];
  assert.throws(() => decode(proof(messages)), /message order/);
});

test('rejects certificate limits, request context, malformed DER and trailing DER', () => {
  assert.throws(() => decode(proof(fixture({ count: 0 }))), /Certificate list length/);
  assert.throws(() => decode(proof(fixture({ count: 9 }))), /Too many certificates/);
  assert.throws(
    () => decode(proof(fixture({ certificate: Buffer.alloc(16 * 1024 + 1) }))),
    /certificate size/,
  );
  assert.throws(() => decode(proof(fixture({ context: Buffer.from([1]) }))), /request context/);
  assert.throws(() => decode(proof(fixture({ certificate: Buffer.from([0x30]) }))), /certificate DER/);
  assert.throws(
    () => decode(proof(fixture({ certificate: concat(CERTIFICATE, Buffer.from([0])) }))),
    /certificate bytes/,
  );
});

test('rejects duplicate and forbidden extensions, incompatible cipher and signature scheme', () => {
  assert.throws(
    () => decode(proof(fixture({ extraClientExtension: extension(43, Buffer.from([2, 3, 4])) }))),
    /Duplicate TLS extension/,
  );
  assert.throws(
    () => decode(proof(fixture({ extraClientExtension: extension(42, Buffer.alloc(0)) }))),
    /Forbidden/,
  );
  assert.throws(() => decode(proof(fixture({ serverCipher: 0x1302 }))), /cipher suite/);
  assert.throws(() => decode(proof(fixture({ certificateScheme: 0x0804 }))), /unoffered/);
});
