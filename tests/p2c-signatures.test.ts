import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { P2CSignatureAlgorithms } from '../src/client/P2CSignatureAlgorithms.js';
import {
  acceptedP2CSignatureAlgorithms,
  isValidP2CSignatureMask,
  isP2CSignatureSchemeAllowed,
} from '../src/shared/p2c-signatures.js';

test('all seven output masks map only to their permitted TLS schemes', () => {
  const expected = [
    [],
    [0x0403],
    [0x0804],
    [0x0403, 0x0804],
    [0x0809],
    [0x0403, 0x0809],
    [0x0804, 0x0809],
    [0x0403, 0x0804, 0x0809],
  ];
  for (let mask = 1; mask <= 7; mask++) {
    assert.equal(isValidP2CSignatureMask(mask), true);
    assert.deepEqual(
      acceptedP2CSignatureAlgorithms(mask)!.map((algorithm) => algorithm.code),
      expected[mask],
    );
    for (const scheme of [0x0403, 0x0804, 0x0809, 0x0807])
      assert.equal(isP2CSignatureSchemeAllowed(mask, scheme), expected[mask].includes(scheme));
  }
  for (const mask of [undefined, null, '7', 0, 8, 255, -1, 1.5, NaN, Infinity]) {
    assert.equal(isValidP2CSignatureMask(mask), false);
    assert.equal(acceptedP2CSignatureAlgorithms(mask), undefined);
  }
});

test('output policy markup names and identifies the allowed algorithms without claiming all are allowed', () => {
  for (let mask = 1; mask <= 7; mask++) {
    const html = renderToStaticMarkup(createElement(P2CSignatureAlgorithms, { mask }));
    assert.ok(html.includes(`Mask ${mask} (0x0${mask})`));
    for (const [bit, name, code] of [
      [1, 'ecdsa_secp256r1_sha256', '0x0403'],
      [2, 'rsa_pss_rsae_sha256', '0x0804'],
      [4, 'rsa_pss_pss_sha256', '0x0809'],
    ] as const) {
      assert.equal(html.includes(name), (mask & bit) !== 0);
      assert.equal(html.includes(code), (mask & bit) !== 0);
    }
  }
  const unknown = renderToStaticMarkup(createElement(P2CSignatureAlgorithms));
  assert.match(unknown, /Unavailable/);
  assert.ok(!unknown.includes('rsa_pss') && !unknown.includes('ecdsa_secp'));
});
