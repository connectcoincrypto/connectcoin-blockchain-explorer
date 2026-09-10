import React from 'react';
import { acceptedP2CSignatureAlgorithms } from '../shared/p2c-signatures';

export function P2CSignatureAlgorithms({ mask }: { mask?: number }) {
  const algorithms = acceptedP2CSignatureAlgorithms(mask);
  return (
    <div className="p2c-signature-policy">
      <div className="output-property">
        <span>Accepted signature algorithms</span>
        {algorithms && (
          <strong>
            Mask {mask} (0x{mask!.toString(16).padStart(2, '0')})
          </strong>
        )}
      </div>
      {algorithms ? (
        <ul className="p2c-signature-list" aria-label="Accepted TLS CertificateVerify signature algorithms">
          {algorithms.map((algorithm) => (
            <li key={algorithm.code}>
              <strong>{algorithm.label}</strong>
              <span className="mono">
                0x{algorithm.code.toString(16).padStart(4, '0')} · {algorithm.name}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted small">Unavailable — the output did not provide a supported signature mask.</p>
      )}
    </div>
  );
}
