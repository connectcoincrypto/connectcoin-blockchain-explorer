# ConnectCoin Blockchain Explorer

A self-hosted, read-only explorer backed by a ConnectCoin node's JSON-RPC. Native typed outputs and pay-to-connect are first-class data, not inferred from compatibility `scriptPubKey.type` strings.

## Run on testnet

Requires **Node.js 24+**, npm, and a ConnectCoin node using the **September 9, 2026 P2C signature-mask chain reset** (Core commit `d4d1ae56aa`), with RPC enabled (`server=1`). Core calls this reset **P2C mask v1**: that is the output-layout revision, not the TLS proof version. Only proof version 2 is supported; proof v1 is rejected. For a complete explorer, the node must retain the full, unpruned chain. A wallet is **not** required.

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

Run `npm start -- --help` for all options. The explorer now defaults to **testnet4**, matching the Core beta, when no network flag or environment setting is supplied. Existing explicit selections are preserved; CLI flags override environment settings.

| Selection                          | Node chain | Default RPC port | Header                       |
| ---------------------------------- | ---------- | ---------------- | ---------------------------- |
| `--testnet` / `--network testnet4` | `testnet4` | 48178            | ConnectCoin Testnet Explorer |
| `--network testnet3`               | `test`     | 48175            | ConnectCoin Testnet Explorer |
| `--network main`                   | `main`     | 48172            | ConnectCoin Explorer         |
| `--network signet`                 | `signet`   | 48181            | ConnectCoin Signet Explorer  |
| `--regtest` / `--network regtest`  | `regtest`  | 48184            | ConnectCoin Regtest Explorer |

Mainnet is **not launched and has no operational genesis**. Its option only exposes its parameters and an unavailable-network warning; it cannot synchronize. The explorer checks both the node's chain name and the exact current genesis, even with an empty index. An old chain with the same name is rejected.

## Updating after the P2C signature-mask reset

Stop the previous explorer process gracefully, then, from this repository directory:

```sh
git pull --ff-only
npm ci
npm run build
npm start -- --testnet --host 127.0.0.1 --port 3000
```

Keep your existing HTTPS reverse proxy pointing to `127.0.0.1:3000`. Restart an existing process supervisor instead of starting a second writer if the explorer is managed as a service. These commands update the explorer, **not the Core node**: the RPC node must also be running the matching reset chain. If it uses a new data directory, pass `--datadir /path/to/new/node-data` or update `CONNECTCOIN_DATADIR`/`CONNECTCOIN_RPC_COOKIE`.

The default index is `data/<network>-<first-16-genesis-hex>.sqlite`, so the current testnet4 uses `data/testnet4-710dc5910cbef402.sqlite`. Both the earlier `data/testnet4.sqlite` and the previous proof-v2-reset index `data/testnet4-38cae555fb78f44c.sqlite` are preserved and **not imported**. If `--database` or `EXPLORER_DATABASE` selects an old index, startup refuses it: preserve that file and choose a new path, or remove the override to use the new default. Nothing deletes old indexes or wallets. Initial backfill starts at the new genesis; old test balances do not carry over.

Current identities are defined together with network defaults in `src/shared/networks.ts`:

| Network  | Current genesis                                                    |
| -------- | ------------------------------------------------------------------ |
| Testnet3 | `1025889d725c5d64c3ee38ab07d2de279ab57036a2482186c65806d6c0291787` |
| Testnet4 | `710dc5910cbef40216bd82ccfb66af2273b2b1d336b034c5794966904cb603bf` |
| Signet   | `a694dccdc04a316a4f4fe496f311aff981392f25ea18e4b7f77d9f449b9089fc` |
| Regtest  | `53c5145452f6957a2674ab904726afc2d7643c4a4fb9c2beab193ea983e500f0` |
| Mainnet  | None — not launched                                                |

The catalog follows Core commit `d4d1ae56aa` (`src/kernel/chainparams.cpp`, `src/chainparamsbase.cpp`, `src/consensus/{amount,consensus,p2c}.h`, `doc/testnet-beta.md`). Tests independently hash the four serialized genesis headers. Custom signet challenges share the default genesis but can change network magic; catalog fields are explicitly defaults, not a discovery of custom node settings.

## Explorer views

The header's theme selector offers **System**, **Light** and **Dark**. It follows the operating system by default, remembers an explicit choice in this browser and synchronizes that choice between open explorer tabs. The saved theme is applied before the first paint, without weakening the production script policy.

- Network overview: node height, hashrate, mempool, latest blocks, index progress and confirmed-chain P2C reward totals.
- Network parameters: expected and RPC-observed genesis, genesis transaction, public key/allocation, header details, address prefix, proof/root versions, block/proof limits, maturity, halving interval and default ports.
- Blocks and transactions, including confirmations, timestamps, sizes, weight, fees, inputs, outputs, previous outputs and spending transactions.
- Search by block height, block/transaction hash, ConnectCoin address or canonical DNS domain.
- Address history and balances; domain funding, rewards consumed by claims and available outputs.
- Live node mempool, plus pending-spend information on transaction outputs.
- P2C bounty catalogue with domain and spent/available filters, including the signature algorithms accepted by each output.
- TLS proof v2 inspection for P2C spending inputs: handshake messages and their work-hash inclusion, chosen CertificateVerify signature algorithm and whether the spent output allows it, challenge binding, work hash/tag/preimage length, TLS transcript digest, target comparison, certificate display metadata and downloadable proof JSON.

Every output displays its numeric type:

```text
output type: 1 (pay-to-public-key)
output type: 2 (pay-to-connect)
```

Type 1 exposes its x-only public key and ConnectCoin address. Type 2 exposes its domain, full copyable work target, root certificates version, signature-algorithm mask and approximate expected attempts. There is no invented address or owner for a P2C domain. Unknown numeric types remain explicit rather than being silently treated as P2PK.

### Accepted P2C signature algorithms

Each P2C output carries its own required `signature_algorithms_mask` from Core RPC. The transaction and bounty output cards show this mask in decimal and hexadecimal, followed by **only the algorithms permitted by that output**, using these bits:

|     Mask bit | TLS SignatureScheme | Name                     |
| -----------: | ------------------- | ------------------------ |
| `1` (`0x01`) | `0x0403`            | `ecdsa_secp256r1_sha256` |
| `2` (`0x02`) | `0x0804`            | `rsa_pss_rsae_sha256`    |
| `4` (`0x04`) | `0x0809`            | `rsa_pss_pss_sha256`     |

Masks combine bits and must be integers from `1` through `7`. For example, mask `6` (`0x06`) accepts the two RSA-PSS schemes but not ECDSA; mask `7` accepts all three. A missing mask is **not** assumed to mean `7`: missing or invalid required RPC data is rejected during output normalization, and a view without mask data cannot claim any accepted algorithms.

The explorer API exposes the value as `TxOutput.signatureAlgorithmsMask` and carries it into resolved spending-input metadata. Proof inspection includes `signatureAlgorithmsMask` and the boolean `signatureSchemeAllowed` when the spent output's mask is available; these fields are omitted when it is unavailable. The comparison checks membership in the output's allowed set, **not** cryptographic validity of the TLS signature.

## Correctness and data scope

**Amounts:** 1 CC = 10^10 connects. RPC numeric literals are parsed without floating-point rounding. Amounts travel through the index and API as integer decimal strings in **connects**, and the UI formats them with `BigInt` into CC. Approximate hashrates and statistical attempt counts are not monetary values.

**Index:** SQLite is stored in a genesis-specific file under `data/` by default (see upgrade instructions). Backfill uses `getblock(hash, 2)` from genesis, then follows the tip. This supplies address/domain history without a node `txindex` or `txospenderindex`. Confirmed spends are tracked locally. Reorganizations, shorter tips and partial sync failures are handled atomically. Restarting resumes from the stored tip. Sync uses bounded block batches, including a retained-payload estimate budget; a complete large block still needs enough server memory to decode.

**Reorganizations:** when a replacement chain is committed, detached blocks and their transactions, spends and account effects are removed atomically from the confirmed index. A transaction included again uses its new canonical block, height, time and witness. Asynchronous API reads retry if the index changes before the response is sent; after three unstable attempts they return HTTP 503 rather than mixing chain snapshots. Numeric confirmations are counted from the indexed tip, not a potentially ahead or stale node-height status. This is consistency with the latest committed index, not a guarantee of instantaneous detection of remote node changes.

**Pending transactions:** `getrawmempool`, `getrawtransaction`, `getmempoolentry` and `gettxspendingprevout` provide the live view. Detached transactions are not automatically called pending: an unindexed, unconfirmed transaction needs a fresh successful `getmempoolentry` lookup. The explorer never submits transactions or forces rejected or coinbase transactions into the node's mempool. The mempool list is cached for up to five seconds, invalidated when the indexed chain changes; transaction membership does not use that cache. The displayed prevouts of unconfirmed transactions can be resolved through RPC, including unconfirmed parents. RPC failures are not presented as an empty mempool. Pending-spend lookups are best effort; “unspent in indexed chain” is not a promise that no pending claim exists.

**Balances and bounties:** totals and catalogue filters cover only the confirmed indexed chain, excluding mempool activity. They can be incomplete during backfill or node synchronization. An address balance includes immature coinbase outputs; it is not a wallet's immediately spendable balance. A domain is a bounty target, not the recipient or owner of the funded value. The wallet's discovery window is not an expiry rule and does not hide older outputs here.

**Proofs:** the decoder accepts **only the domain-only P2C v2 TLS profile** and checks framing, challenge binding and work hash. Versions other than 2 return HTTP 422. The connection work is `TaggedHash("ConnectCoin/P2C/work/v2", ClientHello || ServerHello || EncryptedExtensions || Certificate)`, including those four complete handshake headers. The version byte and **the entire CertificateVerify message** (header, lengths, scheme and signature) are excluded. CertificateVerify remains mandatory for authentication; its selected scheme must be offered by ClientHello and be `0x0403` (`ecdsa_secp256r1_sha256`), `0x0804` (`rsa_pss_rsae_sha256`) or `0x0809` (`rsa_pss_pss_sha256`). Consensus additionally requires that the spent output's mask allow that scheme; the explorer displays this comparison separately when the mask is known. These are not the issuer-signature algorithms of the X.509 certificates.

The claim challenge deliberately retains the tag `ConnectCoin/P2C/claim/v1`: it hashes the final non-witness transaction ID in internal byte order followed by the little-endian input index. That tag is not legacy proof support. `workHash` is displayed in reversed uint256/RPC byte order; `transcriptHash` is the ordinary SHA-256 digest over the same four messages, in TLS byte order.

The explorer does **not** independently validate the TLS signature, root trust, domain authorization, consensus rules or historical MTP certificate validity. Those belong to the node. Certificate dates are historical display metadata; a certificate expiring today does not invalidate an old confirmed claim. Expected attempts are a probability estimate, not the number of connections actually made. Root certificates version **1** is separate from proof version **2**. The genesis allocation is not a current balance, and `MAX_MONEY` is a validation bound, not circulating supply.

## Deployment and security

The browser calls only the explorer API. Node credentials and cookies remain on the server. There is no arbitrary RPC proxy, wallet API, send-transaction action or private-key handling. The RPC client has a read-only method allowlist, deadlines, response-size bounds and sanitized errors. The API rejects write methods and sets restrictive production browser headers.

Run one explorer process per SQLite database on local persistent storage. A process supervisor should restart it after a host reboot. Stop it gracefully before moving or backing up the database; SQLite WAL files are part of the live state. Do not run two independent index writers on the same file.

For public access, place the **production** build behind an HTTPS reverse proxy with request/concurrency limits. Bind to another interface only deliberately, e.g. `--host 0.0.0.0`. Keep the node RPC private on loopback or a restricted authenticated network; expose only the explorer HTTP port. Never expose the Vite development server publicly. No public hosting, DNS changes or node firewall changes are performed by this repository.

Budget storage for indexed transactions and P2C witnesses. Individual protocol-limit blocks can expand to hundreds of MB of decoded RPC JSON, so provide several GB of RAM and measure resource usage against your actual chain before public deployment. This first version has not been load-tested against a full production-sized chain.

`GET /api/health` returns 200 only when the node is reachable, out of initial block download, and the index has caught up; otherwise 503. `GET /api/status` includes network, connection, index height and any operational warning. `GET /api/network` exposes the current network/protocol catalog and the observed RPC genesis, never credentials or local paths. When offline, current-chain indexed pages can still be read with a visible cached-data warning. An incompatible saved genesis is rejected at startup, rather than serving cached balances from an old chain.

HTTP bind errors (for example, a privileged or occupied port) do not start indexing or announce a listening server. Graceful shutdown waits for active HTTP requests and index polling before closing SQLite.

## Development

```sh
npm run dev -- --testnet
npm run typecheck
npm test
npm run build
npm run format:check
```

The development command accepts the same network, RPC and database options as `npm start`. Tests use local fixture RPC servers and temporary SQLite files; they do not connect to or modify a wallet. Coverage includes monetary precision, typed outputs and their signature masks, v2-only proof framing/hash checks and CertificateVerify exclusion, per-output signature-scheme comparisons, RPC authentication/errors/large responses, API routes, pagination, current genesis headers/network selection, legacy-index rejection without deletion, restart/reorg rollback and HTTP startup/shutdown races.

Source layout: `src/server` contains RPC, indexing, proof decoding and HTTP routes; `src/shared` contains the API model; `src/client` contains the React interface. Vite builds the frontend into `dist/client`, and TypeScript builds the backend into `dist/server`.
