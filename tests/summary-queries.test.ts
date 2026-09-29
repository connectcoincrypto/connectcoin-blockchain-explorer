import assert from 'node:assert/strict';
import type { DatabaseSync, StatementSync } from 'node:sqlite';
import test from 'node:test';
import { IndexStore } from '../src/server/index-store.js';
import { NETWORKS } from '../src/shared/networks.js';
import type { TransactionSummary } from '../src/shared/types.js';

// Synthetic explorer fixtures only: all RPC responses are local and every index is in memory.
const hash = (value: number): string => value.toString(16).padStart(64, '0');
const pubkey = '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798';
const keyOutput = (value: string, n = 0) => ({ n, type: 1, value, pubkey });
const bountyOutput = (value: string, n = 0, domain = 'summary.example') => ({
  n,
  type: 2,
  value,
  domain,
  connection_work_target: 'f'.repeat(64),
  root_certificates_version: 1,
  signature_algorithms_mask: 7,
});
const input = (id: number, vout = 0, witness = 'abcd') => ({
  txid: hash(id),
  vout,
  sequence: 0xffffffff,
  txinwitness: [witness],
});
function transaction(id: number, vout: any[], vin?: any[]) {
  return {
    txid: hash(id),
    hash: hash(id + 10000),
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
    difficulty: '1.234567890123456789',
    previousblockhash: previous?.hash,
    // A stale RPC hint must always be replaced by the currently indexed successor.
    nextblockhash: hash(99999),
    tx,
  };
}
class MockRpc {
  constructor(public blocks: ReturnType<typeof block>[]) {}

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    if (method === 'getblockchaininfo')
      return { chain: 'testnet4', blocks: this.blocks.length - 1, pruned: false } as T;
    if (method === 'getblockhash') {
      const found = this.blocks[Number(params[0])];
      assert.ok(found, 'requested mock height must exist');
      return found.hash as T;
    }
    if (method === 'getblock') {
      assert.equal(params[1], 2);
      const found = this.blocks.find((item) => item.hash === params[0]);
      assert.ok(found, 'requested mock block must exist');
      return structuredClone(found) as T;
    }
    throw new Error(`Unexpected mock RPC ${method}`);
  }
}

interface ReadQuery {
  sql: string;
  method: 'all' | 'get' | 'iterate';
  rowBytes: number;
  rows: { keys: string[]; transactionData: boolean; witness: boolean }[];
}
const database = (store: IndexStore): DatabaseSync => (store as unknown as { db: DatabaseSync }).db;

// Observe actual SQLite results, including streaming reads, before the application maps
// them. Response-only assertions would miss SELECT * allocating and discarding full JSON.
function measure<T>(store: IndexStore, action: () => T) {
  const db = database(store);
  const originalPrepare = db.prepare;
  const queries: ReadQuery[] = [];
  db.prepare = function (sql: string): StatementSync {
    const statement = originalPrepare.call(db, sql);
    return new Proxy(statement, {
      get(target, property) {
        const method = Reflect.get(target, property, target);
        if (property !== 'all' && property !== 'get' && property !== 'iterate')
          return typeof method === 'function' ? method.bind(target) : method;
        return (...args: unknown[]) => {
          const query: ReadQuery = { sql, method: property, rowBytes: 0, rows: [] };
          queries.push(query);
          const record = (row: Record<string, unknown>) => {
            const json = JSON.stringify(row);
            query.rowBytes += Buffer.byteLength(json);
            query.rows.push({
              keys: Object.keys(row),
              transactionData:
                typeof row.data === 'string' &&
                row.data.includes('"inputs":') &&
                row.data.includes('"outputs":'),
              witness: json.includes('witness'),
            });
          };
          const result = Reflect.apply(method, target, args);
          if (property === 'iterate')
            return (function* () {
              for (const row of result as Iterable<Record<string, unknown>>) {
                record(row);
                yield row;
              }
            })();
          const rows =
            property === 'all'
              ? (result as Record<string, unknown>[])
              : result === undefined
                ? []
                : [result as Record<string, unknown>];
          for (const row of rows) record(row);
          return result;
        };
      },
    });
  };
  try {
    const value = action();
    return { value, queries, rowBytes: queries.reduce((sum, query) => sum + query.rowBytes, 0) };
  } finally {
    db.prepare = originalPrepare;
  }
}

function assertSummaryReads(queries: ReadQuery[]) {
  for (const query of queries) {
    assert.doesNotMatch(query.sql, /\bSELECT\s+(?:[a-z_]\w*\.)?\*/i, query.sql);
    for (const row of query.rows) {
      assert.equal(row.transactionData, false, `transaction JSON materialized by ${query.sql}`);
      assert.equal(row.witness, false, `witness materialized by ${query.sql}`);
      if (row.keys.includes('total_output')) {
        assert.ok(!row.keys.includes('data'), 'summary SQL must not select transactions.data');
        for (const name of ['txid', 'height', 'time', 'input_count', 'output_count', 'p2c_count', 'fee'])
          assert.ok(row.keys.includes(name), `missing summary SQL column ${name}`);
      }
    }
  }
}

test('20 large witness transactions stay out of block and account summary SQL rows', async (t) => {
  const store = new IndexStore(':memory:', 'testnet4');
  try {
    const witness = 'ab'.repeat(1024 * 1024); // 1 MiB of bytes, represented by 2 MiB of hex.
    const genesis = block(0, 1000, [
      transaction(
        1,
        Array.from({ length: 20 }, (_, n) => keyOutput('900719.9254740993', n)),
      ),
    ]);
    const transactions = Array.from({ length: 20 }, (_, n) =>
      transaction(
        100 + n,
        [bountyOutput('900719.9254740991'), keyOutput('0.0000000001', 1)],
        [input(1, n, witness)],
      ),
    );
    const large = block(1, 1001, transactions, genesis);
    const rpc = new MockRpc([genesis, large]);
    await store.sync(rpc, 1);
    await store.sync(rpc, 1);
    const expected: TransactionSummary[] = transactions.map((tx) => ({
      txid: tx.txid,
      height: 1,
      time: large.time,
      totalOutput: '9007199254740992',
      inputCount: 1,
      outputCount: 2,
      p2cCount: 1,
      fee: '1',
    }));
    const legacy = measure(
      store,
      () =>
        database(store)
          .prepare('SELECT * FROM transactions WHERE height = ? ORDER BY position LIMIT ? OFFSET ?')
          .all(1, 20, 0).length,
    );
    assert.equal(legacy.value, 20);
    assert.ok(legacy.rowBytes > 40 * 1024 * 1024);
    assert.ok(legacy.queries[0].rows.every((row) => row.transactionData && row.witness));

    const blockRead = measure(store, () => store.getBlock('1', 1, 20)!);
    assert.equal(blockRead.queries.length, 2);
    assertSummaryReads(blockRead.queries);
    assert.deepEqual(blockRead.value.transactions, { items: expected, total: 20, page: 1, pageSize: 20 });
    assert.equal(blockRead.value.block.nextHash, undefined);
    assert.ok(blockRead.rowBytes < 16 * 1024);

    const accountRead = measure(store, () => store.account('domain', 'SUMMARY.EXAMPLE.', 1, 20));
    assert.equal(accountRead.queries.length, 3);
    assertSummaryReads(accountRead.queries);
    assert.deepEqual(accountRead.value, {
      query: 'SUMMARY.EXAMPLE.',
      kind: 'domain',
      balance: '180143985094819820',
      totalReceived: '180143985094819820',
      totalSent: '0',
      outputCount: 20,
      unspentCount: 20,
      transactions: { items: [...expected].reverse(), total: 20, page: 1, pageSize: 20 },
    });
    assert.ok(accountRead.rowBytes < 16 * 1024);
    assert.doesNotMatch(JSON.stringify([blockRead.value, accountRead.value]), /witness|"inputs"|"outputs"/);
    assert.deepEqual(store.getTransaction(hash(100))!.inputs[0].witness, [witness]);
    t.diagnostic(
      JSON.stringify({
        fixture: '20 transactions, each with a 1 MiB binary witness encoded as hex',
        legacyTransactionSqlRowBytes: legacy.rowBytes,
        block: {
          queries: blockRead.queries.length,
          sqlRowBytes: blockRead.rowBytes,
          responseBytes: Buffer.byteLength(JSON.stringify(blockRead.value)),
        },
        account: {
          queries: accountRead.queries.length,
          sqlRowBytes: accountRead.rowBytes,
          responseBytes: Buffer.byteLength(JSON.stringify(accountRead.value)),
        },
      }),
    );
  } finally {
    store.close();
  }
});

test('block listing performs two reads for every page size, including empty and out-of-range pages', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  try {
    const empty = measure(store, () => store.listBlocks(1, 20));
    assert.equal(empty.queries.length, 2);
    assert.deepEqual(empty.value, { items: [], total: 0, page: 1, pageSize: 20 });
    const emptyOverview = measure(store, () => store.overview());
    assert.equal(emptyOverview.queries.length, 2);
    assert.deepEqual(emptyOverview.value, {
      height: -1,
      blockCount: 0,
      transactionCount: 0,
      bountyCount: 0,
      availableBountyCount: 0,
      availableBountyValue: '0',
    });
    const blocks: ReturnType<typeof block>[] = [];
    for (let height = 0; height < 7; height++)
      blocks.push(block(height, 1000 + height, [transaction(height + 1, [keyOutput('1')])], blocks.at(-1)));
    await store.sync(new MockRpc(blocks));
    const overview = measure(store, () => store.overview());
    assert.equal(overview.queries.length, 2);
    assert.deepEqual(overview.value, {
      height: 6,
      blockCount: 7,
      transactionCount: 7,
      bountyCount: 0,
      availableBountyCount: 0,
      availableBountyValue: '0',
    });
    for (const pageSize of [1, 3, 7, 20, 100]) {
      const read = measure(store, () => store.listBlocks(1, pageSize));
      assert.equal(read.queries.length, 2, `pageSize ${pageSize}`);
      assertSummaryReads(read.queries);
      assert.deepEqual(
        read.value.items.map((item) => item.hash),
        [...blocks]
          .reverse()
          .slice(0, pageSize)
          .map((item) => item.hash),
      );
      assert.equal(read.value.total, 7);
      for (const item of read.value.items) assert.equal(item.nextHash, blocks[item.height + 1]?.hash);
    }
    const second = measure(store, () => store.listBlocks(2, 3));
    assert.equal(second.queries.length, 2);
    assert.deepEqual(
      second.value.items.map((item) => item.height),
      [3, 2, 1],
    );
    const beyond = measure(store, () => store.listBlocks(4, 3));
    assert.equal(beyond.queries.length, 2);
    assert.deepEqual(beyond.value, { items: [], total: 7, page: 4, pageSize: 3 });
  } finally {
    store.close();
  }
});

test('block summaries preserve transaction order, optional fees, and pagination without payload reads', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  try {
    const genesis = block(0, 1000, [transaction(1, [keyOutput('3')])]);
    const first = block(
      1,
      1001,
      [
        transaction(2, [keyOutput('2.9999999999')], [input(1)]),
        transaction(3, [bountyOutput('1')]),
        transaction(4, [keyOutput('1')]),
      ],
      genesis,
    );
    const empty = block(2, 1002, [], first);
    await store.sync(new MockRpc([genesis, first, empty]));
    for (const lookup of ['1', first.hash]) {
      const read = measure(store, () => store.getBlock(lookup, 1, 2)!);
      assert.equal(read.queries.length, 2);
      assertSummaryReads(read.queries);
      assert.deepEqual(read.value.transactions.items, [
        {
          txid: hash(2),
          height: 1,
          time: first.time,
          totalOutput: '29999999999',
          inputCount: 1,
          outputCount: 1,
          p2cCount: 0,
          fee: '1',
        },
        {
          txid: hash(3),
          height: 1,
          time: first.time,
          totalOutput: '10000000000',
          inputCount: 1,
          outputCount: 1,
          p2cCount: 1,
        },
      ]);
      assert.equal(read.value.transactions.total, 3);
      assert.equal(read.value.block.nextHash, empty.hash);
    }
    const second = measure(store, () => store.getBlock('1', 2, 2)!);
    assert.equal(second.queries.length, 2);
    assert.equal(second.value.transactions.page, 2);
    assert.deepEqual(
      second.value.transactions.items.map((item) => item.txid),
      [hash(4)],
    );
    const beyond = measure(store, () => store.getBlock('1', 3, 2)!);
    assert.equal(beyond.queries.length, 2);
    assert.deepEqual(beyond.value.transactions, { items: [], total: 3, page: 3, pageSize: 2 });
    const noTransactions = measure(store, () => store.getBlock(empty.hash, 1, 10)!);
    assert.equal(noTransactions.queries.length, 2);
    assert.deepEqual(noTransactions.value.transactions, { items: [], total: 0, page: 1, pageSize: 10 });
    for (const lookup of ['999', hash(999)]) {
      const missing = measure(store, () => store.getBlock(lookup, 1, 10));
      assert.equal(missing.value, undefined);
      assert.equal(missing.queries.length, 1);
    }
  } finally {
    store.close();
  }
});

test('account summaries count distinct receives and spends and retain totals beyond the last page', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  try {
    const genesis = block(0, 1000, [transaction(1, [bountyOutput('9.0000000003')])]);
    const first = block(
      1,
      1001,
      [
        transaction(2, [bountyOutput('4.0000000001'), bountyOutput('5.0000000001', 1)], [input(1)]),
        transaction(3, [keyOutput('4')], [input(2)]),
        transaction(4, [keyOutput('5')], [input(2, 1)]),
      ],
      genesis,
    );
    await store.sync(new MockRpc([genesis, first]));
    for (const [page, ids] of [
      [1, [4, 3]],
      [2, [2, 1]],
      [3, []],
    ] as const) {
      const read = measure(store, () => store.account('domain', 'SUMMARY.EXAMPLE.', page, 2));
      assert.equal(read.queries.length, 3);
      assertSummaryReads(read.queries);
      assert.equal(read.value.balance, '0');
      assert.equal(read.value.totalReceived, '180000000005');
      assert.equal(read.value.totalSent, '180000000005');
      assert.equal(read.value.outputCount, 3);
      assert.equal(read.value.unspentCount, 0);
      assert.equal(read.value.transactions.total, 4);
      assert.equal(read.value.transactions.page, page);
      assert.equal(read.value.transactions.pageSize, 2);
      assert.deepEqual(
        read.value.transactions.items.map((item) => item.txid),
        ids.map(hash),
      );
      for (const item of read.value.transactions.items)
        assert.equal(item.fee, item.txid === hash(1) ? undefined : '1');
    }
    const address = store.getTransaction(hash(3))!.outputs[0].address!;
    const addressRead = measure(store, () => store.account('address', address, 1, 10));
    assert.equal(addressRead.queries.length, 3);
    assertSummaryReads(addressRead.queries);
    assert.equal(addressRead.value.totalReceived, '90000000000');
    assert.equal(addressRead.value.transactions.total, 2);
    assert.deepEqual(
      addressRead.value.transactions.items.map((item) => item.txid),
      [hash(4), hash(3)],
    );
    const missing = measure(store, () => store.account('domain', 'missing.example', 2, 2));
    assert.equal(missing.queries.length, 3);
    assertSummaryReads(missing.queries);
    assert.deepEqual(missing.value, {
      query: 'missing.example',
      kind: 'domain',
      balance: '0',
      totalReceived: '0',
      totalSent: '0',
      outputCount: 0,
      unspentCount: 0,
      transactions: { items: [], total: 0, page: 2, pageSize: 2 },
    });
  } finally {
    store.close();
  }
});

test('joined next hashes follow replacement blocks and disappear after a shorter canonical tip', async () => {
  const store = new IndexStore(':memory:', 'testnet4');
  try {
    const genesis = block(0, 1000, [transaction(1, [keyOutput('1')])]);
    const original = block(1, 1001, [transaction(2, [keyOutput('1')])], genesis);
    const tip = block(2, 1002, [transaction(3, [keyOutput('1')])], original);
    const rpc = new MockRpc([genesis, original, tip]);
    await store.sync(rpc);
    const verify = () => {
      const list = measure(store, () => store.listBlocks(1, 20));
      assert.equal(list.queries.length, 2);
      for (const item of list.value.items) {
        const detail = measure(store, () => store.getBlock(item.hash, 1, 10)!);
        assert.equal(detail.queries.length, 2);
        assert.equal(item.nextHash, rpc.blocks[item.height + 1]?.hash);
        assert.deepEqual(detail.value.block, item);
      }
      assert.equal(
        list.value.items[0].nextHash,
        undefined,
        'stale RPC successor must not survive at the tip',
      );
    };
    verify();
    const replacement = block(1, 2001, [transaction(4, [keyOutput('1')])], genesis);
    const replacementTip = block(2, 2002, [transaction(5, [keyOutput('1')])], replacement);
    rpc.blocks = [genesis, replacement, replacementTip];
    await store.sync(rpc);
    verify();
    assert.equal(store.getBlock(original.hash, 1, 10), undefined);
    assert.equal(store.getBlock(tip.hash, 1, 10), undefined);
    rpc.blocks = [genesis, replacement];
    await store.sync(rpc);
    verify();
    assert.equal(store.getBlock(replacementTip.hash, 1, 10), undefined);
    rpc.blocks = [genesis];
    await store.sync(rpc);
    verify();
  } finally {
    store.close();
  }
});
