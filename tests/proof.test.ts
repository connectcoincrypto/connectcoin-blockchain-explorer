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
    domain?: string;
    clientRandom?: Buffer;
    serverRandom?: Buffer;
    certificate?: Buffer;
    certificateExtensions?: Buffer;
    count?: number;
    context?: Buffer;
    extraClientExtension?: Buffer;
    encryptedExtensions?: Buffer;
    clientCiphers?: number[];
    clientSignatures?: number[];
    serverCipher?: number;
    certificateScheme?: number;
  } = {},
): Buffer[] {
  const domain = Buffer.from(options.domain ?? 'localhost');
  const share = concat(number(0x001d, 2), vector(Buffer.alloc(32, 1)));
  const clientExtensions = concat(
    extension(0, vector(concat(number(0, 1), vector(domain)))),
    extension(43, vector(number(0x0304, 2), 1)),
    extension(
      13,
      vector(concat(...(options.clientSignatures ?? [0x0403]).map((scheme) => number(scheme, 2)))),
    ),
    extension(51, vector(share)),
    options.extraClientExtension ?? Buffer.alloc(0),
  );
  const client = concat(
    number(0x0303, 2),
    options.clientRandom ?? challenge(7),
    number(0, 1),
    vector(concat(...(options.clientCiphers ?? [0x1301]).map((cipher) => number(cipher, 2)))),
    Buffer.from([1, 0]),
    vector(clientExtensions),
  );
  const server = concat(
    number(0x0303, 2),
    options.serverRandom ?? Buffer.alloc(32, 3),
    number(0, 1),
    number(options.serverCipher ?? 0x1301, 2),
    number(0, 1),
    vector(concat(extension(43, number(0x0304, 2)), extension(51, share))),
  );
  const entry = concat(
    vector(options.certificate ?? CERTIFICATE, 3),
    vector(options.certificateExtensions ?? Buffer.alloc(0)),
  );
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
    handshake(8, options.encryptedExtensions ?? Buffer.from([0, 0])),
    handshake(11, certificates),
    handshake(15, verify),
  ];
}
const proof = (messages = fixture()) => concat(Buffer.from([2]), ...messages);
const decode = (bytes: Buffer, target?: string) => decodeP2CProof(bytes.toString('hex'), TXID, 7, target);

test('decodes only the complete v2 profile and JSON-safe certificate display metadata', () => {
  const bytes = proof();
  const result = decode(bytes);
  assert.equal(result.version, 2);
  assert.equal(result.byteLength, bytes.length);
  assert.equal(result.domain, 'localhost');
  assert.equal(result.challengeMatches, true);
  assert.deepEqual(
    result.messages.map((message) => message.type),
    [1, 2, 8, 11, 15],
  );
  assert.deepEqual(
    result.messages.map((message) => message.includedInWorkHash),
    [true, true, true, true, false],
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
  assert.match(result.validationScope, /CertificateVerify is mandatory but its signature is not verified/);
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});

test('v2 hashes exactly four complete messages with the work/v2 tag and uint256 target ordering', () => {
  const messages = fixture();
  const bytes = proof(messages);
  // Build the reference from independently framed fixture messages, not from
  // offsets, lengths, hash helpers or any other data returned by the decoder.
  const transcript = concat(...messages.slice(0, 4));
  const expected = hash('ConnectCoin/P2C/work/v2', transcript).reverse().toString('hex');
  const result = decode(bytes);
  assert.equal(result.workHash, expected);
  assert.equal(result.workHashTag, 'ConnectCoin/P2C/work/v2');
  assert.equal(result.workPreimageByteLength, transcript.length);
  assert.equal(result.workPreimageByteLength + 1 + messages[4].length, bytes.length);
  assert.match(result.workHashScope, /including handshake headers/);
  assert.match(result.workHashScope, /entire CertificateVerify message are excluded/);
  assert.equal(result.transcriptHash, createHash('sha256').update(transcript).digest('hex'));
  assert.notEqual(result.workHash, hash('ConnectCoin/P2C/work/v1', transcript).reverse().toString('hex'));
  assert.notEqual(result.workHash, hash('ConnectCoin/P2C/work/v2', bytes).reverse().toString('hex'));
  assert.notEqual(
    result.workHash,
    hash('ConnectCoin/P2C/work/v2', bytes.subarray(1)).reverse().toString('hex'),
  );
  assert.notEqual(
    result.workHash,
    hash('ConnectCoin/P2C/work/v2', concat(...messages.slice(0, 4).map((message) => message.subarray(4))))
      .reverse()
      .toString('hex'),
  );
  assert.equal(decode(bytes, expected).meetsTarget, true);
  assert.equal(
    decode(bytes, (BigInt(`0x${expected}`) - 1n).toString(16).padStart(64, '0')).meetsTarget,
    false,
  );
  assert.equal(decode(bytes, 'f'.repeat(64)).meetsTarget, true);
  assert.equal(decode(bytes, '0'.repeat(64)).meetsTarget, false);
});

test('all CertificateVerify bytes are excluded from work, including scheme and length fields', () => {
  const clientSignatures = [0x0403, 0x0804, 0x0809];
  const first = decode(proof(fixture({ clientSignatures })));
  for (const certificateScheme of clientSignatures) {
    for (const signature of [Buffer.from([0x31]), Buffer.alloc(512, 0x30), Buffer.alloc(8184, 0x01)]) {
      // Structurally valid dummy signatures only; changing schemes does not
      // imply that the ECDSA fixture certificate could authenticate RSA-PSS.
      const result = decode(proof(fixture({ clientSignatures, certificateScheme, signature })));
      assert.equal(result.workHash, first.workHash);
      assert.equal(result.transcriptHash, first.transcriptHash);
      assert.equal(result.workPreimageByteLength, first.workPreimageByteLength);
      assert.equal(result.expectedChallenge, first.expectedChallenge);
      assert.equal(result.signatureScheme.code, certificateScheme);
    }
  }
});

test('each of the four messages authenticated by CertificateVerify affects v2 work', () => {
  const first = decode(proof());
  const changedMessages = [
    fixture({ domain: 'other.example' }), // ClientHello
    fixture({ serverRandom: Buffer.alloc(32, 4) }), // ServerHello
    fixture({ encryptedExtensions: vector(extension(16, Buffer.from([0, 0]))) }),
    fixture({ certificateExtensions: Buffer.from([0]) }), // Certificate entry's opaque extensions
  ];
  for (const messages of changedMessages) {
    const changed = decode(proof(messages));
    assert.notEqual(changed.workHash, first.workHash);
    assert.notEqual(changed.transcriptHash, first.transcriptHash);
    assert.equal(changed.expectedChallenge, first.expectedChallenge);
  }
  // No cryptographic claim is made about these unchanged dummy signatures.
  assert.match(first.validationScope, /consensus validity are not verified/);
});

test('challenge binds the non-witness txid and little-endian input index without a witness hash cycle', () => {
  const first = decode(proof());
  const changedWitness = decode(proof(fixture({ signature: Buffer.from([0x30, 1]) })));
  assert.equal(first.expectedChallenge, challenge(7).toString('hex'));
  assert.equal(first.expectedChallenge, changedWitness.expectedChallenge);
  assert.equal(first.workHash, changedWitness.workHash);
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
  const changedRandom = decode(proof(fixture({ clientRandom: Buffer.alloc(32) })));
  assert.equal(changedRandom.challengeMatches, false);
  assert.notEqual(changedRandom.workHash, first.workHash);
});

test('rejects every truncated prefix and trailing bytes', () => {
  const bytes = proof();
  for (let size = 0; size < bytes.length; size++) assert.throws(() => decode(bytes.subarray(0, size)));
  assert.throws(() => decode(concat(bytes, Buffer.from([0]))), /Trailing bytes/);
});

test('rejects v1 and all other proof versions, even with a complete valid v2 transcript', () => {
  for (let version = 0; version <= 255; version++) {
    if (version === 2) continue;
    const bytes = proof();
    bytes[0] = version;
    assert.throws(() => decode(bytes), /Unsupported P2C proof version: only v2 is supported/);
  }
});

test('rejects malformed proof encoding, IDs, indexes and targets', () => {
  for (const malformed of ['', '0', 'gg', '02 ff', '02\n']) {
    assert.throws(() => decodeP2CProof(malformed, TXID, 0), /P2C proof/);
  }
  for (const index of [-1, 0.5, 0x100000000, NaN])
    assert.throws(() => decodeP2CProof(proof().toString('hex'), TXID, index), /index/);
  assert.throws(() => decodeP2CProof(proof().toString('hex'), 'aa', 0), /transaction ID/);
  assert.throws(() => decodeP2CProof(proof().toString('hex'), `${TXID}\n`, 0), /transaction ID/);
  assert.throws(() => decode(proof(), '0x01'), /target/);
  assert.throws(() => decode(proof(), `${'a'.repeat(64)}\n`), /target/);
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
  for (const type of [27, 41, 42, 44, 45, 0xfe0d])
    assert.throws(
      () => decode(proof(fixture({ extraClientExtension: extension(type, Buffer.alloc(0)) }))),
      /Forbidden/,
    );
  assert.throws(() => decode(proof(fixture({ serverCipher: 0x1302 }))), /cipher suite/);
  assert.throws(() => decode(proof(fixture({ serverCipher: 0x1303 }))), /unoffered/);
  assert.throws(() => decode(proof(fixture({ certificateScheme: 0x0804 }))), /unoffered/);
  assert.throws(
    () => decode(proof(fixture({ encryptedExtensions: vector(extension(42, Buffer.alloc(0))) }))),
    /early_data is forbidden in P2C v2/,
  );
  assert.throws(
    () =>
      decode(
        proof(
          fixture({
            serverRandom: Buffer.from(
              'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c',
              'hex',
            ),
          }),
        ),
      ),
    /HelloRetryRequest is forbidden in P2C v2/,
  );
});

test('accepts all three offered signature schemes and both SHA-256 cipher suites for display', () => {
  const schemes = new Map([
    [0x0403, 'ecdsa_secp256r1_sha256'],
    [0x0804, 'rsa_pss_rsae_sha256'],
    [0x0809, 'rsa_pss_pss_sha256'],
  ]);
  for (const [certificateScheme, name] of schemes) {
    for (const serverCipher of [0x1301, 0x1303]) {
      const result = decode(
        proof(
          fixture({
            certificateScheme,
            clientSignatures: [certificateScheme],
            clientCiphers: [serverCipher],
            serverCipher,
          }),
        ),
      );
      assert.deepEqual(result.signatureScheme, { code: certificateScheme, name });
      assert.equal(result.cipherSuite.code, serverCipher);
    }
  }
  for (const certificateScheme of [0x0401, 0x0503, 0x0805, 0x0807])
    assert.throws(
      () => decode(proof(fixture({ certificateScheme, clientSignatures: [certificateScheme] }))),
      /Unsupported.*signature scheme/,
    );
});

test('excluded CertificateVerify remains mandatory and strictly framed', () => {
  assert.throws(() => decode(proof(fixture().slice(0, 4))), /Truncated/);
  assert.throws(() => decode(proof(fixture({ signature: Buffer.alloc(0) }))), /Empty CertificateVerify/);
  for (const body of [
    Buffer.from([0x04]), // Truncated scheme
    Buffer.from([0x04, 0x03, 0x00]), // Truncated length
    Buffer.from([0x04, 0x03, 0x00, 0x02, 0x30]), // Signature shorter than declared
    Buffer.from([0x04, 0x03, 0x00, 0x01, 0x30, 0x00]), // Trailing bytes
  ]) {
    const messages = fixture();
    messages[4] = handshake(15, body);
    assert.throws(() => decode(proof(messages)), /Truncated|Trailing/);
  }
  const malformed = fixture();
  malformed[4] = Buffer.from([15, 0xff, 0xff, 0xff]);
  assert.throws(() => decode(proof(malformed)), /size limit/);
  assert.throws(() => decode(proof([...fixture(), handshake(20, Buffer.alloc(32))])), /Trailing bytes/);
});
