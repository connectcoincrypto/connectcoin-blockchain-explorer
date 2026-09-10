import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IndexStore } from '../src/server/index-store.js';
import { DatabaseSync } from 'node:sqlite';
import { NETWORKS } from '../src/shared/networks.js';

const hash = (n: number): string => n.toString(16).padStart(64, '0');
const pubkey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const keyOutput = (value: string, n = 0) => ({ n: String(n), type: '1', value, pubkey });
const bountyOutput = (value: string, n = 0, domain = 'example.com') => ({
  n: String(n),
  type: '2',
  value,
  domain,
  connection_work_target: '0'.repeat(63) + 'f',
  root_certificates_version: '1',
  signature_algorithms_mask: '6',
});
function transaction(id: number, outputs: any[], inputs?: any[]) {
  return {
    txid: hash(id),
    hash: hash(id + 10000),
    version: '1',
    locktime: '0',
    size: '200',
    vsize: '125',
    weight: '500',
    hex: 'deadbeef',
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
    size: '1200',
    weight: '4000',
    difficulty: '1.234567890123456789',
    version: '1',
    nonce: '42',
    bits: '1d00ffff',
    merkleroot: hash(id + 20000),
    previousblockhash: previous?.hash,
    tx,
  };
}
class MockRpc {
  chain = 'testnet4';
  pruned = false;
  pruneheight = '0';
  failBlock?: string;
  constructor(public blocks: any[]) {}
  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    if (method === 'getblockchaininfo')
      return {
        chain: this.chain,
        blocks: String(this.blocks.length - 1),
        pruned: this.pruned,
        pruneheight: this.pruneheight,
      } as T;
    if (method === 'getblockhash') {
      const found = this.blocks[Number(params[0])];
      if (!found) throw new Error('Block height out of range');
      return found.hash as T;
    }
    if (method === 'getblock') {
      assert.equal(params[1], 2, 'index should request fully decoded block transactions');
      if (params[0] === this.failBlock) throw new Error('RPC unavailable');
      const found = this.blocks.find((item) => item.hash === params[0]);
      if (!found) throw new Error('Block not found');
      return structuredClone(found) as T;
    }
    throw new Error(`Unexpected RPC ${method}`);
  }
}
function chain() {
  const genesis = block(0, 100, [transaction(1, [keyOutput('15.0000000000')])]);
  const creation = transaction(
    2,
    [keyOutput('9.0000000000'), bountyOutput('5.9999999999', 1)],
    [{ txid: hash(1), vout: '0', sequence: '4294967295' }],
  );
  const first = block(1, 101, [transaction(3, [keyOutput('15')]), creation], genesis);
  const redemption = transaction(
    4,
    [keyOutput('5.9999999998')],
    [{ txid: hash(2), vout: '1', sequence: '4294967295', txinwitness: ['aa', 'bb', 'cc'] }],
  );
  const second = block(2, 102, [transaction(5, [keyOutput('15')]), redemption], first);
  return [genesis, first, second];
}

test('indexes typed outputs, exact amounts, witnesses, prevouts, spends and account history', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  try {
    assert.equal(store.overview().height, -1);
    const result = await store.sync(new MockRpc(chain()));
    assert.deepEqual(result, { height: 2, nodeHeight: 2, indexedBlocks: 3 });
    const tx = store.getTransaction(hash(2))!;
    assert.equal(tx.outputs[0].type, 1);
    assert.equal(tx.outputs[1].type, 2);
    assert.equal(tx.outputs[1].value, '59999999999');
    assert.equal(tx.outputs[1].domain, 'example.com');
    assert.equal(tx.outputs[1].signatureAlgorithmsMask, 6);
    assert.equal(tx.inputs[0].value, '150000000000');
    assert.equal(tx.inputs[0].outputType, 1);
    assert.equal(tx.fee, '1');
    assert.deepEqual(tx.outputs[1].spent, { txid: hash(4), inputIndex: 0, confirmed: true });
    assert.ok(!('hex' in tx));
    const spent = store.getTransaction(hash(4))!;
    assert.equal(spent.inputs[0].domain, 'example.com');
    assert.equal(spent.inputs[0].outputType, 2);
    assert.equal(spent.inputs[0].signatureAlgorithmsMask, 6);
    assert.deepEqual(spent.inputs[0].witness, ['aa', 'bb', 'cc']);
    assert.equal(spent.fee, '1');
    const account = store.account('domain', 'EXAMPLE.COM.', 1, 10);
    assert.equal(account.totalReceived, '59999999999');
    assert.equal(account.totalSent, '59999999999');
    assert.equal(account.balance, '0');
    assert.equal(account.unspentCount, 0);
    assert.deepEqual(
      account.transactions.items.map((item) => item.txid),
      [hash(4), hash(2)],
    );
    assert.equal(store.account('address', tx.outputs[0].address!, 1, 10).outputCount, 5);
    assert.equal(store.bounties(1, 10).total, 0);
    assert.equal(store.bounties(1, 10, { state: 'spent', domain: 'EXAMPLE.COM' }).total, 1);
    assert.equal(store.bounties(1, 10, { state: 'all' }).items[0].spent?.txid, hash(4));
    assert.deepEqual(store.overview(), {
      height: 2,
      blockCount: 3,
      transactionCount: 5,
      bountyCount: 1,
      availableBountyCount: 0,
      availableBountyValue: '0',
    });
  } finally {
    store.close();
  }
});

test('reorg removes orphaned spends, transactions and bounties, including a shorter remote tip', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  const original = chain();
  const rpc = new MockRpc(original);
  try {
    await store.sync(rpc);
    const replacement = block(
      2,
      202,
      [transaction(6, [bountyOutput('3', 0, 'another.example')])],
      original[1],
    );
    rpc.blocks = [original[0], original[1], replacement];
    await store.sync(rpc);
    assert.equal(store.getTransaction(hash(4)), undefined);
    assert.equal(store.getBlock(hash(102), 1, 10), undefined);
    assert.equal(store.getTransaction(hash(2))!.outputs[1].spent, undefined);
    assert.equal(store.overview().availableBountyCount, 2);
    assert.equal(store.overview().availableBountyValue, '89999999999');
    assert.equal(store.getBlock('1', 1, 10)!.block.nextHash, hash(202));
    rpc.blocks = original.slice(0, 2);
    assert.deepEqual(await store.sync(rpc), { height: 1, nodeHeight: 1, indexedBlocks: 0 });
    assert.equal(store.getTransaction(hash(6)), undefined);
    assert.equal(store.account('domain', 'another.example', 1, 10).transactions.total, 0);
    assert.equal(store.getBlock('1', 1, 10)!.block.nextHash, undefined);
    assert.equal(store.bounties(1, 10).items[0].txid, hash(2));
  } finally {
    store.close();
  }
});

test('failed batch leaves the old complete index intact and a retry applies the reorg', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  const original = chain();
  const rpc = new MockRpc(original);
  try {
    await store.sync(rpc);
    const fork1 = block(1, 201, [transaction(6, [bountyOutput('3')])], original[0]);
    const fork2 = block(2, 202, [transaction(7, [keyOutput('15')])], fork1);
    rpc.blocks = [original[0], fork1, fork2];
    rpc.failBlock = fork2.hash;
    await assert.rejects(store.sync(rpc), /RPC unavailable/);
    assert.equal(store.getTip()!.hash, original[2].hash);
    assert.ok(store.getTransaction(hash(4)));
    assert.equal(store.getTransaction(hash(6)), undefined);
    rpc.failBlock = undefined;
    await store.sync(rpc);
    assert.equal(store.getTip()!.hash, fork2.hash);
    assert.equal(store.getTransaction(hash(4)), undefined);
  } finally {
    store.close();
  }
});

test('a write failure rolls back both orphan deletion and the partially inserted replacement', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  const original = chain();
  const rpc = new MockRpc(original);
  try {
    await store.sync(rpc);
    const duplicate = transaction(6, [bountyOutput('3')]);
    const invalidFork = block(2, 202, [duplicate, duplicate], original[1]);
    rpc.blocks = [original[0], original[1], invalidFork];
    await assert.rejects(store.sync(rpc), /UNIQUE constraint/);
    assert.equal(store.getTip()!.hash, original[2].hash);
    assert.equal(store.getTransaction(hash(6)), undefined);
    assert.equal(store.getTransaction(hash(2))!.outputs[1].spent!.txid, hash(4));
    assert.equal(store.overview().transactionCount, 5);
  } finally {
    store.close();
  }
});

test('restart resumes in bounded batches and refuses mismatched genesis or network', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'connectcoin-index-test-'));
  const path = join(directory, 'chain.sqlite');
  let store: IndexStore | undefined;
  try {
    const rpc = new MockRpc(chain());
    store = new IndexStore(path, 'testnet4');
    assert.equal((await store.sync(rpc, 1)).height, 0);
    store.close();
    store = new IndexStore(path, 'testnet4');
    assert.equal(store.getTip()!.height, 0);
    assert.equal((await store.sync(rpc, 1)).height, 1);
    assert.equal((await store.sync(rpc, 1)).height, 2);
    assert.equal((await store.sync(rpc)).indexedBlocks, 0);
    store.close();
    store = new IndexStore(path, 'testnet4');
    assert.equal(store.getTransaction(hash(2))!.outputs[1].signatureAlgorithmsMask, 6);
    assert.equal(store.getTransaction(hash(4))!.inputs[0].signatureAlgorithmsMask, 6);
    assert.equal(store.bounties(1, 10, { state: 'all' }).items[0].signatureAlgorithmsMask, 6);
    assert.throws(() => store!.bindNetwork('testnet4', hash(999)), /does not match/);
    assert.throws(() => store!.bindNetwork('main', hash(100)), /does not match/);
    const foreign = block(0, 999, [transaction(999, [keyOutput('15')])]);
    foreign.hash = hash(999);
    await assert.rejects(store.sync(new MockRpc([foreign])), /does not match/);
    assert.equal(store.getTip()!.height, 2);
    assert.throws(() => new IndexStore(path, 'main'), /belongs to testnet4/);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('payload budget defers additional large blocks and verifies the actual committed prefix', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  const blocks = chain();
  // A size-only fixture exercises the budget without allocating large payloads.
  blocks[0].size = String(24 * 1024 * 1024);
  blocks[1].size = String(24 * 1024 * 1024);
  const rpc = new MockRpc(blocks);
  try {
    assert.deepEqual(await store.sync(rpc), { height: 0, nodeHeight: 2, indexedBlocks: 1 });
    assert.equal(store.getTransaction(hash(2)), undefined);
    assert.deepEqual(await store.sync(rpc), { height: 2, nodeHeight: 2, indexedBlocks: 2 });
    assert.equal(store.getTransaction(hash(2))!.outputs[1].spent!.txid, hash(4));
  } finally {
    store.close();
  }
});

test('one oversized block still advances and atomically commits a bounded reorg prefix', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  const original = chain();
  const rpc = new MockRpc(original);
  try {
    await store.sync(rpc);
    const fork1 = block(1, 201, [transaction(6, [bountyOutput('3')])], original[0]);
    fork1.size = String(64 * 1024 * 1024);
    const fork2 = block(2, 202, [transaction(7, [keyOutput('15')])], fork1);
    rpc.blocks = [original[0], fork1, fork2];
    // The following block must not be fetched once the budget has been reached.
    rpc.failBlock = fork2.hash;
    assert.deepEqual(await store.sync(rpc), { height: 1, nodeHeight: 2, indexedBlocks: 1 });
    assert.equal(store.getTip()!.hash, fork1.hash);
    assert.equal(store.getTransaction(hash(4)), undefined);
    assert.equal(store.getTransaction(hash(2)), undefined);
    assert.equal(store.getTransaction(hash(6))!.outputs[0].domain, 'example.com');
    assert.equal(store.getBlock('1', 1, 10)!.block.nextHash, undefined);
    rpc.failBlock = undefined;
    assert.deepEqual(await store.sync(rpc), { height: 2, nodeHeight: 2, indexedBlocks: 1 });
    assert.equal(store.getTip()!.hash, fork2.hash);
  } finally {
    store.close();
  }
});

test('lifetime received and sent exceed signed 64-bit while individual amounts remain valid', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  try {
    // Repeatedly recycling the same bounty makes lifetime flow exceed int64
    // without inventing an output or transaction above Core's MAX_MONEY.
    const blocks = [block(0, 300, [transaction(30, [bountyOutput('99000000.0000000001')])])];
    for (let height = 1; height <= 10; height++) {
      blocks.push(
        block(
          height,
          300 + height,
          [
            transaction(1000 + height, [keyOutput('15')]),
            transaction(
              30 + height,
              [bountyOutput('99000000.0000000001')],
              [{ txid: hash(29 + height), vout: '0', sequence: '4294967295', txinwitness: ['aa'] }],
            ),
          ],
          blocks[height - 1],
        ),
      );
    }
    await store.sync(new MockRpc(blocks));
    assert.equal(store.overview().availableBountyValue, '990000000000000001');
    const account = store.account('domain', 'example.com', 1, 20);
    assert.equal(account.balance, '990000000000000001');
    assert.equal(account.totalReceived, '10890000000000000011');
    assert.equal(account.totalSent, '9900000000000000010');
    assert.equal(account.transactions.total, 11);
    assert.equal(store.getBlock('0', 1, 10)!.transactions.items[0].totalOutput, '990000000000000001');
  } finally {
    store.close();
  }
});

test('pagination is stable and incomplete pruned backfill fails with an actionable error', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  const rpc = new MockRpc(chain());
  try {
    rpc.pruned = true;
    rpc.pruneheight = '1';
    await assert.rejects(store.sync(rpc), /pruned.*archival/i);
    assert.equal(store.getTip(), undefined);
    rpc.pruned = false;
    await store.sync(rpc);
    assert.deepEqual(
      store.listBlocks(2, 2).items.map((item) => item.height),
      [0],
    );
    assert.equal(store.listBlocks(3, 2).total, 3);
    assert.equal(store.listBlocks(3, 2).items.length, 0);
    assert.equal(store.getBlock('1', 2, 1)!.transactions.items[0].txid, hash(2));
    assert.equal(store.account('domain', 'example.com', 2, 1).transactions.items[0].txid, hash(2));
    assert.throws(() => store.listBlocks(0, 10), /positive integer/);
    assert.throws(() => store.bounties(1, 101), /between 1 and 100/);
  } finally {
    store.close();
  }
});

test('an empty index rejects old genesis and wrong-chain RPC before indexing any blocks', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  try {
    const rpc = new MockRpc(chain());
    rpc.blocks[0].hash = '06a1a1f822fed4a412aedb19315f1e85c963ad9b3c10e88ff12626b4b1389115';
    await assert.rejects(store.sync(rpc), /current P2C v2 network/);
    assert.equal(store.getTip(), undefined);
    rpc.blocks = chain();
    rpc.chain = 'test';
    await assert.rejects(store.sync(rpc), /current P2C v2 network/);
    assert.equal(store.overview().transactionCount, 0);
    rpc.chain = 'testnet4';
    await store.sync(rpc);
    assert.equal(store.getTip()!.height, 2);
  } finally {
    store.close();
  }
});

test('opening an old-genesis database refuses cached reads without deleting the preserved index', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'connectcoin-legacy-index-test-'));
  const path = join(directory, 'old-chain.sqlite');
  try {
    const store = new IndexStore(path, 'testnet4');
    await store.sync(new MockRpc(chain()));
    store.close();
    const oldGenesis = '06a1a1f822fed4a412aedb19315f1e85c963ad9b3c10e88ff12626b4b1389115';
    const legacy = new DatabaseSync(path);
    legacy.prepare("UPDATE metadata SET value = ? WHERE key = 'genesis'").run(oldGenesis);
    legacy.close();
    assert.throws(() => new IndexStore(path, 'testnet4'), /Preserve this file.*new --database/);
    const preserved = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(preserved.prepare('SELECT COUNT(*) AS n FROM blocks').get()!.n, 3);
      assert.equal(preserved.prepare('SELECT COUNT(*) AS n FROM transactions').get()!.n, 5);
      assert.equal(
        preserved.prepare("SELECT value FROM metadata WHERE key = 'genesis'").get()!.value,
        oldGenesis,
      );
    } finally {
      preserved.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mainnet cannot bind a historical or invented operational genesis', () => {
  const store = new IndexStore(':memory:', 'main');
  try {
    assert.throws(() => store.bindNetwork('main', hash(100)), /not launched/);
    assert.equal(store.getTip(), undefined);
  } finally {
    store.close();
  }
});
