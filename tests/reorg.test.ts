import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { once } from 'node:events';
import { rootCertificates } from 'node:tls';
import test, { type TestContext } from 'node:test';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import { IndexStore } from '../src/server/index-store.js';
import type { RpcClient } from '../src/server/rpc.js';
import { NETWORKS } from '../src/shared/networks.js';
import type { ExplorerStatus } from '../src/shared/types.js';

// These fixtures exercise explorer consistency, not consensus validity. All RPC
// calls are mocked, the index is in memory, and HTTP listens only on loopback.
const hash = (value: number): string => value.toString(16).padStart(64, '0');
const pubkey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const keyOutput = { n: 0, type: 1, value: '1', pubkey };
const bountyOutput = {
  n: 0,
  type: 2,
  value: '1',
  domain: 'example.com',
  connection_work_target: 'f'.repeat(64),
  root_certificates_version: 1,
  signature_algorithms_mask: 7,
};
function transaction(id: number, vin?: any[], vout = [keyOutput]) {
  return {
    txid: hash(id),
    version: 1,
    locktime: 0,
    size: 200,
    vsize: 125,
    weight: 500,
    vin: vin ?? [{ coinbase: '0000', sequence: 0xffffffff }],
    vout,
  };
}
function block(height: number, id: number, tx: any[], previous?: any) {
  return {
    height,
    hash: height === 0 ? NETWORKS.testnet4.genesis!.hash : hash(id),
    time: 1700000000 + height,
    nTx: tx.length,
    size: 1000,
    weight: 4000,
    difficulty: '1',
    version: 1,
    nonce: 1,
    bits: '1d00ffff',
    merkleroot: hash(id + 10000),
    previousblockhash: previous?.hash,
    tx,
  };
}
const poolEntry = (time = 1700001000) => ({
  time,
  vsize: 125,
  weight: 500,
  fees: { base: '0.0000000001' },
  depends: [],
});
const missing = () => Object.assign(new Error('Transaction not known to the node'), { code: -5 });

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

class MockRpc {
  calls: { method: string; params: unknown[] }[] = [];
  raw = new Map<string, any>();
  rawFailures = new Map<string, Error>();
  pool: Record<string, any> = {};
  spending = new Map<string, string>();
  afterResponse?: (method: string, params: unknown[]) => void | Promise<void>;
  releases: (() => void)[] = [];

  constructor(public blocks: any[]) {}

  pauseNext(method: string, matches: (params: unknown[]) => boolean = () => true) {
    const entered = Promise.withResolvers<void>();
    const resumed = Promise.withResolvers<void>();
    let paused = false;
    this.releases.push(resumed.resolve);
    this.afterResponse = async (called, params) => {
      if (called !== method || !matches(params) || paused) return;
      paused = true;
      entered.resolve();
      await bounded(resumed.promise, `release ${method}`);
    };
    return {
      entered: () => bounded(entered.promise, `enter ${method}`),
      release: resumed.resolve,
    };
  }

  private response(method: string, params: unknown[]): any {
    if (method === 'getblockchaininfo')
      return { chain: 'testnet4', blocks: this.blocks.length - 1, pruned: false };
    if (method === 'getblockhash') return this.blocks[Number(params[0])].hash;
    if (method === 'getblock') {
      const found = this.blocks.find((item) => item.hash === params[0]);
      assert.ok(found, 'mock block must exist');
      return found;
    }
    if (method === 'getrawtransaction') {
      const failure = this.rawFailures.get(String(params[0]));
      if (failure) throw failure;
      const found = this.raw.get(String(params[0]));
      if (!found) throw missing();
      return found;
    }
    if (method === 'getrawmempool') return this.pool;
    if (method === 'getmempoolentry') {
      const found = this.pool[String(params[0])];
      if (!found) throw missing();
      return found;
    }
    if (method === 'gettxspendingprevout')
      return (params[0] as { txid: string; vout: number }[]).map((outpoint) => ({
        ...outpoint,
        ...(this.spending.has(`${outpoint.txid}:${outpoint.vout}`)
          ? { spendingtxid: this.spending.get(`${outpoint.txid}:${outpoint.vout}`) }
          : {}),
      }));
    throw new Error(`Unexpected mock RPC ${method}`);
  }

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    // Snapshot before suspending: later changes cannot silently refresh an old
    // response and conceal a race in the HTTP handler or its shared cache.
    let response: any;
    let failure: unknown;
    try {
      response = structuredClone(this.response(method, params));
    } catch (error) {
      failure = error;
    }
    await this.afterResponse?.(method, params);
    if (failure) throw failure;
    return response as T;
  }
}

async function setup(t: TestContext, included = transaction(2)) {
  const genesis = block(0, 100, [transaction(1)]);
  const rpc = new MockRpc([genesis, block(1, 101, [included], genesis)]);
  const store = new IndexStore(':memory:', 'testnet4');
  const config = readConfig(['--testnet'], {});
  const status: ExplorerStatus = {
    network: 'testnet4',
    chain: 'testnet4',
    title: config.title,
    connected: true,
    indexedHeight: 1,
    nodeHeight: 1,
    syncing: false,
  };
  await store.sync(rpc);
  rpc.calls = [];
  const app = createApp({ config, status, store, rpc: rpc as unknown as RpcClient });
  const server = app.listen(0, '127.0.0.1');
  await bounded(once(server, 'listening'), 'HTTP listen');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    rpc.afterResponse = undefined;
    for (const release of rpc.releases) release();
    server.closeAllConnections();
    try {
      await bounded(
        new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
        'HTTP close',
      );
      await bounded(app.waitForRequests(), 'HTTP handlers drain');
    } finally {
      store.close();
    }
  });
  function get(path: string) {
    const work = (async () => {
      const response = await fetch(url + path, { signal: AbortSignal.timeout(5000) });
      return { status: response.status, body: (await response.json()) as any };
    })();
    // Cleanup can abort a pending fetch after an assertion failure.
    void work.catch(() => {});
    return work;
  }
  async function sync(blocks: any[]) {
    rpc.blocks = blocks;
    const result = await store.sync(rpc);
    status.indexedHeight = result.height;
    status.nodeHeight = result.nodeHeight;
  }
  return { get, rpc, store, genesis, sync };
}

test('in-flight indexed transaction becomes 404 when a reorg detaches it', { timeout: 15000 }, async (t) => {
  const api = await setup(t);
  const gate = api.rpc.pauseNext('gettxspendingprevout');
  const pending = api.get(`/api/transactions/${hash(2)}`);
  await gate.entered();
  await api.sync([api.genesis, block(1, 201, [transaction(3)], api.genesis)]);
  assert.equal(api.store.getTransaction(hash(2)), undefined);
  gate.release();
  const result = await pending;
  assert.equal(result.status, 404, JSON.stringify(result.body));
  assert.equal(result.body.blockHash, undefined);
  assert.equal(result.body.confirmations, undefined);
  assert.equal((await api.get(`/api/transactions/${hash(2)}`)).status, 404);
});

for (const height of [1, 2]) {
  test(
    `in-flight identical transaction uses its replacement block at height ${height}`,
    { timeout: 15000 },
    async (t) => {
      const sameTransaction = transaction(2);
      const api = await setup(t, sameTransaction);
      api.rpc.spending.set(`${hash(2)}:0`, hash(90));
      const gate = api.rpc.pauseNext('gettxspendingprevout');
      const pending = api.get(`/api/transactions/${hash(2)}`);
      await gate.entered();
      const fork = [api.genesis];
      if (height === 2) fork.push(block(1, 201, [transaction(3)], api.genesis));
      const replacement = block(height, 200 + height, [sameTransaction], fork.at(-1));
      fork.push(replacement);
      api.rpc.spending.clear();
      await api.sync(fork);
      gate.release();
      const result = await pending;
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.txid, sameTransaction.txid);
      assert.equal(result.body.blockHash, replacement.hash);
      assert.equal(result.body.height, height);
      assert.equal(result.body.confirmations, 1);
      assert.equal(result.body.time, replacement.time);
      assert.equal(
        result.body.outputs.items[0].spent,
        undefined,
        'old RPC spend overlay must also be retried',
      );
    },
  );
}

for (const readmitted of [false, true]) {
  test(
    `detached transaction falls back to mempool only when node membership is ${readmitted}`,
    { timeout: 15000 },
    async (t) => {
      const sameTransaction = transaction(2);
      const api = await setup(t, sameTransaction);
      // Warm a cache containing the old ID so absence after the reorg cannot be
      // inferred from a cached pre-reorg membership entry.
      api.rpc.pool[hash(2)] = poolEntry();
      assert.equal((await api.get('/api/mempool')).body.total, 1);
      const gate = api.rpc.pauseNext('gettxspendingprevout');
      const pending = api.get(`/api/transactions/${hash(2)}`);
      await gate.entered();
      api.rpc.raw.set(hash(2), sameTransaction);
      api.rpc.pool = readmitted ? { [hash(2)]: poolEntry(1700002000) } : {};
      await api.sync([api.genesis, block(1, 201, [transaction(3)], api.genesis)]);
      gate.release();
      const result = await pending;
      assert.equal(result.status, readmitted ? 200 : 404, JSON.stringify(result.body));
      assert.equal(result.body.blockHash, undefined);
      assert.equal(result.body.height, undefined);
      assert.equal(result.body.confirmations, undefined);
      assert.equal(
        api.store.getTransaction(hash(2)),
        undefined,
        'RPC fallback must not insert a detached transaction into SQLite',
      );
      if (readmitted) {
        assert.equal(result.body.txid, hash(2));
        assert.equal(result.body.fee, '1');
        assert.equal(result.body.time, 1700002000);
      }
      const pool = await api.get('/api/mempool');
      assert.equal(pool.body.total, readmitted ? 1 : 0, 'only the node decides mempool admission');
      assert.ok(
        api.rpc.calls.every(({ method }) => !['sendrawtransaction', 'submitpackage'].includes(method)),
      );
    },
  );
}

// Framed TLS fixture with a public root and placeholder signature. This is a
// decodable display proof, not a valid consensus claim or authenticated session.
function displayProof(txid: string): string {
  const number = (value: number, size: number) => {
    const bytes = Buffer.alloc(size);
    bytes.writeUIntBE(value, 0, size);
    return bytes;
  };
  const concat = (...parts: Buffer[]) => Buffer.concat(parts);
  const vector = (bytes: Buffer, size = 2) => concat(number(bytes.length, size), bytes);
  const extension = (type: number, bytes: Buffer) => concat(number(type, 2), vector(bytes));
  const handshake = (type: number, bytes: Buffer) => concat(number(type, 1), vector(bytes, 3));
  const tag = createHash('sha256').update('ConnectCoin/P2C/claim/v1').digest();
  const challenge = createHash('sha256')
    .update(concat(tag, tag, Buffer.from(txid, 'hex').reverse(), Buffer.alloc(4)))
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
  const certificate = new X509Certificate(rootCertificates[0]).raw;
  return concat(
    Buffer.from([2]),
    handshake(1, client),
    handshake(2, server),
    handshake(8, Buffer.from([0, 0])),
    handshake(11, concat(number(0, 1), vector(concat(vector(certificate, 3), number(0, 2)), 3))),
    handshake(15, concat(number(0x0403, 2), vector(Buffer.from([0x30])))),
  ).toString('hex');
}

for (const knownPrevout of [false, true]) {
  test(
    `proof request cannot return a detached proof after awaiting ${knownPrevout ? 'proof target' : 'input enrichment'}`,
    { timeout: 15000 },
    async (t) => {
      const proofHex = displayProof(hash(2));
      const redemption = transaction(2, [
        {
          txid: hash(50),
          vout: 0,
          sequence: 0xffffffff,
          txinwitness: [proofHex],
          ...(knownPrevout ? { prevout: bountyOutput } : {}),
        },
      ]);
      const api = await setup(t, redemption);
      api.rpc.raw.set(hash(50), { ...transaction(50), vout: [bountyOutput] });
      const path = `/api/transactions/${hash(2)}/proof/0`;
      const baseline = await api.get(path);
      assert.equal(baseline.status, 200, JSON.stringify(baseline.body));
      assert.equal(baseline.body.rawHex, proofHex);
      const gate = api.rpc.pauseNext('getrawtransaction', (params) => params[0] === hash(50));
      const pending = api.get(path);
      await gate.entered();
      await api.sync([api.genesis, block(1, 201, [transaction(3)], api.genesis)]);
      gate.release();
      const result = await pending;
      assert.equal(result.status, 404, JSON.stringify(result.body));
      assert.equal(result.body.rawHex, undefined);
    },
  );
}

test('committed reorg invalidates an already cached mempool snapshot', { timeout: 15000 }, async (t) => {
  const api = await setup(t);
  api.rpc.pool = { [hash(10)]: poolEntry() };
  assert.deepEqual(
    (await api.get('/api/mempool')).body.items.map((item: any) => item.txid),
    [hash(10)],
  );
  api.rpc.pool = { [hash(11)]: poolEntry() };
  await api.sync([api.genesis, block(1, 201, [transaction(3)], api.genesis)]);
  const result = await api.get('/api/mempool');
  assert.equal(result.status, 200);
  assert.deepEqual(
    result.body.items.map((item: any) => item.txid),
    [hash(11)],
  );
  assert.equal(api.rpc.calls.filter(({ method }) => method === 'getrawmempool').length, 2);
});

test(
  'pre-reorg mempool request cannot overwrite a newer completed cache snapshot',
  { timeout: 15000 },
  async (t) => {
    const api = await setup(t);
    api.rpc.pool = { [hash(10)]: poolEntry() };
    const gate = api.rpc.pauseNext('getrawmempool');
    const oldRequest = api.get('/api/mempool');
    await gate.entered();
    api.rpc.pool = { [hash(11)]: poolEntry() };
    await api.sync([api.genesis, block(1, 201, [transaction(3)], api.genesis)]);
    // This request must complete while the old RPC remains blocked; coalescing
    // across revisions would incorrectly tie it to the stale response.
    const fresh = await api.get('/api/mempool');
    assert.equal(fresh.status, 200);
    assert.deepEqual(
      fresh.body.items.map((item: any) => item.txid),
      [hash(11)],
    );
    gate.release();
    const resumed = await oldRequest;
    assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
    assert.deepEqual(
      resumed.body.items.map((item: any) => item.txid),
      [hash(11)],
    );
    const cached = await api.get('/api/mempool');
    assert.deepEqual(
      cached.body.items.map((item: any) => item.txid),
      [hash(11)],
    );
    assert.equal(api.rpc.calls.filter(({ method }) => method === 'getrawmempool').length, 2);
  },
);

test(
  'RPC-only transaction lookup crossing a reorg returns its newly indexed block',
  { timeout: 15000 },
  async (t) => {
    const api = await setup(t);
    const included = transaction(10);
    api.rpc.raw.set(hash(10), included);
    api.rpc.pool = { [hash(10)]: poolEntry() };
    const gate = api.rpc.pauseNext('getrawtransaction', (params) => params[0] === hash(10));
    const pending = api.get(`/api/transactions/${hash(10)}`);
    await gate.entered();
    const replacement = block(1, 201, [included], api.genesis);
    api.rpc.pool = {};
    await api.sync([api.genesis, replacement]);
    gate.release();
    const result = await pending;
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.blockHash, replacement.hash);
    assert.equal(result.body.height, 1);
    assert.equal(result.body.confirmations, 1);
  },
);

test('RPC-only search crossing a reorg rejects an old confirmed lookup', { timeout: 15000 }, async (t) => {
  const api = await setup(t);
  api.rpc.raw.set(hash(10), {
    ...transaction(10),
    blockhash: hash(102),
    confirmations: 1,
    in_active_chain: true,
  });
  const gate = api.rpc.pauseNext('getrawtransaction', (params) => params[0] === hash(10));
  const pending = api.get(`/api/search?q=${hash(10)}`);
  await gate.entered();
  api.rpc.raw.delete(hash(10));
  await api.sync([api.genesis, block(1, 201, [transaction(3)], api.genesis)]);
  gate.release();
  const result = await pending;
  assert.equal(result.status, 404, JSON.stringify(result.body));
  assert.equal(result.body.path, undefined);
});

for (const errorCode of [-5, -28]) {
  test(
    `stale RPC error ${errorCode} is retried when a reorg indexes the requested transaction`,
    { timeout: 15000 },
    async (t) => {
      const api = await setup(t);
      api.rpc.rawFailures.set(hash(10), Object.assign(new Error('Old RPC result'), { code: errorCode }));
      const gate = api.rpc.pauseNext('getrawtransaction', (params) => params[0] === hash(10));
      const pending = api.get(`/api/transactions/${hash(10)}`);
      await gate.entered();
      const replacement = block(1, 201, [transaction(10)], api.genesis);
      await api.sync([api.genesis, replacement]);
      gate.release();
      const result = await pending;
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.blockHash, replacement.hash);
      assert.equal(result.body.confirmations, 1);
    },
  );
}

test(
  'detached RPC transaction with zero confirmations is rejected without in_active_chain',
  { timeout: 15000 },
  async (t) => {
    const api = await setup(t);
    const gate = api.rpc.pauseNext('gettxspendingprevout');
    const pending = api.get(`/api/transactions/${hash(2)}`);
    await gate.entered();
    api.rpc.raw.set(hash(2), { ...transaction(2), blockhash: hash(101), confirmations: 0 });
    await api.sync([api.genesis, block(1, 201, [transaction(3)], api.genesis)]);
    gate.release();
    const result = await pending;
    assert.equal(result.status, 404, JSON.stringify(result.body));
    assert.equal(result.body.blockHash, undefined);
    assert.equal(result.body.confirmations, undefined);
  },
);

test(
  'old mempool completion cannot clear a newer revision pending request',
  { timeout: 15000 },
  async (t) => {
    const api = await setup(t);
    api.rpc.pool = { [hash(10)]: poolEntry() };
    const oldGate = api.rpc.pauseNext('getrawmempool');
    const oldRequest = api.get('/api/mempool');
    await oldGate.entered();
    api.rpc.pool = { [hash(11)]: poolEntry() };
    await api.sync([api.genesis, block(1, 201, [transaction(3)], api.genesis)]);
    const newGate = api.rpc.pauseNext('getrawmempool');
    const newRequest = api.get('/api/mempool');
    await newGate.entered();
    oldGate.release();
    // Drain the resumed old RPC and its retry while the newer RPC is still
    // suspended. The retry should join it, not start a duplicate snapshot.
    await bounded(new Promise<void>((resolve) => setImmediate(resolve)), 'old RPC continuation');
    assert.equal(api.rpc.calls.filter(({ method }) => method === 'getrawmempool').length, 2);
    newGate.release();
    const results = await Promise.all([oldRequest, newRequest]);
    for (const result of results) {
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(
        result.body.items.map((item: any) => item.txid),
        [hash(11)],
      );
    }
    assert.equal(api.rpc.calls.filter(({ method }) => method === 'getrawmempool').length, 2);
  },
);

test('repeated chain changes exhaust a bounded retry budget with 503', { timeout: 15000 }, async (t) => {
  const included = transaction(2);
  const api = await setup(t, included);
  let reorgs = 0;
  api.rpc.afterResponse = async (method) => {
    if (method !== 'gettxspendingprevout') return;
    assert.ok(reorgs < 5, 'HTTP retries must be bounded');
    reorgs++;
    await api.sync([api.genesis, block(1, 300 + reorgs, [included], api.genesis)]);
  };
  const result = await api.get(`/api/transactions/${hash(2)}`);
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(reorgs, 3, 'stop after three unstable response attempts');
  assert.equal(result.body.blockHash, undefined);
  assert.equal(result.body.confirmations, undefined);
  assert.equal(typeof result.body.error, 'string');
});
