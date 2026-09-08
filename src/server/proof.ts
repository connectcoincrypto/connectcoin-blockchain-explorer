import { createHash, X509Certificate } from 'node:crypto';

export interface DecodedP2CProof {
  version: number;
  byteLength: number;
  domain: string;
  challenge: string;
  expectedChallenge: string;
  challengeMatches: boolean;
  workHash: string;
  meetsTarget?: boolean;
  messages: { name: string; type: number; length: number }[];
  certificates: {
    subject: string;
    issuer: string;
    validFrom: string;
    validTo: string;
    fingerprint256: string;
    subjectAltName: string;
    serialNumber: string;
  }[];
  cipherSuite: { code: number; name: string };
  signatureScheme: { code: number; name: string };
  rawHex: string;
  validationScope: string;
}

const MESSAGE_PROFILE = [
  { type: 1, name: 'ClientHello', maximum: 4096 },
  { type: 2, name: 'ServerHello', maximum: 2048 },
  { type: 8, name: 'EncryptedExtensions', maximum: 4096 },
  { type: 11, name: 'Certificate', maximum: 48 * 1024 },
  { type: 15, name: 'CertificateVerify', maximum: 8192 },
] as const;
const CIPHERS: Record<number, string> = {
  0x1301: 'TLS_AES_128_GCM_SHA256',
  0x1303: 'TLS_CHACHA20_POLY1305_SHA256',
};
const SIGNATURES: Record<number, string> = {
  0x0403: 'ecdsa_secp256r1_sha256',
  0x0804: 'rsa_pss_rsae_sha256',
  0x0809: 'rsa_pss_pss_sha256',
};
const HELLO_RETRY_RANDOM = 'cf21ad74e59a6111be1d8c021e65b891c2a211167abb8c5e079e09e2c8a8339c';

function requireCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class Reader {
  private offset = 0;
  constructor(
    private readonly bytes: Buffer,
    private readonly context: string,
  ) {}
  get remaining(): number {
    return this.bytes.length - this.offset;
  }
  read(size: number): Buffer {
    requireCondition(size <= this.remaining, `Truncated ${this.context}`);
    const value = this.bytes.subarray(this.offset, this.offset + size);
    this.offset += size;
    return value;
  }
  u8(): number {
    return this.read(1)[0];
  }
  u16(): number {
    return this.read(2).readUInt16BE();
  }
  u24(): number {
    return this.read(3).readUIntBE(0, 3);
  }
  end(): void {
    requireCondition(this.remaining === 0, `Trailing bytes in ${this.context}`);
  }
}

function taggedHash(tag: string, bytes: Buffer): Buffer {
  const tagHash = createHash('sha256').update(tag, 'utf8').digest();
  return createHash('sha256').update(tagHash).update(tagHash).update(bytes).digest();
}

function extensions(reader: Reader): Map<number, Buffer> {
  const size = reader.u16();
  requireCondition(size === reader.remaining, 'Invalid TLS extensions length');
  const result = new Map<number, Buffer>();
  while (reader.remaining) {
    const type = reader.u16();
    const data = reader.read(reader.u16());
    requireCondition(!result.has(type), 'Duplicate TLS extension');
    result.set(type, data);
  }
  return result;
}

function requiredExtension(items: Map<number, Buffer>, type: number, name: string): Buffer {
  const value = items.get(type);
  requireCondition(value, `Missing TLS ${name} extension`);
  return value;
}

function u16List(reader: Reader, size: number): number[] {
  requireCondition(size >= 2 && size % 2 === 0, 'Invalid TLS integer list length');
  const list = new Reader(reader.read(size), 'TLS integer list');
  const result: number[] = [];
  while (list.remaining) result.push(list.u16());
  return result;
}

function keyShare(reader: Reader): number {
  const group = reader.u16();
  const exchange = reader.read(reader.u16());
  requireCondition(
    (group === 0x001d && exchange.length === 32) ||
      (group === 0x0017 && exchange.length === 65 && exchange[0] === 4),
    'Invalid P2C TLS key share',
  );
  return group;
}

function clientHello(body: Buffer) {
  const reader = new Reader(body, 'ClientHello');
  requireCondition(reader.u16() === 0x0303, 'Invalid ClientHello legacy TLS version');
  const challenge = reader.read(32).toString('hex');
  const sessionSize = reader.u8();
  requireCondition(sessionSize <= 32, 'Invalid ClientHello session ID length');
  const session = reader.read(sessionSize);
  const ciphers = u16List(reader, reader.u16());
  requireCondition(reader.u8() === 1 && reader.u8() === 0, 'Invalid ClientHello compression');
  const items = extensions(reader);
  for (const type of [27, 41, 42, 44, 45, 0xfe0d]) {
    requireCondition(!items.has(type), 'Forbidden P2C ClientHello extension');
  }

  const sni = new Reader(requiredExtension(items, 0, 'server_name'), 'TLS server_name');
  requireCondition(sni.u16() === sni.remaining && sni.u8() === 0, 'Invalid TLS server_name list');
  const domain = sni.read(sni.u16()).toString('utf8');
  sni.end();
  // Match the Core's canonical LDH-label parser, including single-label names.
  requireCondition(
    domain.length > 0 &&
      domain.length <= 253 &&
      domain
        .split('.')
        .every((label) => label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)),
    'Noncanonical P2C server_name',
  );

  const versions = new Reader(requiredExtension(items, 43, 'supported_versions'), 'supported_versions');
  const offeredVersions = u16List(versions, versions.u8());
  versions.end();
  requireCondition(offeredVersions.includes(0x0304), 'ClientHello does not offer TLS 1.3');

  const algorithms = new Reader(requiredExtension(items, 13, 'signature_algorithms'), 'signature_algorithms');
  const signatures = u16List(algorithms, algorithms.u16());
  algorithms.end();

  const shares = new Reader(requiredExtension(items, 51, 'key_share'), 'ClientHello key_share');
  const sharesSize = shares.u16();
  requireCondition(sharesSize > 0 && sharesSize === shares.remaining, 'Invalid ClientHello key_share length');
  const groups: number[] = [];
  while (shares.remaining) {
    const group = keyShare(shares);
    requireCondition(!groups.includes(group), 'Duplicate ClientHello key share');
    groups.push(group);
  }
  return { challenge, domain, ciphers, signatures, groups, session };
}

function serverHello(body: Buffer, client: ReturnType<typeof clientHello>): number {
  const reader = new Reader(body, 'ServerHello');
  requireCondition(reader.u16() === 0x0303, 'Invalid ServerHello legacy TLS version');
  requireCondition(
    reader.read(32).toString('hex') !== HELLO_RETRY_RANDOM,
    'HelloRetryRequest is forbidden in P2C v1',
  );
  const sessionSize = reader.u8();
  requireCondition(
    sessionSize <= 32 && reader.read(sessionSize).equals(client.session),
    'ServerHello session ID mismatch',
  );
  const cipher = reader.u16();
  requireCondition(
    CIPHERS[cipher] && client.ciphers.includes(cipher),
    'Unsupported or unoffered ServerHello cipher suite',
  );
  requireCondition(reader.u8() === 0, 'Invalid ServerHello compression');
  const items = extensions(reader);
  requireCondition(items.size === 2, 'ServerHello must contain only supported_versions and key_share');
  requireCondition(
    requiredExtension(items, 43, 'supported_versions').equals(Buffer.from([3, 4])),
    'ServerHello did not select TLS 1.3',
  );
  const shares = new Reader(requiredExtension(items, 51, 'key_share'), 'ServerHello key_share');
  requireCondition(client.groups.includes(keyShare(shares)), 'Unoffered ServerHello key share');
  shares.end();
  return cipher;
}

function certificateChain(body: Buffer): DecodedP2CProof['certificates'] {
  const reader = new Reader(body, 'Certificate');
  requireCondition(reader.u8() === 0, 'P2C Certificate request context must be empty');
  const listSize = reader.u24();
  requireCondition(listSize > 0 && listSize === reader.remaining, 'Invalid Certificate list length');
  const result: DecodedP2CProof['certificates'] = [];
  while (reader.remaining) {
    requireCondition(result.length < 8, 'Too many certificates in P2C proof');
    const size = reader.u24();
    requireCondition(size > 0 && size <= 16 * 1024, 'Invalid P2C certificate size');
    const encoded = reader.read(size);
    reader.read(reader.u16()); // Opaque per-certificate extensions, as in the Core parser.
    let certificate: X509Certificate;
    try {
      certificate = new X509Certificate(encoded);
    } catch {
      throw new Error('Invalid X.509 certificate DER in P2C proof');
    }
    requireCondition(certificate.raw.equals(encoded), 'Trailing or non-DER certificate bytes in P2C proof');
    result.push({
      subject: certificate.subject,
      issuer: certificate.issuer,
      validFrom: certificate.validFrom,
      validTo: certificate.validTo,
      fingerprint256: certificate.fingerprint256,
      subjectAltName: certificate.subjectAltName ?? '',
      serialNumber: certificate.serialNumber,
    });
  }
  return result;
}

/**
 * Decode witness data for display, not as a consensus validator. These checks
 * cover framing, the v1 TLS profile, challenge binding and optional work target.
 * They do not verify CertificateVerify, trust roots, certificate validity at
 * median time past, domain binding to the spent output or transaction validity.
 * The supplied txid must be the non-witness transaction ID in RPC display order.
 */
export function decodeP2CProof(
  proofHex: string,
  txid: string,
  inputIndex: number,
  target?: string,
): DecodedP2CProof {
  requireCondition(
    typeof proofHex === 'string' && proofHex.length > 0 && proofHex.length <= 64 * 1024 * 2,
    'Invalid P2C proof size (maximum 64 KiB)',
  );
  requireCondition(
    proofHex.length % 2 === 0 && /^[0-9a-f]+$/i.test(proofHex),
    'Invalid P2C proof hexadecimal encoding',
  );
  requireCondition(
    typeof txid === 'string' && /^[0-9a-f]{64}$/i.test(txid),
    'Invalid non-witness transaction ID',
  );
  requireCondition(
    Number.isInteger(inputIndex) && inputIndex >= 0 && inputIndex <= 0xffffffff,
    'Invalid P2C input index',
  );
  if (target !== undefined)
    requireCondition(typeof target === 'string' && /^[0-9a-f]{64}$/i.test(target), 'Invalid P2C work target');
  const bytes = Buffer.from(proofHex, 'hex');
  const reader = new Reader(bytes, 'P2C proof');
  const version = reader.u8();
  requireCondition(version === 1, 'Unsupported P2C proof version');
  const messages: DecodedP2CProof['messages'] = [];
  const bodies: Buffer[] = [];
  for (const profile of MESSAGE_PROFILE) {
    const type = reader.u8();
    const size = reader.u24();
    requireCondition(type === profile.type, 'Unexpected TLS handshake message order');
    requireCondition(size + 4 <= profile.maximum, `${profile.name} exceeds P2C message size limit`);
    bodies.push(reader.read(size));
    messages.push({ name: profile.name, type, length: size + 4 });
  }
  reader.end();

  const client = clientHello(bodies[0]);
  const cipher = serverHello(bodies[1], client);
  const encryptedExtensions = extensions(new Reader(bodies[2], 'EncryptedExtensions'));
  requireCondition(!encryptedExtensions.has(42), 'TLS early_data is forbidden in P2C v1');
  const certificates = certificateChain(bodies[3]);
  const verify = new Reader(bodies[4], 'CertificateVerify');
  const scheme = verify.u16();
  const signatureSize = verify.u16();
  requireCondition(signatureSize > 0, 'Empty CertificateVerify signature');
  verify.read(signatureSize);
  verify.end();
  requireCondition(
    SIGNATURES[scheme] && client.signatures.includes(scheme),
    'Unsupported or unoffered CertificateVerify signature scheme',
  );

  const indexBytes = Buffer.alloc(4);
  indexBytes.writeUInt32LE(inputIndex);
  const expectedChallenge = taggedHash(
    'ConnectCoin/P2C/claim/v1',
    Buffer.concat([Buffer.from(txid, 'hex').reverse(), indexBytes]),
  ).toString('hex');
  // Version is excluded; uint256 RPC display order is reversed SHA-256 bytes.
  const workHash = taggedHash('ConnectCoin/P2C/work/v1', bytes.subarray(1)).reverse().toString('hex');
  return {
    version,
    byteLength: bytes.length,
    domain: client.domain,
    challenge: client.challenge,
    expectedChallenge,
    challengeMatches: client.challenge === expectedChallenge,
    workHash,
    ...(target === undefined ? {} : { meetsTarget: BigInt(`0x${workHash}`) <= BigInt(`0x${target}`) }),
    messages,
    certificates,
    cipherSuite: { code: cipher, name: CIPHERS[cipher] },
    signatureScheme: { code: scheme, name: SIGNATURES[scheme] },
    rawHex: bytes.toString('hex'),
    validationScope:
      'Display checks only: TLS structure, claim challenge and work target. Certificate signature, chain trust, median-time validity, spent-output domain binding and consensus validity are not verified here; the node validates transactions.',
  };
}
