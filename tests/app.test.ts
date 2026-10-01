import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { once } from 'node:events';
import { createHash, X509Certificate } from 'node:crypto';
import { rootCertificates } from 'node:tls';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bech32m } from 'bech32';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import { IndexStore } from '../src/server/index-store.js';
import type { RpcClient } from '../src/server/rpc.js';
import type { ExplorerStatus } from '../src/shared/types.js';
import { NETWORKS, PROTOCOL } from '../src/shared/networks.js';

const hash = (n: number): string => n.toString(16).padStart(64, '0');
const pubkey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const keyOutput = (value: string, n = 0) => ({ n: String(n), type: '1', value, pubkey });
const bountyOutput = (value: string, n: number) => ({
  n: String(n),
  type: '2',
  value,
  domain: 'example.com',
  connection_work_target: 'f'.repeat(64),
  root_certificates_version: '1',
  signature_algorithms_mask: n === 21 ? '6' : '7',
});
function transaction(id: number, outputs: any[], inputs?: any[]) {
  return {
    txid: hash(id),
    hash: hash(id + 10000),
    version: '1',
    locktime: '0',
    size: '2000',
    vsize: '1500',
    weight: '6000',
    vin: inputs ?? [{ coinbase: '0000', sequence: '4294967295' }],
    vout: outputs,
  };
}
function block(height: number, id: number, tx: any[], previous?: any) {
  return {
    height: String(height),
    hash: height === 0 ? NETWORKS.testnet4.genesis!.hash : hash(id),
    time: String(1700000000 + height * 10),
    nTx: String(tx.length),
    size: '10000',
    weight: '32000',
    difficulty: '1.234567890123456789',
    version: '1',
    nonce: '42',
    bits: '1d00ffff',
    merkleroot: hash(id + 20000),
    previousblockhash: previous?.hash,
    tx,
  };
}

// Synthetic framed TLS transcript, used only to test HTTP proof decoding. The
// public root certificate and placeholder signature are not a valid P2C claim.
function proof(txid: string, index: number): string {
  const number = (n: number, size: number) => {
    const b = Buffer.alloc(size);
    b.writeUIntBE(n, 0, size);
    return b;
  };
  const concat = (...parts: Buffer[]) => Buffer.concat(parts);
  const vector = (bytes: Buffer, size = 2) => concat(number(bytes.length, size), bytes);
  const extension = (type: number, bytes: Buffer) => concat(number(type, 2), vector(bytes));
  const handshake = (type: number, bytes: Buffer) => concat(number(type, 1), vector(bytes, 3));
  const tag = createHash('sha256').update('ConnectCoin/P2C/claim/v1').digest();
  const inputIndex = Buffer.alloc(4);
  inputIndex.writeUInt32LE(index);
  const challenge = createHash('sha256')
    .update(concat(tag, tag, Buffer.from(txid, 'hex').reverse(), inputIndex))
    .digest();
  const share = concat(number(0x001d, 2), vector(Buffer.alloc(32, 1)));
  const client = concat(
    number(0x0303, 2),
    challenge,
    number(0, 1),
    vector(number(0x1301, 2)),
    Buffer.from([1, 0]),
    vector(
      concat(
        extension(0, vector(concat(number(0, 1), vector(Buffer.from('example.com'))))),
        extension(43, vector(number(0x0304, 2), 1)),
        extension(13, vector(number(0x0403, 2))),
        extension(51, vector(share)),
      ),
    ),
  );
  const server = concat(
    number(0x0303, 2),
    Buffer.alloc(32, 3),
    number(0, 1),
    number(0x1301, 2),
    number(0, 1),
    vector(concat(extension(43, number(0x0304, 2)), extension(51, share))),
  );
  const cert = new X509Certificate(rootCertificates[0]).raw;
  const certificates = concat(number(0, 1), vector(concat(vector(cert, 3), number(0, 2)), 3));
  return concat(
    Buffer.from([2]),
    handshake(1, client),
    handshake(2, server),
    handshake(8, Buffer.from([0, 0])),
    handshake(11, certificates),
    handshake(15, concat(number(0x0403, 2), vector(Buffer.from([0x30])))),
  ).toString('hex');
}

class MockRpc {
  calls: { method: string; params: unknown[] }[] = [];
  blocks: any[];
  raw = new Map<string, any>();
  pool: Record<string, any> = {};
  constructor() {
    const genesis = block(0, 100, [
      transaction(
        1,
        Array.from({ length: 22 }, (_, index) =>
          [1, 21].includes(index)
            ? bountyOutput('1000000.0000000001', index)
            : keyOutput('1000000.0000000001', index),
        ),
      ),
    ]);
    const redemption = transaction(
      2,
      Array.from({ length: 22 }, (_, index) =>
        index === 1 ? bountyOutput('999999.9999999999', index) : keyOutput('999999.9999999999', index),
      ),
      Array.from({ length: 22 }, (_, index) => ({
        txid: hash(1),
        vout: String(index),
        sequence: '4294967295',
        ...([1, 21].includes(index)
          ? { txinwitness: [index === 1 ? proof(hash(2), 1) : '01' + proof(hash(2), 21).slice(2)] }
          : {}),
      })),
    );
    this.blocks = [genesis, block(1, 101, [transaction(3, [keyOutput('15')]), redemption], genesis)];
    this.raw.set(
      hash(4),
      transaction(
        4,
        [keyOutput('999999.9999999998')],
        [{ txid: hash(2), vout: '1', sequence: '4294967295', txinwitness: [proof(hash(4), 0)] }],
      ),
    );
    this.raw.set(
      hash(8),
      transaction(
        8,
        [keyOutput('999999.9999999997')],
        [{ txid: hash(4), vout: '0', sequence: '4294967295' }],
      ),
    );
    this.raw.set(hash(5), transaction(5, [keyOutput('1')])); // Evicted, absent from pool.
    this.raw.set(hash(6), {
      ...transaction(6, [keyOutput('1')]),
      in_active_chain: false,
      blockhash: hash(999),
    });
    this.raw.set(hash(7), {
      ...transaction(7, [keyOutput('1')]),
      blockhash: hash(102),
      in_active_chain: true,
      confirmations: '1',
    });
    this.raw.set(hash(9), { ...transaction(9, [keyOutput('1')]), blockhash: hash(999), confirmations: '0' });
    this.pool[hash(4)] = {
      time: '1700000200',
      vsize: '100',
      weight: '400',
      fees: { base: '0.0000000001' },
      depends: [],
    };
    this.pool[hash(8)] = {
      time: '1700000210',
      vsize: '100',
      weight: '400',
      fees: { base: '0.0000000001' },
      depends: [hash(4)],
    };
    for (let i = 0; i < 20; i++)
      this.pool[hash(1000 + i)] = {
        time: String(1700000100 + i),
        vsize: '100',
        weight: '400',
        fees: { base: '0.0000000002' },
        depends: [],
      };
  }
  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    if (method === 'getblockchaininfo') return { chain: 'testnet4', blocks: '1', pruned: false } as T;
    if (method === 'getblockhash') return this.blocks[Number(params[0])].hash as T;
    if (method === 'getblock') return structuredClone(this.blocks.find((b) => b.hash === params[0])) as T;
    if (method === 'getrawtransaction') {
      const found = this.raw.get(String(params[0]));
      if (!found) throw Object.assign(new Error('No such mempool or blockchain transaction'), { code: -5 });
      return structuredClone(found) as T;
    }
    if (method === 'getrawmempool') return structuredClone(this.pool) as T;
    if (method === 'getmempoolentry') {
      const found = this.pool[String(params[0])];
      if (!found) throw Object.assign(new Error('Transaction not in mempool'), { code: -5 });
      return structuredClone(found) as T;
    }
    if (method === 'gettxspendingprevout')
      return (params[0] as { txid: string; vout: number }[]).map((prevout) => ({
        ...prevout,
        ...(prevout.txid === hash(2) && prevout.vout === 1
          ? { spendingtxid: hash(4) }
          : prevout.txid === hash(4) && prevout.vout === 0
            ? { spendingtxid: hash(8) }
            : {}),
      })) as T;
    throw new Error(`Unexpected RPC call ${method}`);
  }
}

async function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'connectcoin-api-test-'));
  const store = new IndexStore(join(directory, 'chain.sqlite'), 'testnet4');
  const rpc = new MockRpc();
  const config = readConfig(['--testnet'], {
    CONNECTCOIN_RPC_USER: 'private-user',
    CONNECTCOIN_RPC_PASSWORD: 'private-password',
  });
  const status: ExplorerStatus = {
    network: 'testnet4',
    chain: 'testnet4',
    title: 'ConnectCoin Testnet Explorer',
    connected: true,
    indexedHeight: 1,
    nodeHeight: 1,
    syncing: false,
  };
  await store.sync(rpc);
  rpc.calls = [];
  const app = createApp({ config, status, store, rpc: rpc as unknown as RpcClient });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  async function get(path: string, expected = 200) {
    const response = await fetch(url + path);
    const body = (await response.json()) as any;
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(body)}`);
    return body;
  }
  return { get, url, store, rpc, status };
}

test('HTTP status and health expose the testnet title without RPC credentials', async (t) => {
  const api = await setup(t);
  const response = await fetch(api.url + '/api/status');
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(text).title, 'ConnectCoin Testnet Explorer');
  assert.ok(!text.includes('private-user') && !text.includes('private-password'));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(response.headers.get('x-powered-by'), null);
  assert.equal((await api.get('/api/health')).ready, true);
  api.status.syncing = true;
  assert.equal((await api.get('/api/health', 503)).ready, false);
  api.status.connected = false;
  assert.equal((await api.get('/api/status')).connected, false);
});

test('HTTP network metadata describes the current genesis and v2 protocol without exposing configuration', async (t) => {
  const api = await setup(t);
  const network = await api.get('/api/network');
  assert.deepEqual(network.parameters, NETWORKS.testnet4);
  assert.deepEqual(network.protocol, PROTOCOL);
  assert.equal(network.protocol.ticker, 'CONN');
  assert.equal(network.observedGenesis, null);
  api.status.genesis = NETWORKS.testnet4.genesis!.hash;
  assert.equal((await api.get('/api/network')).observedGenesis, NETWORKS.testnet4.genesis!.hash);
  assert.equal('rpcPassword' in network, false);
  assert.equal('rpcUrl' in network, false);
});

test('HTTP block and transaction pagination preserve exact amounts, numeric output types and enriched inputs', async (t) => {
  const api = await setup(t);
  const overview = await api.get('/api/overview');
  assert.equal(overview.index.blockCount, 2);
  assert.equal(overview.index.bountyCount, 3);
  const blocks = await api.get('/api/blocks');
  assert.deepEqual(
    blocks.items.map((b: any) => b.height),
    [1, 0],
  );
  const byHeight = await api.get('/api/blocks/0');
  const byHash = await api.get(`/api/blocks/${NETWORKS.testnet4.genesis!.hash}`);
  assert.deepEqual(byHeight, byHash);
  assert.equal(byHeight.confirmations, 2);
  assert.equal(byHeight.transactions.items[0].totalOutput, '220000000000000022');
  const first = await api.get(`/api/transactions/${hash(1)}`);
  assert.equal(first.outputs.total, 22);
  assert.equal(first.outputs.items.length, 20);
  assert.equal(first.outputs.items[0].type, 1);
  assert.equal(first.outputs.items[1].type, 2);
  assert.equal(first.outputs.items[1].signatureAlgorithmsMask, 7);
  assert.equal(first.outputs.items[0].value, '10000000000000001');
  assert.equal(typeof first.outputs.items[1].type, 'number');
  assert.equal(first.totalOutput, '220000000000000022');
  const second = await api.get(`/api/transactions/${hash(2)}?inputsPage=2&outputsPage=2`);
  assert.deepEqual(
    second.inputs.items.map((i: any) => i.index),
    [20, 21],
  );
  assert.deepEqual(
    second.outputs.items.map((o: any) => o.index),
    [20, 21],
  );
  assert.equal(second.inputs.items[1].outputType, 2);
  assert.equal(second.inputs.items[1].value, '10000000000000001');
  assert.equal(second.inputs.items[1].domain, 'example.com');
  assert.equal(second.inputs.items[1].signatureAlgorithmsMask, 6);
  assert.equal(second.inputs.items[1].hasProof, true);
  assert.equal(second.inputs.items[1].witnessCount, 1);
  assert.equal('witness' in second.inputs.items[1], false);
  assert.equal(second.totalOutput, '219999999999999978');
  assert.equal(second.fee, '44');
  const pending = await api.get(`/api/transactions/${hash(2)}`);
  assert.deepEqual(pending.outputs.items[1].spent, { txid: hash(4), inputIndex: -1, confirmed: false });
  assert.equal(
    api.store.getTransaction(hash(2))!.outputs[1].spent,
    undefined,
    'mempool overlay must not mutate confirmed index',
  );
});

test('HTTP proof endpoint decodes the selected P2C witness and distinguishes missing from malformed proofs', async (t) => {
  const api = await setup(t);
  const decoded = await api.get(`/api/transactions/${hash(2)}/proof/1`);
  assert.equal(decoded.domain, 'example.com');
  assert.equal(decoded.version, 2);
  assert.equal(decoded.signatureAlgorithmsMask, 7);
  assert.equal(decoded.signatureSchemeAllowed, true);
  assert.equal(decoded.workHashTag, 'ConnectCoin/P2C/work/v2');
  assert.equal(decoded.messages.at(-1).includedInWorkHash, false);
  assert.equal(decoded.challengeMatches, true);
  assert.equal(decoded.meetsTarget, true);
  assert.equal(decoded.rawHex, proof(hash(2), 1));
  assert.deepEqual(
    decoded.messages.map((message: any) => message.name),
    ['ClientHello', 'ServerHello', 'EncryptedExtensions', 'Certificate', 'CertificateVerify'],
  );
  assert.match(decoded.validationScope, /not verified here/);
  await api.get(`/api/transactions/${hash(2)}/proof/0`, 404);
  const legacy = await api.get(`/api/transactions/${hash(2)}/proof/21`, 422);
  assert.match(legacy.error, /Only proof version 2/);
  await api.get(`/api/transactions/${hash(2)}/proof/999`, 404);
  await api.get(`/api/transactions/${hash(2)}/proof/-1`, 400);
});

test('HTTP confirmation counts use the indexed tip rather than an ahead or stale node height', async (t) => {
  const api = await setup(t);
  for (const nodeHeight of [100, 0]) {
    api.status.nodeHeight = nodeHeight;
    assert.equal((await api.get('/api/blocks/0')).confirmations, 2);
    assert.equal((await api.get('/api/blocks/1')).confirmations, 1);
    assert.equal((await api.get(`/api/transactions/${hash(1)}`)).confirmations, 2);
    assert.equal((await api.get(`/api/transactions/${hash(2)}`)).confirmations, 1);
  }
  api.rpc.raw.get(hash(7)).height = '2';
  const unindexed = await api.get(`/api/transactions/${hash(7)}`);
  assert.equal(unindexed.blockHash, hash(102));
  assert.equal(unindexed.height, undefined);
  assert.equal(unindexed.confirmations, undefined);
});

test('HTTP rejects orphan or malformed RPC block confirmations', async (t) => {
  const api = await setup(t);
  for (const confirmations of [undefined, 'not-a-number', '0', '-1']) {
    api.rpc.raw.get(hash(7)).confirmations = confirmations;
    await api.get(`/api/transactions/${hash(7)}`, 404);
  }
});

test('HTTP transaction membership does not rely on a previously cached mempool list', async (t) => {
  const api = await setup(t);
  await api.get('/api/mempool');
  delete api.rpc.pool[hash(4)];
  await api.get(`/api/transactions/${hash(4)}`, 404);
  await api.get(`/api/transactions/${hash(4)}/proof/0`, 404);
  assert.equal(api.rpc.calls.filter((call) => call.method === 'getmempoolentry').length, 2);
});

test('HTTP address/domain accounts, bounty filters and search reflect confirmed history', async (t) => {
  const api = await setup(t);
  const address = api.store.getTransaction(hash(1))!.outputs[0].address!;
  const account = await api.get(`/api/address/${address}`);
  assert.equal(account.kind, 'address');
  assert.equal(account.transactions.total, 3);
  const domain = await api.get('/api/domain/EXAMPLE.COM');
  assert.equal(domain.balance, '9999999999999999');
  assert.equal(domain.totalReceived, '30000000000000001');
  assert.equal(domain.totalSent, '20000000000000002');
  assert.equal(domain.transactions.total, 2);
  assert.equal((await api.get('/api/bounties')).total, 1);
  assert.equal((await api.get('/api/bounties?state=spent&domain=example.com')).total, 2);
  assert.equal((await api.get('/api/bounties?state=all')).total, 3);
  assert.deepEqual(
    (await api.get('/api/bounties?state=all')).items.map((b: any) => b.signatureAlgorithmsMask),
    [7, 7, 6],
  );
  assert.equal((await api.get('/api/bounties?domain=absent.example')).total, 0);
  for (const [query, path] of [
    ['0', '/block/0'],
    [NETWORKS.testnet4.genesis!.hash, `/block/${NETWORKS.testnet4.genesis!.hash}`],
    [hash(2), `/tx/${hash(2)}`],
    ['EXAMPLE.COM', '/domain/example.com'],
    [address, `/address/${address}`],
  ])
    assert.equal((await api.get(`/api/search?q=${encodeURIComponent(query)}`)).path, path);
});

test('HTTP mempool pagination, fees, caching and pending transaction enrichment use read-only RPC', async (t) => {
  const api = await setup(t);
  const first = await api.get('/api/mempool');
  assert.equal(first.total, 22);
  assert.equal(first.items.length, 20);
  assert.equal(first.items[0].txid, hash(8));
  assert.equal(first.items[0].depends, 1);
  assert.equal(first.items[0].fee, '1');
  const second = await api.get('/api/mempool?page=2');
  assert.equal(second.items.length, 2);
  assert.equal(api.rpc.calls.filter((call) => call.method === 'getrawmempool').length, 1);
  const pending = await api.get(`/api/transactions/${hash(4)}`);
  assert.equal(pending.inputs.items[0].outputType, 2);
  assert.equal(pending.inputs.items[0].domain, 'example.com');
  assert.equal(pending.inputs.items[0].signatureAlgorithmsMask, 7);
  assert.equal(pending.inputs.items[0].value, '9999999999999999');
  assert.equal(pending.fee, '1');
  assert.equal(pending.height, undefined);
  assert.equal(pending.blockHash, undefined);
  assert.equal(pending.outputs.items[0].spent.confirmed, false);
  assert.equal((await api.get(`/api/transactions/${hash(4)}/proof/0`)).challengeMatches, true);
  await api.get(`/api/transactions/${hash(5)}`, 404);
  await api.get(`/api/transactions/${hash(6)}`, 404);
  await api.get(`/api/transactions/${hash(9)}`, 404);
  assert.equal((await api.get(`/api/transactions/${hash(7)}`)).blockHash, hash(102));
  assert.ok(
    api.rpc.calls.every((call) =>
      ['getrawmempool', 'getmempoolentry', 'getrawtransaction', 'gettxspendingprevout'].includes(call.method),
    ),
  );
  api.status.connected = false;
  await api.get('/api/mempool', 503);
  assert.equal(
    (await api.get(`/api/transactions/${hash(1)}`)).txid,
    hash(1),
    'indexed reads survive an RPC outage',
  );
});

test('HTTP mempool children resolve input amount and output type from an unconfirmed parent', async (t) => {
  const api = await setup(t);
  const child = await api.get(`/api/transactions/${hash(8)}`);
  assert.equal(child.inputs.items[0].value, '9999999999999998');
  assert.equal(child.inputs.items[0].outputType, 1);
  assert.equal(child.inputs.items[0].pubkey, pubkey);
});

test('HTTP API rejects writes, proxy attempts, unknown routes and invalid parameters', async (t) => {
  const api = await setup(t);
  const foreignAddress = bech32m.encode('cc', [1, ...bech32m.toWords(Buffer.from(pubkey, 'hex'))]);
  const invalid = [
    '/api/blocks?page=0',
    '/api/blocks?page=1.5',
    '/api/blocks?page=1000001',
    '/api/blocks?page=1&page=2',
    '/api/blocks/not-a-block',
    '/api/transactions/invalid',
    `/api/transactions/${hash(1)}?inputsPage=0`,
    `/api/transactions/${hash(1)}?outputsPage=-1`,
    '/api/domain/-bad.example',
    '/api/domain/example..com',
    '/api/bounties?state=invalid',
    '/api/bounties?domain=-bad.example',
    '/api/address/not-an-address',
    `/api/address/${foreignAddress}`,
    '/api/search',
    '/api/search?q=not%20a%20query',
  ];
  for (const path of invalid) await api.get(path, 400);
  for (const path of [
    '/api/unknown',
    '/api/rpc?method=stop',
    '/api/blocks/999',
    `/api/transactions/${hash(999)}`,
  ]) {
    await api.get(path, 404);
  }
  api.rpc.calls = [];
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    const response = await fetch(api.url + '/api/rpc', {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ method: 'sendrawtransaction', params: ['deadbeef'] }),
    });
    assert.equal(response.status, 405);
    assert.match(((await response.json()) as any).error, /read-only/);
  }
  assert.equal(api.rpc.calls.length, 0);
});
