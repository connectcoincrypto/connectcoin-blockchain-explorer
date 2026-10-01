import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bech32m } from 'bech32';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import { IndexStore } from '../src/server/index-store.js';
import type { RpcClient } from '../src/server/rpc.js';
import { NETWORKS } from '../src/shared/networks.js';
import type { ExplorerStatus } from '../src/shared/types.js';
import { MAINNET_GENESIS, mainnetGenesisBlock } from './fixtures/mainnet-genesis.js';

class MainnetRpc {
  chain = 'main';
  genesisHash: string = MAINNET_GENESIS.hash;
  calls: string[] = [];

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push(method);
    if (method === 'getblockchaininfo')
      return {
        chain: this.chain,
        blocks: '0',
        headers: '0',
        pruned: false,
        initialblockdownload: false,
      } as T;
    if (method === 'getblockhash') {
      assert.equal(params[0], 0);
      return this.genesisHash as T;
    }
    if (method === 'getblock') {
      assert.equal(params[0], this.genesisHash);
      assert.equal(params[1], 2);
      return { ...mainnetGenesisBlock(), hash: this.genesisHash } as T;
    }
    if (method === 'gettxspendingprevout') return params[0] as T;
    if (method === 'getrawmempool') return {} as T;
    throw new Error(`Unexpected RPC call ${method}`);
  }
}

function allocationAddress(publicKey: string, hrp = 'cc') {
  return bech32m.encode(hrp, [1, ...bech32m.toWords(Buffer.from(publicKey, 'hex'))]);
}

test('mainnet indexes the real two-output genesis and resumes without mixing testnet data', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'connectcoin-mainnet-index-test-'));
  const path = join(directory, 'main.sqlite');
  let store: IndexStore | undefined;
  try {
    const rpc = new MainnetRpc();
    store = new IndexStore(path, 'main');
    assert.deepEqual(await store.sync(rpc), { height: 0, nodeHeight: 0, indexedBlocks: 1 });
    const transaction = store.getTransaction(MAINNET_GENESIS.merkleRoot)!;
    assert.equal(transaction.blockHash, MAINNET_GENESIS.hash);
    assert.equal(transaction.height, 0);
    assert.equal(transaction.outputs.length, 2);
    assert.equal(transaction.inputs.length, 1);
    assert.ok(transaction.inputs[0].coinbase);
    for (const [index, expected] of MAINNET_GENESIS.outputs.entries()) {
      const output = transaction.outputs[index];
      assert.equal(output.index, index);
      assert.equal(output.type, 1);
      assert.equal(output.pubkey, expected.publicKey);
      assert.equal(output.value, expected.valueConnects);
      assert.equal(output.address, allocationAddress(expected.publicKey));
      assert.match(output.address!, /^cc1p/);
      const account = store.account('address', output.address!, 1, 10);
      assert.equal(account.balance, expected.valueConnects);
      assert.equal(account.totalReceived, expected.valueConnects);
      assert.equal(account.outputCount, 1);
      assert.equal(account.unspentCount, 1);
    }
    assert.notEqual(transaction.outputs[0].address, transaction.outputs[1].address);
    assert.equal(store.overview().transactionCount, 1);
    assert.equal(store.overview().bountyCount, 0);
    store.close();
    store = undefined;
    assert.throws(() => new IndexStore(path, 'testnet4'), /belongs to main/);
    store = new IndexStore(path, 'main');
    assert.equal(store.getTip()?.hash, MAINNET_GENESIS.hash);
    assert.deepEqual(await store.sync(rpc), { height: 0, nodeHeight: 0, indexedBlocks: 0 });
    assert.equal(store.getTransaction(MAINNET_GENESIS.merkleRoot)?.outputs.length, 2);
  } finally {
    store?.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('mainnet rejects a wrong RPC chain or genesis before fetching or indexing its blocks', async () => {
  for (const [chain, genesis] of [
    ['main', '0'.repeat(64)],
    ['main', 'f'.repeat(64)],
    ['main', NETWORKS.testnet4.genesis!.hash],
    ['testnet4', MAINNET_GENESIS.hash],
    ['testnet4', NETWORKS.testnet4.genesis!.hash],
  ]) {
    const store = new IndexStore(':memory:', 'main');
    const rpc = new MainnetRpc();
    rpc.chain = chain;
    rpc.genesisHash = genesis;
    try {
      await assert.rejects(store.sync(rpc), /does not match/, `${chain}: ${genesis}`);
      assert.equal(rpc.calls.includes('getblock'), false, 'identity is checked before fetching payloads');
      assert.equal(store.getTip(), undefined);
      assert.equal(store.overview().transactionCount, 0);
    } finally {
      store.close();
    }
  }
});

test('mainnet HTTP metadata, block zero, allocations and health describe the launched chain', async (t) => {
  const store = new IndexStore(':memory:', 'main');
  let closeHttp = async () => {};
  t.after(async () => {
    await closeHttp();
    store.close();
  });
  const rpc = new MainnetRpc();
  const synced = await store.sync(rpc);
  const config = readConfig(['--network', 'main'], {
    CONNECTCOIN_RPC_USER: 'private-mainnet-user',
    CONNECTCOIN_RPC_PASSWORD: 'private-mainnet-password',
  });
  const status: ExplorerStatus = {
    title: config.title,
    network: config.network,
    chain: rpc.chain,
    genesis: rpc.genesisHash,
    connected: true,
    syncing: false,
    initialBlockDownload: false,
    indexedHeight: synced.height,
    nodeHeight: synced.nodeHeight,
  };
  const app = createApp({ config, status, store, rpc: rpc as unknown as RpcClient });
  const server = app.listen(0, '127.0.0.1');
  closeHttp = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await app.waitForRequests();
  };
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const url = `http://127.0.0.1:${address.port}`;
  async function get(path: string, expectedStatus = 200) {
    const response = await fetch(url + path);
    const text = await response.text();
    assert.equal(response.status, expectedStatus, `${path}: ${text}`);
    assert.ok(!text.includes('private-mainnet-user') && !text.includes('private-mainnet-password'));
    return JSON.parse(text);
  }

  const network = await get('/api/network');
  assert.equal(network.network, 'main');
  assert.equal(network.parameters.launched, true);
  assert.equal(network.parameters.testChain, false);
  assert.equal(network.parameters.genesis.hash, MAINNET_GENESIS.hash);
  assert.equal(network.observedGenesis, MAINNET_GENESIS.hash);
  assert.deepEqual(network.parameters.genesis.outputs, MAINNET_GENESIS.outputs);
  assert.equal('publicKey' in network.parameters.genesis, false);
  assert.equal(network.protocol.ticker, 'CONN');
  assert.equal(network.protocol.p2cProofVersion, 2);
  assert.equal('rpcUrl' in network, false);
  assert.equal('rpcPassword' in network, false);
  assert.equal((await get('/api/status')).title, 'ConnectCoin Explorer');
  assert.equal((await get('/api/status')).network, 'main');
  assert.equal((await get('/api/health')).ready, true);

  const block = await get('/api/blocks/0');
  assert.equal(block.block.hash, MAINNET_GENESIS.hash);
  assert.equal(block.block.merkleRoot, MAINNET_GENESIS.merkleRoot);
  assert.equal(block.transactions.items[0].txid, MAINNET_GENESIS.merkleRoot);
  assert.equal(block.transactions.items[0].totalOutput, '100000000000000000');
  const transaction = await get(`/api/transactions/${MAINNET_GENESIS.merkleRoot}`);
  assert.equal(transaction.totalOutput, '100000000000000000');
  assert.equal(transaction.outputs.total, 2);
  for (const [index, expected] of MAINNET_GENESIS.outputs.entries()) {
    const output = transaction.outputs.items[index];
    const expectedAddress = allocationAddress(expected.publicKey);
    assert.equal(output.type, 1);
    assert.equal(output.value, expected.valueConnects);
    assert.equal(output.pubkey, expected.publicKey);
    assert.equal(output.address, expectedAddress);
    assert.equal((await get(`/api/address/${expectedAddress}`)).balance, expected.valueConnects);
    await get(`/api/address/${allocationAddress(expected.publicKey, 'tcc')}`, 400);
  }
  assert.equal((await get('/api/overview')).index.blockCount, 1);
  status.initialBlockDownload = true;
  assert.equal((await get('/api/health', 503)).ready, false);
});
