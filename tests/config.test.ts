import assert from 'node:assert/strict';
import test from 'node:test';
import { join, resolve } from 'node:path';
import { readConfig } from '../src/server/config.js';
import { outputLabel } from '../src/shared/types.js';
import { NETWORKS } from '../src/shared/networks.js';
import { MAINNET_GENESIS } from './fixtures/mainnet-genesis.js';

test('output labels preserve numeric protocol types and exact requested names', () => {
  assert.equal(outputLabel(1), 'output type: 1 (pay-to-public-key)');
  assert.equal(outputLabel(2), 'output type: 2 (pay-to-connect)');
  assert.equal(outputLabel(99), 'output type: 99 (unknown)');
});

test('testnet flag selects testnet4, the exact requested title and network-specific RPC/cookie/database', () => {
  const config = readConfig(['--testnet', '--datadir', 'node-data'], {});
  assert.equal(config.network, 'testnet4');
  assert.equal(config.expectedChain, 'testnet4');
  assert.equal(config.title, 'ConnectCoin Testnet Explorer');
  assert.equal(config.rpcUrl, 'http://127.0.0.1:48178');
  assert.equal(config.cookieFile, resolve('node-data', 'testnet4', '.cookie'));
  assert.equal(config.expectedGenesis, '710dc5910cbef40216bd82ccfb66af2273b2b1d336b034c5794966904cb603bf');
  assert.equal(config.database, resolve('data', 'testnet4-710dc5910cbef402.sqlite'));
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3000);
  assert.equal(config.rpcUser, undefined);
  assert.equal(config.rpcPassword, undefined);
});

test('each supported network gets its Core chain name, RPC port and distinct index', () => {
  const networks = [
    ['main', 'main', 48172, 'ConnectCoin Explorer'],
    ['testnet3', 'test', 48175, 'ConnectCoin Testnet Explorer'],
    ['testnet4', 'testnet4', 48178, 'ConnectCoin Testnet Explorer'],
    ['signet', 'signet', 48181, 'ConnectCoin Signet Explorer'],
    ['regtest', 'regtest', 48184, 'ConnectCoin Regtest Explorer'],
  ] as const;
  for (const [network, chain, port, title] of networks) {
    const config = readConfig(['--network', network], {});
    assert.equal(config.network, network);
    assert.equal(config.expectedChain, chain);
    assert.equal(config.rpcUrl, `http://127.0.0.1:${port}`);
    assert.equal(config.title, title);
    assert.equal(config.expectedGenesis, NETWORKS[network].genesis?.hash);
    assert.equal(
      config.database,
      resolve('data', `${network}-${NETWORKS[network].genesis?.hash.slice(0, 16) ?? 'unlaunched'}.sqlite`),
    );
  }
  assert.equal(readConfig(['--regtest'], {}).network, 'regtest');
  assert.equal(readConfig([], {}).network, 'testnet4');
  assert.equal(readConfig(['--network', 'main'], {}).expectedGenesis, MAINNET_GENESIS.hash);
});

test('mainnet selects its own RPC, root cookie and genesis-isolated index without changing the default', () => {
  const config = readConfig(['--network', 'main', '--datadir', 'node-data'], {});
  assert.equal(config.network, 'main');
  assert.equal(config.expectedChain, 'main');
  assert.equal(config.expectedGenesis, MAINNET_GENESIS.hash);
  assert.equal(config.title, 'ConnectCoin Explorer');
  assert.equal(config.rpcUrl, 'http://127.0.0.1:48172');
  assert.equal(config.cookieFile, resolve('node-data', '.cookie'));
  assert.equal(config.database, resolve('data', 'main-30a3a7543f593b63.sqlite'));
  assert.notEqual(config.database, resolve('data', 'main-unlaunched.sqlite'));
  const testnet = readConfig(['--testnet', '--datadir', 'node-data'], {});
  assert.notEqual(config.database, testnet.database);
  assert.notEqual(config.cookieFile, testnet.cookieFile);
  assert.notEqual(config.rpcUrl, testnet.rpcUrl);
  assert.equal(readConfig([], {}).network, 'testnet4');
});

test('mainnet deployment can explicitly override a retained testnet environment', () => {
  const config = readConfig(
    [
      '--network',
      'main',
      '--rpc-url',
      'http://127.0.0.1:48172',
      '--rpc-cookie',
      'node-data/.cookie',
      '--database',
      'data/main-30a3a7543f593b63.sqlite',
    ],
    {
      EXPLORER_NETWORK: 'testnet4',
      CONNECTCOIN_RPC_URL: 'http://127.0.0.1:48178',
      CONNECTCOIN_RPC_COOKIE: 'node-data/testnet4/.cookie',
      EXPLORER_DATABASE: 'data/testnet4-710dc5910cbef402.sqlite',
    },
  );
  assert.equal(config.network, 'main');
  assert.equal(config.rpcUrl, 'http://127.0.0.1:48172');
  assert.equal(config.cookieFile, resolve('node-data', '.cookie'));
  assert.equal(config.database, resolve('data', 'main-30a3a7543f593b63.sqlite'));
});

test('default reset indexes do not reuse the old network-only file; explicit paths remain honored', () => {
  for (const network of ['main', 'testnet3', 'testnet4', 'signet', 'regtest'] as const) {
    assert.notEqual(readConfig(['--network', network], {}).database, resolve('data', `${network}.sqlite`));
    assert.equal(
      readConfig(['--network', network, '--database', `data/${network}.sqlite`], {}).database,
      resolve('data', `${network}.sqlite`),
    );
  }
  assert.equal(readConfig([], { EXPLORER_NETWORK: 'main' }).network, 'main');
  assert.equal(readConfig([], { EXPLORER_DATABASE: 'custom.sqlite' }).database, resolve('custom.sqlite'));
});

test('signature-mask reset indexes do not reuse the previous proof-v2 genesis namespace', () => {
  const previousGenesis = {
    testnet3: 'ca89051d3a1bcf96be2ed4943d347687af47b6fd0a155fc2b15ddcc103bd75af',
    testnet4: '38cae555fb78f44c31e7d6859d0476252b321dae8b6312afefe0a45fc3fd112a',
    signet: '2a62fd84425bc1f6dce0343ec3f6c08b782d76df54d52e5e3b8153f5d27d94b4',
    regtest: 'de48ff31cbff58a91ef359100fef13e6472f165e6f0410e52efcdacb1861f65a',
  } as const;
  for (const network of ['testnet3', 'testnet4', 'signet', 'regtest'] as const) {
    const config = readConfig(['--network', network], {});
    assert.notEqual(config.expectedGenesis, previousGenesis[network]);
    assert.notEqual(
      config.database,
      resolve('data', `${network}-${previousGenesis[network].slice(0, 16)}.sqlite`),
    );
  }
});

test('explicit CLI choices override environment while password stays in environment', () => {
  const config = readConfig(
    [
      '--network',
      'regtest',
      '--rpc-url',
      'https://localhost:1234',
      '--rpc-user',
      'cli-user',
      '--rpc-cookie',
      'custom.cookie',
      '--database',
      'custom.sqlite',
      '--host',
      '0.0.0.0',
      '--port',
      '4321',
      '--poll-ms',
      '250',
      '--dev',
    ],
    {
      EXPLORER_NETWORK: 'main',
      CONNECTCOIN_RPC_URL: 'http://localhost:2222',
      CONNECTCOIN_RPC_USER: 'env-user',
      CONNECTCOIN_RPC_PASSWORD: 'secret-value',
      CONNECTCOIN_RPC_COOKIE: 'environment.cookie',
      EXPLORER_DATABASE: 'environment.sqlite',
      EXPLORER_HOST: '127.0.0.2',
      EXPLORER_PORT: '5678',
    },
  );
  assert.equal(config.network, 'regtest');
  assert.equal(config.rpcUrl, 'https://localhost:1234');
  assert.equal(config.rpcUser, 'cli-user');
  assert.equal(config.rpcPassword, 'secret-value');
  assert.equal(config.cookieFile, resolve('custom.cookie'));
  assert.equal(config.database, resolve('custom.sqlite'));
  assert.equal(config.host, '0.0.0.0');
  assert.equal(config.port, 4321);
  assert.equal(config.pollMs, 250);
  assert.equal(config.dev, true);
  const environment = readConfig([], {
    EXPLORER_NETWORK: 'testnet3',
    CONNECTCOIN_DATADIR: 'alternate-data',
    EXPLORER_HOST: 'localhost',
    EXPLORER_PORT: '8080',
    EXPLORER_DATABASE: 'saved.sqlite',
  });
  assert.equal(environment.cookieFile, resolve(join('alternate-data', 'testnet3', '.cookie')));
  assert.equal(environment.port, 8080);
  assert.equal(environment.database, resolve('saved.sqlite'));
});

test('rejects conflicting or unknown networks, invalid numeric options and unsafe RPC URLs', () => {
  for (const args of [
    ['--testnet', '--regtest'],
    ['--testnet', '--network', 'main'],
    ['--regtest', '--network', 'testnet4'],
    ['--network', 'testnet'],
    ['--network', '__proto__'],
    ['--port', '0'],
    ['--port', '65536'],
    ['--port', '3.5'],
    ['--port', '1e3'],
    ['--poll-ms', '249'],
    ['--poll-ms', '3600001'],
    ['--rpc-url', 'file:///tmp/node'],
    ['--rpc-url', 'http://user:pass@localhost'],
    ['--rpc-url', 'http://localhost?password=secret'],
    ['--rpc-url', 'http://localhost#secret'],
  ])
    assert.throws(() => readConfig(args, {}), args.join(' '));
  assert.throws(() => readConfig(['--rpc-user', 'alice'], {}), /both RPC username and password/);
  assert.throws(
    () => readConfig([], { CONNECTCOIN_RPC_PASSWORD: 'secret' }),
    /both RPC username and password/,
  );
  assert.throws(() => readConfig(['--rpc-password', 'secret'], {}), /Unknown option/);
});
