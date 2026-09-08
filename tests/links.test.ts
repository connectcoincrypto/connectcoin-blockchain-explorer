import assert from 'node:assert/strict';
import test from 'node:test';
import { outputPath } from '../src/shared/links.js';

test('output links select the exact output and its page, including large P2C batches', () => {
  const txid = 'ab'.repeat(32);
  for (const [index, page] of [
    [0, 1],
    [19, 1],
    [20, 2],
    [39, 2],
    [1999, 100],
  ]) {
    assert.equal(outputPath(txid, index), `/tx/${txid}?outputsPage=${page}#output-${index}`);
  }
});
