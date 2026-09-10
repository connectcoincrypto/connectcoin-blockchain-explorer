import { DatabaseSync } from 'node:sqlite';
import type {
  AccountSummary,
  BlockSummary,
  Bounty,
  IndexOverview,
  Network,
  Page,
  Transaction,
  TransactionSummary,
} from '../shared/types.js';
import { normalizeBlock, normalizeTransaction, safeInteger } from './normalize.js';
import { NETWORKS } from '../shared/networks.js';

interface Rpc {
  call<T = any>(method: string, params?: unknown[]): Promise<T>;
}
interface Tip {
  height: number;
  hash: string;
}
interface IndexedBlock {
  block: BlockSummary;
  transactions: Transaction[];
}
// Bound retained batch payload, not valid block size. One complete block may
// exceed this budget; decoding also temporarily holds the current RPC response.
const MAX_SYNC_BATCH_BYTES = 32 * 1024 * 1024;
interface TxRow {
  txid: string;
  height: number;
  time: number;
  data: string;
  total_output: string;
  input_count: number;
  output_count: number;
  p2c_count: number;
  fee: string | null;
}

function pagination(page: number, pageSize: number): { page: number; pageSize: number; offset: number } {
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Page must be a positive integer.');
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new Error('Page size must be between 1 and 100.');
  }
  const offset = (page - 1) * pageSize;
  if (!Number.isSafeInteger(offset)) throw new Error('Page is out of range.');
  return { page, pageSize, offset };
}

function summary(row: TxRow): TransactionSummary {
  return {
    txid: row.txid,
    height: row.height,
    time: row.time,
    totalOutput: row.total_output,
    inputCount: row.input_count,
    outputCount: row.output_count,
    p2cCount: row.p2c_count,
    ...(row.fee === null ? {} : { fee: row.fee }),
  };
}

/** Confirmed-chain index. Amounts are TEXT in SQLite and summed exclusively with BigInt. */
export class IndexStore {
  private readonly db: DatabaseSync;
  private syncing = false;

  constructor(
    path: string,
    private readonly network: Network,
  ) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS blocks (
        height INTEGER PRIMARY KEY, hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS transactions (
        txid TEXT PRIMARY KEY, height INTEGER NOT NULL REFERENCES blocks(height) ON DELETE CASCADE,
        position INTEGER NOT NULL, time INTEGER NOT NULL, data TEXT NOT NULL,
        total_output TEXT NOT NULL, input_count INTEGER NOT NULL, output_count INTEGER NOT NULL,
        p2c_count INTEGER NOT NULL, fee TEXT
      );
      CREATE INDEX IF NOT EXISTS transactions_height ON transactions(height DESC, position);
      CREATE TABLE IF NOT EXISTS outputs (
        txid TEXT NOT NULL REFERENCES transactions(txid) ON DELETE CASCADE,
        output_index INTEGER NOT NULL, value TEXT NOT NULL, type INTEGER NOT NULL,
        address TEXT, pubkey TEXT, domain TEXT, data TEXT NOT NULL,
        PRIMARY KEY (txid, output_index)
      );
      CREATE INDEX IF NOT EXISTS outputs_address ON outputs(address);
      CREATE INDEX IF NOT EXISTS outputs_domain ON outputs(domain);
      CREATE INDEX IF NOT EXISTS outputs_type ON outputs(type);
      CREATE TABLE IF NOT EXISTS inputs (
        txid TEXT NOT NULL REFERENCES transactions(txid) ON DELETE CASCADE,
        input_index INTEGER NOT NULL, prev_txid TEXT, prev_vout INTEGER,
        PRIMARY KEY (txid, input_index)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS inputs_prevout ON inputs(prev_txid, prev_vout)
        WHERE prev_txid IS NOT NULL;
    `);
    const existing = this.metadata('network');
    if (existing && existing !== network) {
      this.db.close();
      throw new Error(
        `Index belongs to ${existing}, not ${network}. Use a separate index database for each network.`,
      );
    }
    // Never serve an explicitly selected pre-reset index as the current chain,
    // even while RPC is offline. Keep its blocks and balances untouched.
    const expected = NETWORKS[network];
    const storedGenesis = this.metadata('genesis');
    const storedChain = this.metadata('chain');
    const firstBlock = this.db.prepare('SELECT hash FROM blocks WHERE height = 0').get() as
      { hash: string } | undefined;
    if (
      (storedChain && storedChain !== expected.chain) ||
      (storedGenesis && storedGenesis !== expected.genesis?.hash) ||
      (firstBlock && firstBlock.hash !== expected.genesis?.hash)
    ) {
      this.db.close();
      throw new Error(
        'Index genesis or chain does not match the current P2C v2 network (signature-mask reset). Preserve this file and choose a new --database path, or remove the database override to use the genesis-specific default.',
      );
    }
    this.db.prepare('INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)').run('network', network);
  }

  private metadata(key: string): string | undefined {
    return (
      this.db.prepare('SELECT value FROM metadata WHERE key = ?').get(key) as { value: string } | undefined
    )?.value;
  }

  bindNetwork(chain: string, genesis: string): void {
    if (!chain || !genesis) throw new Error('RPC did not identify its chain and genesis block.');
    const expected = NETWORKS[this.network];
    if (!expected.genesis) throw new Error('Mainnet has no operational genesis and is not launched.');
    if (chain !== expected.chain || genesis !== expected.genesis.hash) {
      throw new Error(
        'RPC chain or genesis does not match the current P2C v2 network (signature-mask reset). Upgrade the node to the matching chain.',
      );
    }
    const storedChain = this.metadata('chain');
    const storedGenesis = this.metadata('genesis');
    if ((storedChain && storedChain !== chain) || (storedGenesis && storedGenesis !== genesis)) {
      throw new Error(
        'RPC chain or genesis does not match this index. Use a separate index database for the other network.',
      );
    }
    this.transaction(() => {
      const put = this.db.prepare('INSERT OR IGNORE INTO metadata(key, value) VALUES (?, ?)');
      put.run('chain', chain);
      put.run('genesis', genesis);
    });
  }

  private transaction(action: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      action();
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  getTip(): Tip | undefined {
    return this.db
      .prepare('SELECT height, hash FROM blocks ORDER BY height DESC LIMIT 1')
      .get() as unknown as Tip | undefined;
  }

  /** Fetch first, then commit the entire batch and any rollback atomically. */
  async sync(rpc: Rpc, limit = 25): Promise<{ height: number; nodeHeight: number; indexedBlocks: number }> {
    if (this.syncing) throw new Error('Index synchronization is already running.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new Error('Sync batch must be between 1 and 1000 blocks.');
    this.syncing = true;
    try {
      const info = await rpc.call('getblockchaininfo');
      const nodeHeight = safeInteger(info.blocks, 'blockchain height');
      if (nodeHeight < 0) throw new Error('RPC has no genesis block yet.');
      const genesis = await rpc.call<string>('getblockhash', [0]);
      this.bindNetwork(String(info.chain ?? ''), genesis);
      const tip = this.getTip();
      let ancestor = Math.min(tip?.height ?? -1, nodeHeight);
      let ancestorHash: string | undefined;
      while (ancestor >= 0) {
        const local = this.db.prepare('SELECT hash FROM blocks WHERE height = ?').get(ancestor) as
          { hash: string } | undefined;
        const remoteHash = ancestor === 0 ? genesis : await rpc.call<string>('getblockhash', [ancestor]);
        if (local?.hash === remoteHash) {
          ancestorHash = remoteHash;
          break;
        }
        ancestor--;
      }
      const requestedEnd = Math.min(nodeHeight, ancestor + limit);
      if (
        info.pruned &&
        ancestor < requestedEnd &&
        safeInteger(info.pruneheight ?? 0, 'prune height') > ancestor + 1
      ) {
        throw new Error(
          `Cannot backfill block ${ancestor + 1}: the node is pruned. Connect to an archival node with the complete blockchain.`,
        );
      }
      const pending: IndexedBlock[] = [];
      let pendingBytes = 0;
      let previousHash = ancestorHash;
      for (let height = ancestor + 1; height <= requestedEnd; height++) {
        const hash = height === 0 ? genesis : await rpc.call<string>('getblockhash', [height]);
        let raw: any;
        try {
          raw = await rpc.call('getblock', [hash, 2]);
        } catch (error) {
          if (info.pruned) {
            throw new Error(
              `Cannot read block ${height} from this pruned node. A full archival blockchain is required.`,
              { cause: error },
            );
          }
          throw error;
        }
        const block = normalizeBlock(raw, this.network);
        if (
          block.hash !== hash ||
          block.height !== height ||
          (height > 0 && block.previousHash !== previousHash)
        ) {
          throw new Error(
            'The node chain changed during indexing, or returned an inconsistent block. Retry synchronization.',
          );
        }
        // Defer a large next block before allocating its normalized copy. Every
        // sync can still make progress when one block alone exceeds the budget.
        if (pending.length && pendingBytes + block.size > MAX_SYNC_BATCH_BYTES) break;
        if (!Array.isArray(raw.tx) || raw.tx.some((tx: unknown) => !tx || typeof tx !== 'object')) {
          throw new Error('RPC getblock(hash, 2) must return decoded transactions.');
        }
        const transactions: Transaction[] = [];
        let normalizedBytes = Buffer.byteLength(JSON.stringify(block));
        let deferred = false;
        for (const rawTransaction of raw.tx) {
          const tx = normalizeTransaction(rawTransaction, this.network, {
            height,
            blockHash: hash,
            time: block.time,
          });
          // Count per transaction so measuring a large block does not create
          // another full-block JSON string. Witness hex expansion is included.
          normalizedBytes += Buffer.byteLength(JSON.stringify(tx));
          if (pending.length && pendingBytes + normalizedBytes > MAX_SYNC_BATCH_BYTES) {
            deferred = true;
            break;
          }
          transactions.push(tx);
        }
        if (deferred) break;
        if (transactions.length !== block.txCount)
          throw new Error(`RPC block ${height} has an inconsistent transaction count.`);
        pending.push({ block, transactions });
        pendingBytes += Math.max(block.size, normalizedBytes);
        previousHash = hash;
        if (pendingBytes >= MAX_SYNC_BATCH_BYTES) break;
      }
      // A second check catches a reorg while the batch was being downloaded.
      const end = pending.at(-1)?.block.height ?? ancestor;
      if (end >= 0) {
        const expectedHash = pending.at(-1)?.block.hash ?? ancestorHash;
        if ((await rpc.call<string>('getblockhash', [end])) !== expectedHash) {
          throw new Error('The node chain changed during indexing. Retry synchronization.');
        }
      }
      if ((tip?.height ?? -1) > ancestor || pending.length) {
        this.transaction(() => {
          this.db.prepare('DELETE FROM blocks WHERE height > ?').run(ancestor);
          for (const block of pending) this.insertBlock(block);
        });
      }
      return { height: this.getTip()?.height ?? -1, nodeHeight, indexedBlocks: pending.length };
    } finally {
      this.syncing = false;
    }
  }

  private insertBlock({ block, transactions }: IndexedBlock): void {
    this.db
      .prepare('INSERT INTO blocks(height, hash, data) VALUES (?, ?, ?)')
      .run(block.height, block.hash, JSON.stringify(block));
    const insertTx = this.db.prepare(`INSERT INTO transactions
      (txid, height, position, time, data, total_output, input_count, output_count, p2c_count, fee)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertOutput = this.db.prepare(`INSERT INTO outputs
      (txid, output_index, value, type, address, pubkey, domain, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertInput = this.db.prepare(
      'INSERT INTO inputs(txid, input_index, prev_txid, prev_vout) VALUES (?, ?, ?, ?)',
    );
    const prevout = this.db.prepare('SELECT value FROM outputs WHERE txid = ? AND output_index = ?');
    for (const [position, tx] of transactions.entries()) {
      let total = 0n;
      for (const output of tx.outputs) {
        const amount = BigInt(output.value);
        if (amount < 0n) throw new Error(`Negative output amount in ${tx.txid}.`);
        total += amount;
      }
      if (
        tx.fee === undefined &&
        tx.inputs.length &&
        tx.inputs.every((input) => input.coinbase === undefined)
      ) {
        let received = 0n;
        let complete = true;
        for (const input of tx.inputs) {
          const previous =
            input.txid !== undefined && input.vout !== undefined
              ? (prevout.get(input.txid, input.vout) as { value: string } | undefined)
              : undefined;
          if (!previous) {
            complete = false;
            break;
          }
          received += BigInt(previous.value);
        }
        if (complete && received >= total) tx.fee = (received - total).toString();
      }
      insertTx.run(
        tx.txid,
        block.height,
        position,
        block.time,
        JSON.stringify(tx),
        total.toString(),
        tx.inputs.length,
        tx.outputs.length,
        tx.outputs.filter((output) => output.type === 2).length,
        tx.fee ?? null,
      );
      for (const output of tx.outputs) {
        // Spend state is derived from the indexed chain, never retained from an RPC snapshot.
        const { spent: _spent, ...storedOutput } = output;
        insertOutput.run(
          tx.txid,
          output.index,
          output.value,
          output.type,
          output.address ?? null,
          output.pubkey ?? null,
          output.domain ?? null,
          JSON.stringify(storedOutput),
        );
      }
      for (const input of tx.inputs)
        insertInput.run(tx.txid, input.index, input.txid ?? null, input.vout ?? null);
    }
  }

  getTransaction(txid: string): Transaction | undefined {
    const row = this.db.prepare('SELECT data FROM transactions WHERE txid = ?').get(txid) as
      { data: string } | undefined;
    if (!row) return undefined;
    const tx: Transaction = JSON.parse(row.data);
    const inputs = new Map(tx.inputs.map((input) => [input.index, input]));
    for (const prev of this.db
      .prepare(
        `SELECT i.input_index, o.value, o.type, o.address, o.pubkey, o.domain, o.data
      FROM inputs i JOIN outputs o ON o.txid = i.prev_txid AND o.output_index = i.prev_vout WHERE i.txid = ?`,
      )
      .iterate(txid)) {
      const input = inputs.get(Number(prev.input_index));
      if (!input) continue;
      input.value = String(prev.value);
      input.outputType = Number(prev.type);
      if (prev.address !== null) input.address = String(prev.address);
      if (prev.pubkey !== null) input.pubkey = String(prev.pubkey);
      if (prev.domain !== null) input.domain = String(prev.domain);
      const mask = JSON.parse(String(prev.data)).signatureAlgorithmsMask;
      if (mask !== undefined) input.signatureAlgorithmsMask = mask;
    }
    const outputs = new Map(
      tx.outputs.map((output) => {
        delete output.spent;
        return [output.index, output] as const;
      }),
    );
    for (const spent of this.db
      .prepare(`SELECT prev_vout, txid, input_index FROM inputs WHERE prev_txid = ?`)
      .iterate(txid)) {
      const output = outputs.get(Number(spent.prev_vout));
      if (output)
        output.spent = { txid: String(spent.txid), inputIndex: Number(spent.input_index), confirmed: true };
    }
    return tx;
  }

  private blockFromRow(row: { height: number; data: string }): BlockSummary {
    const block: BlockSummary = JSON.parse(row.data);
    const next = this.db.prepare('SELECT hash FROM blocks WHERE height = ?').get(row.height + 1) as
      { hash: string } | undefined;
    if (next) block.nextHash = next.hash;
    else delete block.nextHash;
    return block;
  }

  listBlocks(page: number, pageSize: number): Page<BlockSummary> {
    const p = pagination(page, pageSize);
    const total = Number(this.db.prepare('SELECT COUNT(*) AS n FROM blocks').get()!.n);
    const rows = this.db
      .prepare('SELECT height, data FROM blocks ORDER BY height DESC LIMIT ? OFFSET ?')
      .all(p.pageSize, p.offset) as unknown as { height: number; data: string }[];
    return { items: rows.map((row) => this.blockFromRow(row)), total, page, pageSize };
  }

  getBlock(
    hashOrHeight: string,
    page: number,
    pageSize: number,
  ): { block: BlockSummary; transactions: Page<TransactionSummary> } | undefined {
    const p = pagination(page, pageSize);
    const isHeight = /^\d{1,15}$/.test(hashOrHeight);
    const row = this.db
      .prepare(`SELECT height, data FROM blocks WHERE ${isHeight ? 'height' : 'hash'} = ?`)
      .get(isHeight ? Number(hashOrHeight) : hashOrHeight) as { height: number; data: string } | undefined;
    if (!row) return undefined;
    const rows = this.db
      .prepare('SELECT * FROM transactions WHERE height = ? ORDER BY position LIMIT ? OFFSET ?')
      .all(row.height, p.pageSize, p.offset) as unknown as TxRow[];
    const block = this.blockFromRow(row);
    return { block, transactions: { items: rows.map(summary), total: block.txCount, page, pageSize } };
  }

  overview(): IndexOverview {
    const counts = this.db
      .prepare(
        `SELECT
      (SELECT COUNT(*) FROM blocks) AS blocks,
      (SELECT COUNT(*) FROM transactions) AS transactions,
      (SELECT COUNT(*) FROM outputs WHERE type = 2) AS bounties`,
      )
      .get()!;
    let availableBountyCount = 0;
    let value = 0n;
    for (const row of this.db
      .prepare(
        `SELECT o.value FROM outputs o WHERE o.type = 2 AND NOT EXISTS
      (SELECT 1 FROM inputs i WHERE i.prev_txid = o.txid AND i.prev_vout = o.output_index)`,
      )
      .iterate()) {
      availableBountyCount++;
      value += BigInt(String(row.value));
    }
    return {
      height: this.getTip()?.height ?? -1,
      blockCount: Number(counts.blocks),
      transactionCount: Number(counts.transactions),
      bountyCount: Number(counts.bounties),
      availableBountyCount,
      availableBountyValue: value.toString(),
    };
  }

  account(kind: 'address' | 'domain', query: string, page: number, pageSize: number): AccountSummary {
    const p = pagination(page, pageSize);
    const column = kind === 'address' ? 'address' : 'domain';
    const lookup = kind === 'domain' ? query.toLowerCase().replace(/\.$/, '') : query.toLowerCase();
    let received = 0n,
      sent = 0n,
      outputCount = 0,
      unspentCount = 0;
    for (const row of this.db
      .prepare(
        `SELECT o.value, EXISTS
      (SELECT 1 FROM inputs i WHERE i.prev_txid = o.txid AND i.prev_vout = o.output_index) AS spent
      FROM outputs o WHERE o.${column} = ?`,
      )
      .iterate(lookup)) {
      outputCount++;
      received += BigInt(String(row.value));
      if (row.spent) sent += BigInt(String(row.value));
      else unspentCount++;
    }
    const matching = `SELECT txid FROM outputs WHERE ${column} = ? UNION
      SELECT i.txid FROM inputs i JOIN outputs o ON o.txid = i.prev_txid AND o.output_index = i.prev_vout
      WHERE o.${column} = ?`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n FROM (${matching})`).get(lookup, lookup)!.n);
    const rows = this.db
      .prepare(
        `SELECT t.* FROM transactions t WHERE t.txid IN (${matching})
      ORDER BY t.height DESC, t.position DESC LIMIT ? OFFSET ?`,
      )
      .all(lookup, lookup, p.pageSize, p.offset) as unknown as TxRow[];
    return {
      query,
      kind,
      balance: (received - sent).toString(),
      totalReceived: received.toString(),
      totalSent: sent.toString(),
      outputCount,
      unspentCount,
      transactions: { items: rows.map(summary), total, page, pageSize },
    };
  }

  bounties(
    page: number,
    pageSize: number,
    options: { domain?: string; state?: 'available' | 'spent' | 'all' } = {},
  ): Page<Bounty> {
    const p = pagination(page, pageSize);
    const conditions = ['o.type = 2'];
    const params: string[] = [];
    if (options.domain) {
      conditions.push('o.domain = ?');
      params.push(options.domain.toLowerCase().replace(/\.$/, ''));
    }
    if (options.state !== 'all') conditions.push(`s.txid IS ${options.state === 'spent' ? 'NOT ' : ''}NULL`);
    const from = `FROM outputs o JOIN transactions t ON t.txid = o.txid
      LEFT JOIN inputs s ON s.prev_txid = o.txid AND s.prev_vout = o.output_index WHERE ${conditions.join(' AND ')}`;
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS n ${from}`).get(...params)!.n);
    const rows = this.db
      .prepare(
        `SELECT o.data, o.txid, t.height, t.time, s.txid AS spender, s.input_index ${from}
      ORDER BY t.height DESC, t.position DESC, o.output_index LIMIT ? OFFSET ?`,
      )
      .all(...params, p.pageSize, p.offset);
    const items: Bounty[] = rows.map((row) => ({
      ...JSON.parse(String(row.data)),
      txid: String(row.txid),
      height: Number(row.height),
      time: Number(row.time),
      ...(row.spender === null
        ? {}
        : { spent: { txid: String(row.spender), inputIndex: Number(row.input_index), confirmed: true } }),
    }));
    return { items, total, page, pageSize };
  }

  close(): void {
    this.db.close();
  }
}
