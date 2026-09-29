import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer, get } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { startHttpServer } from '../src/server/lifecycle.js';
import { createApp } from '../src/server/app.js';
import { readConfig } from '../src/server/config.js';
import type { IndexStore } from '../src/server/index-store.js';
import type { RpcClient } from '../src/server/rpc.js';

test('an occupied port never starts polling and closes resources exactly once', async (t) => {
  const occupied = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  t.after(() => new Promise<void>((resolve) => occupied.close(() => resolve())));
  const closed = Promise.withResolvers<void>();
  const errors: NodeJS.ErrnoException[] = [];
  let starts = 0;
  let stops = 0;
  let closes = 0;
  const lifecycle = startHttpServer({
    listener: (_req, res) => res.end('ok'),
    host: '127.0.0.1',
    port: (occupied.address() as AddressInfo).port,
    onListening() {
      starts++;
    },
    onStopping() {
      stops++;
    },
    waitForWork: () => undefined,
    closeResources() {
      closes++;
      closed.resolve();
    },
    onError(error) {
      errors.push(error);
    },
  });
  t.after(() => lifecycle.shutdown());
  await closed.promise;
  await lifecycle.shutdown();
  assert.equal(starts, 0);
  assert.equal(stops, 1);
  assert.equal(closes, 1);
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'EADDRINUSE');
  assert.equal(lifecycle.server.listening, false);
});

test('shutdown waits for an active request and poll before closing the database', async (t) => {
  const requestStarted = Promise.withResolvers<void>();
  const finishRequest = Promise.withResolvers<void>();
  const finishPoll = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  let databaseOpen = true;
  let stops = 0;
  let closes = 0;
  let refresh: Promise<void> | undefined;
  const errors: Error[] = [];
  const lifecycle = startHttpServer({
    listener: (_req, res) => {
      requestStarted.resolve();
      void finishRequest.promise.then(() => {
        assert.equal(databaseOpen, true, 'active handlers still need the database');
        res.end('ok');
      });
    },
    host: '127.0.0.1',
    port: 0,
    onListening() {
      refresh = finishPoll.promise.then(() => {
        assert.equal(databaseOpen, true, 'an in-flight poll still needs the database');
      });
      started.resolve();
    },
    onStopping() {
      stops++;
    },
    waitForWork: () => refresh,
    closeResources() {
      databaseOpen = false;
      closes++;
    },
    onError: (error) => errors.push(error),
  });
  t.after(async () => {
    finishRequest.resolve();
    finishPoll.resolve();
    await lifecycle.shutdown();
  });
  await started.promise;
  const address = lifecycle.server.address() as AddressInfo;
  const response = new Promise<void>((resolve, reject) => {
    get(`http://127.0.0.1:${address.port}`, { agent: false }, (res) => {
      res.resume();
      res.once('end', resolve);
      res.once('error', reject);
    }).once('error', reject);
  });
  await requestStarted.promise;
  const shutdown = lifecycle.shutdown();
  assert.equal(shutdown, lifecycle.shutdown(), 'all callers await the same shutdown');
  assert.equal(stops, 1);
  finishPoll.resolve();
  await refresh;
  assert.equal(databaseOpen, true, 'the pending request must also finish');
  finishRequest.resolve();
  await Promise.all([response, shutdown]);
  assert.equal(databaseOpen, false);
  assert.equal(closes, 1);
  assert.deepEqual(errors, []);
});

test('a rejected poll is drained before resources close and is reported to the caller', async (t) => {
  const started = Promise.withResolvers<void>();
  const finishPoll = Promise.withResolvers<void>();
  let closes = 0;
  const failure = new Error('poll failed');
  const lifecycle = startHttpServer({
    listener: (_req, res) => res.end(),
    host: '127.0.0.1',
    port: 0,
    onListening: () => started.resolve(),
    onStopping() {},
    waitForWork: () => finishPoll.promise,
    closeResources() {
      closes++;
    },
    onError: () => assert.fail('unexpected server error'),
  });
  t.after(() => lifecycle.shutdown().catch(() => {}));
  await started.promise;
  const shutdown = lifecycle.shutdown();
  finishPoll.reject(failure);
  await assert.rejects(shutdown, failure);
  assert.equal(closes, 1);
});

test('shutdown keeps the database open while a poll remains after HTTP has closed', async (t) => {
  const started = Promise.withResolvers<void>();
  const finishPoll = Promise.withResolvers<void>();
  let databaseOpen = true;
  const lifecycle = startHttpServer({
    listener: (_req, res) => res.end(),
    host: '127.0.0.1',
    port: 0,
    onListening: () => started.resolve(),
    onStopping() {},
    waitForWork: () => finishPoll.promise,
    closeResources() {
      databaseOpen = false;
    },
    onError: () => assert.fail('unexpected server error'),
  });
  t.after(async () => {
    finishPoll.resolve();
    await lifecycle.shutdown();
  });
  await started.promise;
  const httpClosed = once(lifecycle.server, 'close');
  const shutdown = lifecycle.shutdown();
  await httpClosed;
  assert.equal(databaseOpen, true);
  finishPoll.resolve();
  await shutdown;
  assert.equal(databaseOpen, false);
});

test('an aborted client does not let shutdown close the database before its async handler', async (t) => {
  const started = Promise.withResolvers<void>();
  const rpcStarted = Promise.withResolvers<void>();
  const finishRpc = Promise.withResolvers<unknown[]>();
  const handlerReadDatabase = Promise.withResolvers<void>();
  const config = readConfig([], {});
  const txid = 'a'.repeat(64);
  let databaseOpen = true;
  let databaseOpenWhenHandlerResumed: boolean | undefined;
  const store = {
    getRevision() {
      return 0;
    },
    getTransaction() {
      return {
        txid,
        height: 1,
        inputs: [],
        outputs: [{ index: 0, type: 1, value: '100' }],
      };
    },
    getTip() {
      databaseOpenWhenHandlerResumed = databaseOpen;
      handlerReadDatabase.resolve();
      return { height: 1, hash: 'b'.repeat(64) };
    },
  } as unknown as IndexStore;
  const rpc = {
    call(method: string) {
      assert.equal(method, 'gettxspendingprevout');
      rpcStarted.resolve();
      return finishRpc.promise;
    },
  } as unknown as RpcClient;
  const app = createApp({
    config,
    store,
    rpc,
    status: {
      title: config.title,
      network: config.network,
      connected: true,
      syncing: false,
      indexedHeight: 1,
    },
  });
  const errors: Error[] = [];
  const lifecycle = startHttpServer({
    listener: app,
    host: '127.0.0.1',
    port: 0,
    onListening: () => started.resolve(),
    onStopping() {},
    waitForWork: () => undefined,
    waitForRequests: () => app.waitForRequests(),
    closeResources() {
      databaseOpen = false;
    },
    onError: (error) => errors.push(error),
  });
  t.after(async () => {
    finishRpc.resolve([]);
    await lifecycle.shutdown();
  });
  await started.promise;
  const address = lifecycle.server.address() as AddressInfo;
  const request = get(`http://127.0.0.1:${address.port}/api/transactions/${txid}`, {
    agent: false,
  });
  request.on('error', () => {}); // Deliberate client cancellation below.
  await rpcStarted.promise;
  const clientClosed = new Promise<void>((resolve) => request.once('close', resolve));
  request.destroy();
  await clientClosed;
  const httpClosed = once(lifecycle.server, 'close');
  const shutdown = lifecycle.shutdown();
  await httpClosed;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(databaseOpen, true, 'the disconnected handler still awaits RPC');
  finishRpc.resolve([]);
  await handlerReadDatabase.promise;
  await shutdown;
  assert.equal(databaseOpenWhenHandlerResumed, true);
  assert.equal(databaseOpen, false);
  assert.deepEqual(errors, []);
});
