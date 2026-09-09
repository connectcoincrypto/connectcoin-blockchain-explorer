import { parseArgs } from 'node:util';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import type { Network } from '../shared/types.js';
import { NETWORKS } from '../shared/networks.js';

export interface Config {
  network: Network;
  title: string;
  expectedChain: string;
  expectedGenesis?: string;
  host: string;
  port: number;
  rpcUrl: string;
  rpcUser?: string;
  rpcPassword?: string;
  cookieFile: string;
  database: string;
  dev: boolean;
  pollMs: number;
}
export const HELP = `ConnectCoin blockchain explorer — Node.js 24+

  npm start -- --testnet
  npm start -- --network regtest --rpc-url http://127.0.0.1:48184

Options:
  --testnet                  Select current testnet4 (not legacy testnet3)
  --network NETWORK          testnet4 (default), testnet3, signet, regtest, main (unlaunched)
  --regtest                  Select local regression test network
  --rpc-url URL              Node JSON-RPC URL; defaults to this network's port
  --rpc-cookie PATH          Node .cookie file (preferred authentication)
  --rpc-user USER            RPC username; password from CONNECTCOIN_RPC_PASSWORD
  --datadir PATH             Node data directory, used to locate its cookie
  --database PATH            Explorer SQLite file (default is isolated by network/genesis)
  --host HOST                HTTP bind host; default 127.0.0.1
  --port PORT                HTTP port; default 3000
  --poll-ms NUMBER           Node refresh interval; default 5000
  --dev                      Development server with Vite
  --help                     Show this help

Environment: EXPLORER_NETWORK, EXPLORER_HOST, EXPLORER_PORT,
EXPLORER_DATABASE, CONNECTCOIN_RPC_URL, CONNECTCOIN_RPC_USER,
CONNECTCOIN_RPC_PASSWORD, CONNECTCOIN_RPC_COOKIE, CONNECTCOIN_DATADIR.
An optional .env file in the working directory is loaded on startup.
`;
function integer(value: string, name: string, min: number, max: number): number {
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer.`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < min || n > max)
    throw new Error(`${name} must be between ${min} and ${max}.`);
  return n;
}
export function readConfig(args = process.argv.slice(2), env = process.env): Config {
  const { values } = parseArgs({
    args,
    options: {
      network: { type: 'string' },
      testnet: { type: 'boolean' },
      regtest: { type: 'boolean' },
      'rpc-url': { type: 'string' },
      'rpc-cookie': { type: 'string' },
      'rpc-user': { type: 'string' },
      datadir: { type: 'string' },
      database: { type: 'string' },
      host: { type: 'string' },
      port: { type: 'string' },
      'poll-ms': { type: 'string' },
      dev: { type: 'boolean' },
      help: { type: 'boolean' },
    },
  });
  if (values.testnet && values.regtest) throw new Error('Choose either --testnet or --regtest.');
  const selected = values.testnet ? 'testnet4' : values.regtest ? 'regtest' : undefined;
  if (selected && values.network && values.network !== selected)
    throw new Error('Conflicting network options.');
  const network = (selected ?? values.network ?? env.EXPLORER_NETWORK ?? 'testnet4') as Network;
  if (!Object.hasOwn(NETWORKS, network))
    throw new Error('Unknown network. Use main, testnet3, testnet4, signet or regtest.');
  const settings = NETWORKS[network];
  const defaultDir =
    process.platform === 'win32'
      ? join(env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'ConnectCoin')
      : process.platform === 'darwin'
        ? join(homedir(), 'Library', 'Application Support', 'ConnectCoin')
        : join(homedir(), '.connectcoin');
  const datadir = values.datadir ?? env.CONNECTCOIN_DATADIR ?? defaultDir;
  const rpcUrl = values['rpc-url'] ?? env.CONNECTCOIN_RPC_URL ?? `http://127.0.0.1:${settings.rpcPort}`;
  let url: URL;
  try {
    url = new URL(rpcUrl);
  } catch {
    throw new Error('RPC URL must be a valid HTTP(S) URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('RPC URL must be HTTP(S), without embedded credentials, query or fragment.');
  }
  const rpcUser = values['rpc-user'] ?? env.CONNECTCOIN_RPC_USER;
  const rpcPassword = env.CONNECTCOIN_RPC_PASSWORD;
  if ((rpcUser === undefined) !== (rpcPassword === undefined))
    throw new Error('Set both RPC username and password, or use cookie authentication.');
  return {
    network,
    expectedChain: settings.chain,
    expectedGenesis: settings.genesis?.hash,
    title: settings.title,
    host: values.host ?? env.EXPLORER_HOST ?? '127.0.0.1',
    port: integer(values.port ?? env.EXPLORER_PORT ?? '3000', 'Port', 1, 65535),
    pollMs: integer(values['poll-ms'] ?? '5000', 'Poll interval', 250, 3_600_000),
    rpcUrl,
    rpcUser,
    rpcPassword,
    cookieFile: resolve(
      values['rpc-cookie'] ?? env.CONNECTCOIN_RPC_COOKIE ?? join(datadir, settings.directory, '.cookie'),
    ),
    database: resolve(
      values.database ??
        env.EXPLORER_DATABASE ??
        `data/${network}-${settings.genesis?.hash.slice(0, 16) ?? 'unlaunched'}.sqlite`,
    ),
    dev: values.dev ?? false,
  };
}
