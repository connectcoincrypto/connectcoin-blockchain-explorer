# ConnectCoin Blockchain Explorer

A self-hosted, read-only explorer backed by a ConnectCoin node's JSON-RPC. Native typed outputs and pay-to-connect are first-class data, not inferred from compatibility `scriptPubKey.type` strings.

## Run on testnet

Requires **Node.js 24+**, npm, and a compatible ConnectCoin node with RPC enabled (`server=1`). For a complete explorer, the node must retain the full, unpruned chain. A wallet is **not** required.

```sh
npm ci
npm run build
npm start -- --testnet
```

Open **http://127.0.0.1:3000**. `--testnet` selects **testnet4**, uses RPC port **48178**, and displays **ConnectCoin Testnet Explorer**, both in the header and the browser title. It does not start, reconfigure, or stop your node.

The explorer automatically reads the `.cookie` from the platform's default ConnectCoin data directory, under the selected network subdirectory. For a custom node directory:

```sh
npm start -- --testnet --datadir "C:/path/to/ConnectCoin"
```

Or select the exact cookie and RPC URL:

```sh
npm start -- --testnet --rpc-url http://127.0.0.1:48178 --rpc-cookie "C:/path/to/testnet4/.cookie"
```

For username/password authentication, use `CONNECTCOIN_RPC_USER` and `CONNECTCOIN_RPC_PASSWORD` in the server environment or an untracked `.env`. Do not put credentials in the URL, source code, frontend, or command-line password arguments. `.env.example` documents the available variables. Cookie authentication is reread on each request, so node restarts can rotate the cookie.

Run `npm start -- --help` for all options. The explorer defaults to `main` when no network flag or environment setting is supplied; explicitly use `--testnet` for the current test network. CLI flags override environment settings.

| Selection                          | Node chain | Default RPC port | Header                       |
| ---------------------------------- | ---------- | ---------------- | ---------------------------- |
| `--testnet` / `--network testnet4` | `testnet4` | 48178            | ConnectCoin Testnet Explorer |
| `--network testnet3`               | `test`     | 48175            | ConnectCoin Testnet Explorer |
| `--network main`                   | `main`     | 48172            | ConnectCoin Explorer         |
| `--network signet`                 | `signet`   | 48181            | ConnectCoin Signet Explorer  |
| `--regtest` / `--network regtest`  | `regtest`  | 48184            | ConnectCoin Regtest Explorer |

Support for a network option does not imply that network is currently launched or reachable. The explorer refuses to synchronize against a different chain or to reuse a database with a different genesis.

## Explorer views

- Network overview: node height, hashrate, mempool, latest blocks, index progress and confirmed-chain P2C reward totals.
- Blocks and transactions, including confirmations, timestamps, sizes, weight, fees, inputs, outputs, previous outputs and spending transactions.
- Search by block height, block/transaction hash, ConnectCoin address or canonical DNS domain.
- Address history and balances; domain funding, rewards consumed by claims and available outputs.
- Live node mempool, plus pending-spend information on transaction outputs.
- P2C bounty catalogue with domain and spent/available filters.
- TLS proof inspection for P2C spending inputs: handshake messages, challenge binding, work hash and target comparison, certificate display metadata and downloadable proof JSON.

Every output displays its numeric type:

```text
output type: 1 (pay-to-public-key)
output type: 2 (pay-to-connect)
```

Type 1 exposes its x-only public key and ConnectCoin address. Type 2 exposes its domain, full copyable work target, root certificates version and approximate expected attempts. There is no invented address or owner for a P2C domain. Unknown numeric types remain explicit rather than being silently treated as P2PK.

## Correctness and data scope

**Amounts:** 1 CC = 10^10 connects. RPC numeric literals are parsed without floating-point rounding. Amounts travel through the index and API as integer decimal strings in **connects**, and the UI formats them with `BigInt` into CC. Approximate hashrates and statistical attempt counts are not monetary values.

**Index:** SQLite is stored in `data/<network>.sqlite` by default. Backfill uses `getblock(hash, 2)` from genesis, then follows the tip. This supplies address/domain history without a node `txindex` or `txospenderindex`. Confirmed spends are tracked locally. Reorganizations, shorter tips and partial sync failures are handled atomically. Restarting resumes from the stored tip. Sync uses bounded block batches, including a retained-payload estimate budget; a complete large block still needs enough server memory to decode.

**Pending transactions:** `getrawmempool`, `getrawtransaction` and `gettxspendingprevout` provide the live view. The displayed prevouts of unconfirmed transactions can be resolved through RPC, including unconfirmed parents. RPC failures are not presented as an empty mempool. Pending-spend lookups are best effort; “unspent in indexed chain” is not a promise that no pending claim exists.

**Balances and bounties:** totals and catalogue filters cover only the confirmed indexed chain, excluding mempool activity. They can be incomplete during backfill or node synchronization. An address balance includes immature coinbase outputs; it is not a wallet's immediately spendable balance. A domain is a bounty target, not the recipient or owner of the funded value. The wallet's discovery window is not an expiry rule and does not hide older outputs here.

**Proofs:** the decoder supports the current domain-only P2C v1 TLS profile and checks framing, challenge binding and work hash. It does **not** independently validate the TLS signature, root trust, domain authorization, consensus rules or historical MTP certificate validity. Those belong to the node. Certificate dates are historical display metadata; a certificate expiring today does not invalidate an old confirmed claim. Expected attempts are a probability estimate, not the number of connections actually made.

## Deployment and security

The browser calls only the explorer API. Node credentials and cookies remain on the server. There is no arbitrary RPC proxy, wallet API, send-transaction action or private-key handling. The RPC client has a read-only method allowlist, deadlines, response-size bounds and sanitized errors. The API rejects write methods and sets restrictive production browser headers.

Run one explorer process per SQLite database on local persistent storage. A process supervisor should restart it after a host reboot. Stop it gracefully before moving or backing up the database; SQLite WAL files are part of the live state. Do not run two independent index writers on the same file.

For public access, place the **production** build behind an HTTPS reverse proxy with request/concurrency limits. Bind to another interface only deliberately, e.g. `--host 0.0.0.0`. Keep the node RPC private on loopback or a restricted authenticated network; expose only the explorer HTTP port. Never expose the Vite development server publicly. No public hosting, DNS changes or node firewall changes are performed by this repository.

Budget storage for indexed transactions and P2C witnesses. Individual protocol-limit blocks can expand to hundreds of MB of decoded RPC JSON, so provide several GB of RAM and measure resource usage against your actual chain before public deployment. This first version has not been load-tested against a full production-sized chain.

`GET /api/health` returns 200 only when the node is reachable, out of initial block download, and the index has caught up; otherwise 503. `GET /api/status` includes network, connection, index height and any operational warning. When offline, indexed pages can still be read with a visible cached-data warning.

## Development

```sh
npm run dev -- --testnet
npm run typecheck
npm test
npm run build
npm run format:check
```

The development command accepts the same network, RPC and database options as `npm start`. Tests use local fixture RPC servers and temporary SQLite files; they do not connect to or modify a wallet. Coverage includes monetary precision, typed outputs, P2C proof framing/hash checks, RPC authentication/errors/large responses, API routes, pagination, network selection, restart and reorg rollback.

Source layout: `src/server` contains RPC, indexing, proof decoding and HTTP routes; `src/shared` contains the API model; `src/client` contains the React interface. Vite builds the frontend into `dist/client`, and TypeScript builds the backend into `dist/server`.
