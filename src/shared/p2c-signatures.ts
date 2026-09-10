// Core PayToDomainOutput mask bits and TLS CertificateVerify SignatureScheme codes.
// The mask is an output restriction, not the algorithm selected in a proof or
// the algorithm an issuer used to sign an X.509 certificate.
export const P2C_SIGNATURE_ALGORITHMS = [
  { bit: 1, code: 0x0403, name: 'ecdsa_secp256r1_sha256', label: 'ECDSA P-256 / SHA-256' },
  { bit: 2, code: 0x0804, name: 'rsa_pss_rsae_sha256', label: 'RSA-PSS-RSAE / SHA-256' },
  { bit: 4, code: 0x0809, name: 'rsa_pss_pss_sha256', label: 'RSA-PSS-PSS / SHA-256' },
] as const;

export function isValidP2CSignatureMask(mask: unknown): mask is number {
  return typeof mask === 'number' && Number.isInteger(mask) && mask >= 1 && mask <= 7;
}

export function acceptedP2CSignatureAlgorithms(mask: unknown) {
  if (!isValidP2CSignatureMask(mask)) return undefined;
  return P2C_SIGNATURE_ALGORITHMS.filter((algorithm) => (mask & algorithm.bit) !== 0);
}

export function isP2CSignatureSchemeAllowed(mask: number, scheme: number): boolean {
  return acceptedP2CSignatureAlgorithms(mask)?.some((algorithm) => algorithm.code === scheme) ?? false;
}
