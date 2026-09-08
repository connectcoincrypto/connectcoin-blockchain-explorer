import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { bech32m } from 'bech32';
import { RpcClient, RpcError, parseRpcJson } from '../src/server/rpc.js';
import {
  decimalToAtomic,
  normalizeBlock,
  normalizeTransaction,
  safeInteger,
} from '../src/server/normalize.js';

async function fixture(
  handler: (req: IncomingMessage, res: ServerResponse, body: any) => void | Promise<void>,
) {
  const server = createServer(async (req, res) => {
    let text = '';
    for await (const chunk of req) text += chunk;
    await handler(req, res, JSON.parse(text));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('RPC HTTP Basic preserves the complete original monetary number', async () => {
  const node = await fixture((req, res, body) => {
    assert.equal(req.headers.authorization, `Basic ${Buffer.from('alice:secret').toString('base64')}`);
    assert.deepEqual(body.params, ['f'.repeat(64), 2]);
    assert.equal(body.method, 'getrawtransaction');
    res.end(`{"id":"${body.id}","result":{"value":99999999.9999999999,"height":7,"ok":true},"error":null}`);
  });
  try {
    const result = await new RpcClient({ url: node.url, user: 'alice', password: 'secret' }).call(
      'getrawtransaction',
      ['f'.repeat(64), 2],
    );
    assert.equal(result.value, '99999999.9999999999');
    assert.equal(decimalToAtomic(result.value), '999999999999999999');
    assert.equal(result.height, '7');
    assert.equal(result.ok, true);
  } finally {
    await node.close();
  }
});

test('RPC rereads cookie after rotation and allows reconnect after missing cookie', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'connectcoin-explorer-cookie-'));
  const cookieFile = join(directory, '.cookie');
  const headers: string[] = [];
  const node = await fixture((req, res, body) => {
    headers.push(req.headers.authorization ?? '');
    res.end(JSON.stringify({ id: body.id, result: null, error: null }));
  });
  try {
    const rpc = new RpcClient({ url: node.url, cookieFile });
    await assert.rejects(rpc.call('gettxout'), /cookie could not be read/);
    await writeFile(cookieFile, '__cookie__:first-secret\n');
    assert.equal(await rpc.call('gettxout'), null);
    await writeFile(cookieFile, '__cookie__:second-secret\n');
    await rpc.call('gettxout');
    assert.deepEqual(
      headers,
      ['__cookie__:first-secret', '__cookie__:second-secret'].map(
        (value) => `Basic ${Buffer.from(value).toString('base64')}`,
      ),
    );
  } finally {
    await node.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('RPC whitelist rejects node mutations without making an HTTP request', async () => {
  let requests = 0;
  const node = await fixture((_req, res) => {
    requests++;
    res.end('{}');
  });
  try {
    const rpc = new RpcClient({ url: node.url });
    for (const method of ['sendrawtransaction', 'stop', 'getwalletinfo', 'getchainparams']) {
      await assert.rejects(rpc.call(method), /not permitted/);
    }
    assert.equal(requests, 0);
  } finally {
    await node.close();
  }
});

test('RPC times out an HTTP response and can retry', async () => {
  let requests = 0;
  const node = await fixture((_req, res, body) => {
    if (++requests > 1) res.end(JSON.stringify({ id: body.id, result: 'reconnected' }));
  });
  try {
    const rpc = new RpcClient({ url: node.url, timeoutMs: 50 });
    await assert.rejects(rpc.call('getblockchaininfo'), /timed out/);
    assert.equal(await rpc.call('getblockchaininfo'), 'reconnected');
  } finally {
    await node.close();
  }
});

test('RPC sanitizes node, HTTP authentication, and invalid JSON errors', async () => {
  let mode = 'rpc';
  const secret = 'NEVER_EXPOSE_RPC_SECRET';
  const node = await fixture((_req, res, body) => {
    if (mode === 'auth') {
      res.statusCode = 401;
      res.end(secret);
    } else if (mode === 'json') res.end(secret);
    else {
      res.statusCode = 500;
      res.end(JSON.stringify({ id: body.id, error: { code: -5, message: secret } }));
    }
  });
  try {
    const rpc = new RpcClient({ url: node.url });
    await assert.rejects(
      rpc.call('getblockhash', [0]),
      (error: unknown) => error instanceof RpcError && error.code === -5 && !error.message.includes(secret),
    );
    mode = 'auth';
    await assert.rejects(rpc.call('getblockhash'), /authentication failed/);
    mode = 'json';
    await assert.rejects(
      rpc.call('getblockhash'),
      (error: unknown) => error instanceof RpcError && !error.message.includes(secret),
    );
  } finally {
    await node.close();
  }
});

test('RPC rejects oversized declared responses and mismatched response IDs', async () => {
  let oversized = true;
  const node = await fixture((_req, res) => {
    if (oversized) res.setHeader('content-length', String(512 * 1024 * 1024));
    res.end('{"id":"wrong","result":null}');
  });
  try {
    const rpc = new RpcClient({ url: node.url });
    await assert.rejects(rpc.call('getblock'), /allowed size/);
    oversized = false;
    await assert.rejects(rpc.call('getblock'), /unexpected RPC response/);
  } finally {
    await node.close();
  }
});

test('RPC accepts a 320 MiB response for output-dense ConnectCoin blocks', async () => {
  // Stream the fixture instead of retaining a second giant server-side copy.
  const chunk = '00'.repeat(512 * 1024);
  const chunks = 320;
  const hexLength = chunks * 1024 * 1024;
  const node = await fixture(async (_req, res, body) => {
    const prefix = `{"id":"${body.id}","result":{"tx":[{"hex":"`;
    const suffix = '"}]}}';
    res.setHeader('content-length', Buffer.byteLength(prefix) + hexLength + Buffer.byteLength(suffix));
    res.write(prefix);
    for (let i = 0; i < chunks; i++) {
      if (!res.write(chunk)) await once(res, 'drain');
    }
    res.end(suffix);
  });
  try {
    const result = await new RpcClient({ url: node.url }).call('getblock', ['a'.repeat(64), 2]);
    assert.equal(result.tx[0].hex.length, hexLength);
    assert.equal(result.tx[0].hex.slice(-2), '00');
  } finally {
    await node.close();
  }
});

test('decimal conversion covers connects, exponent notation, and precision rejection', () => {
  assert.equal(decimalToAtomic('0.0000000001'), '1');
  assert.equal(decimalToAtomic('1e-10'), '1');
  assert.equal(decimalToAtomic('-15.1234567890'), '-151234567890');
  assert.equal(decimalToAtomic('10000000.0000000000'), '100000000000000000');
  assert.equal(decimalToAtomic('1.00000000000'), '10000000000');
  assert.throws(() => decimalToAtomic('0.00000000001'), /10 decimal places/);
  assert.throws(() => decimalToAtomic('1e999999'), /exponent/);
  assert.throws(() => safeInteger('9007199254740993'), /unsafe/);
  assert.throws(() => safeInteger(''), /invalid/);
  assert.equal(parseRpcJson('{"value":1e-10}').value, '1e-10');
});

const pubkey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const txFixture = () => ({
  txid: 'a'.repeat(64),
  hash: 'b'.repeat(64),
  size: '1000',
  vsize: '400',
  weight: '1600',
  fee: '0.0000000001',
  vin: [
    {
      txid: 'c'.repeat(64),
      vout: '1',
      sequence: '4294967295',
      txinwitness: ['010203'],
      prevout: {
        type: '2',
        value: '12.0000000000',
        domain: 'example.com',
        connection_work_target: 'f'.repeat(64),
        root_certificates_version: '1',
      },
    },
  ],
  vout: [
    { n: '0', type: '1', value: '11.9999999998', pubkey, scriptPubKey: { type: 'witness_v1_taproot' } },
    {
      n: '1',
      type: '2',
      value: '0.0000000001',
      domain: 'example.com',
      connection_work_target: '0'.repeat(63) + 'f',
      root_certificates_version: '1',
      scriptPubKey: { type: 'nonstandard' },
    },
  ],
});

test('normalization uses typed output numbers, preserves all connects and P2C metadata', () => {
  const tx = normalizeTransaction(txFixture(), 'testnet4', {
    height: 0,
    blockHash: 'd'.repeat(64),
    time: 1788814378,
  });
  assert.equal(tx.height, 0);
  assert.equal(tx.outputs[0].type, 1);
  assert.equal(tx.outputs[0].value, '119999999998');
  const address = bech32m.decode(tx.outputs[0].address!);
  assert.equal(address.prefix, 'tcc');
  assert.equal(address.words[0], 1);
  assert.equal(Buffer.from(bech32m.fromWords(address.words.slice(1))).toString('hex'), pubkey);
  assert.deepEqual(tx.outputs[1], {
    index: 1,
    type: 2,
    value: '1',
    domain: 'example.com',
    target: '0'.repeat(63) + 'f',
    rootsVersion: 1,
  });
  assert.equal(tx.inputs[0].outputType, 2);
  assert.equal(tx.inputs[0].domain, 'example.com');
  assert.equal(tx.inputs[0].value, '120000000000');
  assert.deepEqual(tx.inputs[0].witness, ['010203']);
  assert.equal(tx.fee, '1');
  assert.match(normalizeTransaction(txFixture(), 'main').outputs[0].address!, /^cc1p/);
  assert.match(normalizeTransaction(txFixture(), 'regtest').outputs[0].address!, /^ccrt1p/);
});

test('normalization preserves supplied address and does not fabricate unavailable fees', () => {
  const raw: any = txFixture();
  delete raw.fee;
  raw.vout[0].scriptPubKey.address = 'already-supplied-address';
  raw.vin = [{ coinbase: '0100', sequence: '4294967295' }];
  const tx = normalizeTransaction(raw, 'testnet4');
  assert.equal(tx.outputs[0].address, 'already-supplied-address');
  assert.equal(tx.fee, undefined);
  assert.equal(tx.inputs[0].coinbase, '0100');
  assert.equal(tx.inputs[0].txid, undefined);
});

test('block normalization accepts RPC integer strings and exact difficulty', () => {
  const block = normalizeBlock({
    hash: 'a'.repeat(64),
    height: '0',
    time: '1788814378',
    nTx: '1',
    size: '250',
    weight: '1000',
    difficulty: '0.12345678901234567890',
    version: '1',
    nonce: '60490',
    bits: '1f00ffff',
    merkleroot: 'b'.repeat(64),
    chainwork: 'c'.repeat(64),
  });
  assert.equal(block.height, 0);
  assert.equal(block.txCount, 1);
  assert.equal(block.nonce, 60490);
  assert.equal(block.difficulty, '0.12345678901234567890');
  assert.equal(block.previousHash, undefined);
});
