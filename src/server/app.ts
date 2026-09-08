import express from 'express';
import type { Config } from './config.js';
import type { RpcClient } from './rpc.js';
import type { IndexStore } from './index-store.js';
import { normalizeTransaction, decimalToAtomic } from './normalize.js';
import { decodeP2CProof } from './proof.js';
import type { ExplorerStatus, Transaction, TxInput, TxOutput } from '../shared/types.js';

export interface Runtime {
  config: Config;
  rpc: RpcClient;
  store: IndexStore;
  status: ExplorerStatus;
}
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
const hash = (value: string) => /^[a-f0-9]{64}$/i.test(value);
const domain = (value: string) =>
  value.length <= 253 &&
  value.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
function pageNumber(value: unknown, fallback = 1): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) throw new HttpError(400, 'Invalid page number.');
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1 || n > 1_000_000) throw new HttpError(400, 'Invalid page number.');
  return n;
}
function requireHash(value: string) {
  if (!hash(value)) throw new HttpError(400, 'Expected a 64-character hexadecimal hash.');
  return value.toLowerCase();
}

export function createApp(runtime: Runtime) {
  const { config, rpc, store, status } = runtime;
  const app = express();
  app.disable('x-powered-by');
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    if (!config.dev)
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-ancestors 'none'; base-uri 'self'",
      );
    next();
  });
  app.use('/api', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    if (req.method !== 'GET' && req.method !== 'HEAD')
      return res.status(405).json({ error: 'This explorer API is read-only.' });
    next();
  });
  let poolCache: { data: Record<string, any>; time: number } | undefined;
  let poolPending: Promise<Record<string, any>> | undefined;
  async function mempool(): Promise<Record<string, any>> {
    if (!status.connected) throw new HttpError(503, 'Node RPC is unavailable.');
    if (poolCache && Date.now() - poolCache.time < 5000) return poolCache.data;
    if (!poolPending)
      poolPending = rpc
        .call<Record<string, any>>('getrawmempool', [true])
        .then((data) => {
          poolCache = { data, time: Date.now() };
          return data;
        })
        .finally(() => {
          poolPending = undefined;
        });
    return poolPending;
  }
  async function transaction(txid: string): Promise<Transaction | undefined> {
    const indexed = store.getTransaction(txid);
    if (indexed) return indexed;
    if (!status.connected) return undefined;
    try {
      const raw = await rpc.call<any>('getrawtransaction', [txid, 2]);
      if (raw.in_active_chain === false || (raw.blockhash && Number(raw.confirmations ?? 0) <= 0))
        return undefined;
      const tx = normalizeTransaction(raw, config.network);
      // Block context is unavailable until indexed; do not mislabel a confirmed transaction as mempool.
      if (raw.blockhash) tx.blockHash = raw.blockhash;
      if (!tx.blockHash) {
        const pool = await mempool();
        if (!pool[txid]) return undefined;
        tx.fee = decimalToAtomic(pool[txid].fees.base);
        tx.time = Number(pool[txid].time);
      }
      return tx;
    } catch (error: any) {
      if (error?.code === -5) return undefined;
      throw error;
    }
  }
  async function parentTransaction(txid: string): Promise<Transaction | undefined> {
    const indexed = store.getTransaction(txid);
    if (indexed || !status.connected) return indexed;
    try {
      return normalizeTransaction(await rpc.call('getrawtransaction', [txid, 2]), config.network);
    } catch {
      return undefined;
    }
  }
  async function enrichInputs(inputs: TxInput[]) {
    const parents = new Map<string, Promise<Transaction | undefined>>();
    // Only the displayed page (at most 20 inputs) is resolved. Never fan out over an entire large transaction.
    for (let start = 0; start < inputs.length; start += 4) {
      await Promise.all(
        inputs.slice(start, start + 4).map(async (input) => {
          if (!input.txid || input.vout === undefined || input.outputType !== undefined) return;
          if (!parents.has(input.txid)) parents.set(input.txid, parentTransaction(input.txid));
          const previous = (await parents.get(input.txid))?.outputs[input.vout];
          if (previous)
            Object.assign(input, {
              value: previous.value,
              outputType: previous.type,
              address: previous.address,
              pubkey: previous.pubkey,
              domain: previous.domain,
            });
        }),
      );
    }
    return inputs;
  }
  async function pendingSpends(txid: string, outputs: TxOutput[]): Promise<TxOutput[]> {
    if (!status.connected) return outputs;
    const available = outputs.filter((o) => !o.spent);
    if (!available.length) return outputs;
    try {
      const spends = await rpc.call<any[]>('gettxspendingprevout', [
        available.map((o) => ({ txid, vout: o.index })),
        { mempool_only: true },
      ]);
      const byIndex = new Map(
        spends.filter((x) => x.spendingtxid).map((x) => [Number(x.vout), x.spendingtxid]),
      );
      return outputs.map((o) =>
        byIndex.has(o.index)
          ? { ...o, spent: { txid: byIndex.get(o.index), inputIndex: -1, confirmed: false } }
          : o,
      );
    } catch {
      return outputs;
    }
  }
  app.get('/api/status', (_req, res) => res.json(status));
  app.get('/api/health', (_req, res) => {
    const ready = status.connected && !status.syncing && !status.initialBlockDownload;
    res.status(ready ? 200 : 503).json({ ready, indexedHeight: status.indexedHeight });
  });
  app.get('/api/overview', (_req, res) =>
    res.json({ status, index: store.overview(), blocks: store.listBlocks(1, 8) }),
  );
  app.get('/api/blocks', (req, res) => res.json(store.listBlocks(pageNumber(req.query.page), 20)));
  app.get('/api/blocks/:id', (req, res) => {
    const id = req.params.id;
    if (!hash(id) && !/^\d{1,10}$/.test(id)) throw new HttpError(400, 'Invalid block identifier.');
    const result = store.getBlock(id.toLowerCase(), pageNumber(req.query.page), 20);
    if (!result) throw new HttpError(404, 'Block not found in the current indexed chain.');
    res.json({
      ...result,
      confirmations: Math.max(0, (status.nodeHeight ?? store.overview().height) - result.block.height + 1),
    });
  });
  app.get('/api/transactions/:id', async (req, res) => {
    const tx = await transaction(requireHash(req.params.id));
    if (!tx) throw new HttpError(404, 'Transaction not found. It may not be indexed yet.');
    const inputsPage = pageNumber(req.query.inputsPage),
      outputsPage = pageNumber(req.query.outputsPage);
    const visibleInputs = await enrichInputs(tx.inputs.slice((inputsPage - 1) * 20, inputsPage * 20));
    const inputs = visibleInputs.map(({ witness, ...input }) => ({
      ...input,
      witnessCount: witness?.length ?? 0,
      hasProof: input.outputType === 2 && witness?.length === 1,
    }));
    const outputs = await pendingSpends(tx.txid, tx.outputs.slice((outputsPage - 1) * 20, outputsPage * 20));
    const { inputs: _inputs, outputs: _outputs, ...summary } = tx;
    res.json({
      ...summary,
      totalOutput: tx.outputs.reduce((s, o) => s + BigInt(o.value), 0n).toString(),
      confirmations:
        tx.height !== undefined
          ? Math.max(0, (status.nodeHeight ?? store.overview().height) - tx.height + 1)
          : undefined,
      inputs: { items: inputs, total: tx.inputs.length, page: inputsPage, pageSize: 20 },
      outputs: { items: outputs, total: tx.outputs.length, page: outputsPage, pageSize: 20 },
    });
  });
  app.get('/api/transactions/:id/proof/:input', async (req, res) => {
    const tx = await transaction(requireHash(req.params.id));
    if (!tx) throw new HttpError(404, 'Transaction not found.');
    if (!/^\d+$/.test(req.params.input)) throw new HttpError(400, 'Invalid input index.');
    const index = Number(req.params.input),
      input = tx.inputs[index];
    if (input) await enrichInputs([input]);
    if (!input || input.outputType !== 2 || input.witness?.length !== 1)
      throw new HttpError(404, 'No P2C proof on this input.');
    const previous = input.txid ? (await parentTransaction(input.txid))?.outputs[input.vout!] : undefined;
    try {
      res.json(decodeP2CProof(input.witness[0], tx.txid, index, previous?.target));
    } catch {
      throw new HttpError(422, 'The proof cannot be decoded with the supported P2C v1 profile.');
    }
  });
  app.get('/api/mempool', async (req, res) => {
    const pool = await mempool();
    const page = pageNumber(req.query.page);
    const sorted = Object.entries(pool).sort((a, b) => Number(b[1].time) - Number(a[1].time));
    res.json({
      page,
      pageSize: 20,
      total: sorted.length,
      items: sorted.slice((page - 1) * 20, page * 20).map(([txid, tx]) => ({
        txid,
        time: Number(tx.time),
        vsize: Number(tx.vsize_bip141 ?? tx.vsize),
        weight: Number(tx.weight),
        fee: decimalToAtomic(tx.fees.base),
        depends: tx.depends.length,
      })),
    });
  });
  app.get('/api/address/:address', async (req, res) => {
    const address = req.params.address;
    if (!/^(cc|tcc|ccrt)1[a-z0-9]{20,100}$/.test(address))
      throw new HttpError(400, 'Invalid ConnectCoin address.');
    const { bech32m } = await import('bech32');
    try {
      const decoded = bech32m.decode(address);
      const prefix = config.network === 'main' ? 'cc' : config.network === 'regtest' ? 'ccrt' : 'tcc';
      if (
        decoded.prefix !== prefix ||
        decoded.words[0] !== 1 ||
        bech32m.fromWords(decoded.words.slice(1)).length !== 32
      )
        throw new Error();
    } catch {
      throw new HttpError(400, 'Invalid address or wrong network.');
    }
    res.json(store.account('address', address, pageNumber(req.query.page), 20));
  });
  app.get('/api/domain/:domain', (req, res) => {
    const name = req.params.domain.toLowerCase();
    if (!domain(name)) throw new HttpError(400, 'Invalid canonical domain.');
    res.json(store.account('domain', name, pageNumber(req.query.page), 20));
  });
  app.get('/api/bounties', (req, res) => {
    const name = typeof req.query.domain === 'string' ? req.query.domain.toLowerCase() : undefined;
    if (name && !domain(name)) throw new HttpError(400, 'Invalid canonical domain.');
    const state = req.query.state ?? 'available';
    if (!['available', 'spent', 'all'].includes(String(state)))
      throw new HttpError(400, 'Invalid bounty state.');
    res.json(
      store.bounties(pageNumber(req.query.page), 20, {
        domain: name,
        state: state as 'available' | 'spent' | 'all',
      }),
    );
  });
  app.get('/api/search', async (req, res) => {
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!q || q.length > 256) throw new HttpError(400, 'Enter a block height, hash, address or domain.');
    if (/^\d{1,10}$/.test(q)) return res.json({ path: `/block/${q}` });
    if (hash(q)) {
      const id = q.toLowerCase();
      if (store.getBlock(id, 1, 1)) return res.json({ path: `/block/${id}` });
      if (await transaction(id)) return res.json({ path: `/tx/${id}` });
      throw new HttpError(404, 'No indexed block or known transaction matches this hash.');
    }
    if (/^(cc|tcc|ccrt)1/i.test(q))
      return res.json({ path: `/address/${encodeURIComponent(q.toLowerCase())}` });
    if (domain(q.toLowerCase()) && q.includes('.'))
      return res.json({ path: `/domain/${encodeURIComponent(q.toLowerCase())}` });
    throw new HttpError(
      400,
      'Enter a block height, transaction/block hash, ConnectCoin address or DNS domain.',
    );
  });
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found.' }));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
    res.status(503).json({
      error: 'The node could not complete this request. Retry after the index or RPC connection recovers.',
    });
  });
  return app;
}
