import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { readConfig, HELP } from './config.js';
import { RpcClient } from './rpc.js';
import { IndexStore } from './index-store.js';
import { createApp } from './app.js';
import { startHttpServer } from './lifecycle.js';
import type { ExplorerStatus } from '../shared/types.js';

if (process.argv.includes('--help')) {
  process.stdout.write(HELP);
  process.exit(0);
}
if (existsSync('.env')) process.loadEnvFile('.env');
const config = readConfig();
mkdirSync(dirname(config.database), { recursive: true });
const rpc = new RpcClient({
  url: config.rpcUrl,
  user: config.rpcUser,
  password: config.rpcPassword,
  cookieFile: config.cookieFile,
});
const store = new IndexStore(config.database, config.network);
const status: ExplorerStatus = {
  title: config.title,
  network: config.network,
  connected: false,
  indexedHeight: store.getTip()?.height ?? -1,
  syncing: true,
};
const app = createApp({ config, rpc, store, status });
let vite: { close(): Promise<void> } | undefined;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const withNetworkTitle = (html: string) =>
  html.replace(/<title>[^<]*<\/title>/, `<title>${config.title}</title>`);
if (config.dev) {
  const { createServer } = await import('vite');
  const dev = await createServer({
    root,
    server: { middlewareMode: true },
    appType: 'spa',
    plugins: [{ name: 'explorer-network-title', transformIndexHtml: withNetworkTitle }],
  });
  vite = dev;
  app.use(dev.middlewares);
} else {
  const client = resolve(root, 'dist/client');
  if (!existsSync(resolve(client, 'index.html')))
    throw new Error('Frontend build missing. Run npm run build first.');
  const html = withNetworkTitle(readFileSync(resolve(client, 'index.html'), 'utf8'));
  app.use(express.static(client, { index: false }));
  app.get('/{*path}', (_req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
}
let stopped = false,
  timer: NodeJS.Timeout | undefined,
  refresh: Promise<void> | undefined;
let metricsTime = 0;
async function poll() {
  let delay = config.pollMs;
  try {
    if (!config.expectedGenesis) throw new Error('NETWORK_UNAVAILABLE');
    const chain = await rpc.call<any>('getblockchaininfo');
    if (chain.chain !== config.expectedChain) throw new Error('NETWORK_MISMATCH');
    const genesis = await rpc.call<string>('getblockhash', [0]);
    // Retain the observed identity for diagnostics, even when it is an old chain.
    if (/^[0-9a-f]{64}$/.test(genesis)) status.genesis = genesis;
    store.bindNetwork(chain.chain, genesis);
    const synced = await store.sync(rpc, 25);
    Object.assign(status, {
      connected: true,
      error: undefined,
      chain: chain.chain,
      genesis,
      nodeHeight: Number(chain.blocks),
      headers: Number(chain.headers),
      indexedHeight: synced.height,
      syncing: synced.height < Number(chain.blocks),
      initialBlockDownload: chain.initialblockdownload,
      verificationProgress: Number(chain.verificationprogress),
      difficulty: String(chain.difficulty),
      lastUpdated: Date.now(),
    });
    if (Date.now() - metricsTime > config.pollMs) {
      const metrics = await Promise.allSettled([
        rpc.call<any>('getnetworkinfo'),
        rpc.call<any>('getmempoolinfo'),
        rpc.call<any>('getmininginfo'),
      ]);
      if (metrics[0].status === 'fulfilled') status.connections = Number(metrics[0].value.connections);
      if (metrics[1].status === 'fulfilled') {
        status.mempoolCount = Number(metrics[1].value.size);
        status.mempoolBytes = Number(metrics[1].value.bytes);
      }
      if (metrics[2].status === 'fulfilled') status.networkHashps = Number(metrics[2].value.networkhashps);
      metricsTime = Date.now();
    }
    if (status.syncing) delay = 10;
  } catch (error: any) {
    const mismatch =
      error?.message === 'NETWORK_MISMATCH' || /genesis|network|chain mismatch/i.test(error?.message ?? '');
    Object.assign(status, {
      connected: false,
      syncing: false,
      indexedHeight: store.getTip()?.height ?? -1,
      error:
        error?.message === 'NETWORK_UNAVAILABLE'
          ? 'The selected network has no configured genesis. Update the explorer network catalog.'
          : mismatch
            ? 'The node chain or genesis does not match the selected P2C proof v2 network. Update Core and check --network/--datadir. Other-chain data is not imported.'
            : /prun/i.test(error?.message ?? '')
              ? 'A full history requires an unpruned node. Restore the missing blocks before indexing.'
              : 'Node RPC is unavailable. Check the RPC URL, authentication and that the node was started with server=1.',
    });
  } finally {
    if (!stopped)
      timer = setTimeout(() => {
        refresh = poll();
      }, delay);
  }
}
function reportError(error: Error) {
  console.error(error.message);
  process.exitCode = 1;
}
const { shutdown } = startHttpServer({
  listener: app,
  port: config.port,
  host: config.host,
  onListening() {
    console.log(`${config.title} — http://${config.host}:${config.port}`);
    console.log('RPC credentials remain on the server. Press Ctrl+C to stop.');
    refresh = poll();
  },
  onStopping() {
    stopped = true;
    if (timer) clearTimeout(timer);
  },
  waitForWork: () => refresh,
  waitForRequests: () => app.waitForRequests(),
  async closeResources() {
    try {
      await vite?.close();
    } finally {
      store.close();
    }
  },
  onError: reportError,
});
process.once('SIGINT', () => {
  void shutdown().catch(reportError);
});
process.once('SIGTERM', () => {
  void shutdown().catch(reportError);
});
