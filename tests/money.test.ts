import assert from 'node:assert/strict';
import test from 'node:test';
import { formatMoney } from '../src/shared/money.js';
import { PROTOCOL } from '../src/shared/networks.js';

test('money formatting displays the CONN ticker and trims fractional trailing zeroes', () => {
  assert.equal(formatMoney('0'), '0 CONN');
  assert.equal(formatMoney('10000000000'), '1 CONN');
  assert.equal(formatMoney('15000000000'), '1.5 CONN');
  assert.equal(formatMoney('12345678901234'), '1,234.5678901234 CONN');
});

test('money formatting can omit the ticker without changing the amount', () => {
  assert.equal(formatMoney('0', false), '0');
  assert.equal(formatMoney('12345678901234', false), '1,234.5678901234');
  assert.equal(formatMoney('-15000000000', false), '-1.5');
});

test('money formatting preserves single-connect precision and negative values', () => {
  assert.equal(formatMoney('1'), '0.0000000001 CONN');
  assert.equal(formatMoney('-1'), '-0.0000000001 CONN');
  assert.equal(formatMoney('-15000000000'), '-1.5 CONN');
  assert.equal(formatMoney('-12345678901234'), '-1,234.5678901234 CONN');
});

test('money formatting preserves exact maximum and large integer amounts with BigInt', () => {
  assert.equal(formatMoney(PROTOCOL.maxMoneyConnects), '100,000,000 CONN');
  assert.equal(formatMoney('999999999999999999'), '99,999,999.9999999999 CONN');
  assert.equal(formatMoney('90071992547409930000000001'), '9,007,199,254,740,993.0000000001 CONN');
});

test('money formatting returns an em dash for missing or invalid amounts', () => {
  for (const value of [undefined, 'not-a-number', 'NaN', 'Infinity', '1.5', '1e10']) {
    assert.equal(formatMoney(value), '—', String(value));
    assert.equal(formatMoney(value, false), '—', String(value));
  }
});
