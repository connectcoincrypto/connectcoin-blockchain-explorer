import React, { createContext, useContext, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useLocation,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Box,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  Clock3,
  Copy,
  Database,
  Download,
  FileCheck2,
  Globe2,
  Layers,
  Search,
  Wifi,
  Zap,
} from 'lucide-react';
import type {
  AccountSummary,
  BlockSummary,
  Bounty,
  ExplorerStatus,
  IndexOverview,
  Page,
  Transaction,
  TransactionSummary,
  TxInput,
  TxOutput,
} from '../shared/types';
import { outputLabel } from '../shared/types';
import './style.css';

function useApi<T>(url: string, interval = 0) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true,
      running = false;
    const abort = new AbortController();
    setData(undefined);
    setError('');
    const load = async () => {
      if (running) return;
      running = true;
      try {
        const response = await fetch(url, { signal: abort.signal });
        const json = await response.json();
        if (!response.ok) throw new Error(json.error ?? 'Request failed.');
        if (active) {
          setData(json);
          setError('');
        }
      } catch (e) {
        if (active && !abort.signal.aborted) {
          setData(undefined);
          setError(e instanceof Error ? e.message : 'Connection unavailable.');
        }
      } finally {
        running = false;
      }
    };
    void load();
    const timer = interval
      ? setInterval(() => {
          void load();
        }, interval)
      : undefined;
    return () => {
      active = false;
      abort.abort();
      if (timer) clearInterval(timer);
    };
  }, [url, interval, revision]);
  return { data, error, reload: () => setRevision((r) => r + 1) };
}
const StatusContext = createContext<ExplorerStatus | undefined>(undefined);
const short = (s?: string, length = 10) => (s ? `${s.slice(0, length)}…${s.slice(-6)}` : '—');
const number = (n?: number) => (n === undefined ? '—' : n.toLocaleString('en-US'));
function money(value?: string, unit = true) {
  if (value === undefined) return '—';
  try {
    const n = BigInt(value),
      negative = n < 0n,
      a = negative ? -n : n;
    const fraction = (a % 10_000_000_000n).toString().padStart(10, '0').replace(/0+$/, '');
    return `${negative ? '-' : ''}${(a / 10_000_000_000n).toLocaleString('en-US')}${fraction ? `.${fraction}` : ''}${unit ? ' CC' : ''}`;
  } catch {
    return '—';
  }
}
const date = (time?: number) =>
  time === undefined
    ? '—'
    : new Date(time * 1000).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'medium' });
function ago(time?: number) {
  if (time === undefined) return '—';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - time));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}
function bytes(n?: number) {
  if (n === undefined) return '—';
  if (n < 1000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)} kB`;
  return `${(n / 1_000_000).toFixed(2)} MB`;
}
function hashrate(n?: number) {
  if (n === undefined) return '—';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)} GH/s`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)} MH/s`;
  if (n >= 1000) return `${(n / 1000).toFixed(2)} kH/s`;
  return `${n.toFixed(2)} H/s`;
}
function attempts(target?: string) {
  try {
    if (!target || !/^[a-f0-9]{64}$/i.test(target)) return '—';
    const expected = Number(1n << 256n) / Number(BigInt(`0x${target}`) + 1n);
    return `~${expected >= 1e9 ? expected.toExponential(3) : expected.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  } catch {
    return '—';
  }
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy"
      aria-label="Copy to clipboard"
      title="Copy"
      onClick={() => {
        void navigator.clipboard
          .writeText(value)
          .then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          })
          .catch(() => setCopied(false));
      }}
    >
      {copied ? <Check size={15} /> : <Copy size={15} />}
    </button>
  );
}
function HashValue({ value, to, full = false }: { value?: string; to?: string; full?: boolean }) {
  if (!value) return <>—</>;
  return (
    <span className={`hash-value ${full ? 'full' : ''}`}>
      {to ? (
        <Link className="mono hash" title={value} to={to}>
          {full ? value : short(value)}
        </Link>
      ) : (
        <span className="mono hash" title={value}>
          {full ? value : short(value)}
        </span>
      )}
      <CopyButton value={value} />
    </span>
  );
}
function Badge({ children, tone = '' }: { children: React.ReactNode; tone?: string }) {
  return <span className={`badge ${tone}`}>{children}</span>;
}
function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="empty">
      <Layers size={27} />
      <strong>{title}</strong>
      {detail && <p>{detail}</p>}
    </div>
  );
}
function Load({ error, retry }: { error?: string; retry?: () => void }) {
  return error ? (
    <div className="error-panel" role="alert">
      <CircleAlert />
      <div>
        <strong>Unable to load this view</strong>
        <p>{error}</p>
        {retry && (
          <button className="button secondary" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
  ) : (
    <div className="loading" role="status">
      <span className="spinner" />
      Loading from the explorer…
    </div>
  );
}
function Pager({
  page,
  total,
  pageSize,
  onChange,
}: {
  page: number;
  total: number;
  pageSize: number;
  onChange: (page: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="pager">
      <span>
        {number(total)} {total === 1 ? 'result' : 'results'} · page {page} of {number(pages)}
      </span>
      <div>
        <button aria-label="Previous page" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          <ChevronLeft size={18} />
        </button>
        <button aria-label="Next page" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
function usePage(key = 'page') {
  const [params, setParams] = useSearchParams();
  const raw = Number(params.get(key) ?? 1);
  const page = Number.isSafeInteger(raw) && raw > 0 ? raw : 1;
  return [
    page,
    (n: number) => {
      const next = new URLSearchParams(params);
      next.set(key, String(n));
      setParams(next);
    },
  ] as const;
}
function SearchBox({ large = false }: { large?: boolean }) {
  const [query, setQuery] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  return (
    <form
      className={`search-form ${large ? 'large' : ''}`}
      onSubmit={(e) => {
        e.preventDefault();
        if (busy || !query.trim()) return;
        setBusy(true);
        setError('');
        void fetch(`/api/search?q=${encodeURIComponent(query.trim())}`)
          .then(async (res) => {
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            navigate(data.path);
            setQuery('');
          })
          .catch((e) => setError(e.message))
          .finally(() => setBusy(false));
      }}
    >
      <Search size={20} />
      <input
        aria-label="Search blockchain"
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setError('');
        }}
        placeholder="Search by address, transaction hash, block or domain"
        maxLength={256}
      />
      <button disabled={busy} aria-label="Search">
        {busy ? <span className="spinner" /> : <ArrowRight size={20} />}
      </button>
      {error && (
        <p role="alert" className="search-error">
          {error}
        </p>
      )}
    </form>
  );
}
function Layout() {
  const api = useApi<ExplorerStatus>('/api/status', 5000),
    status = api.data;
  useEffect(() => {
    if (status) document.title = status.title;
  }, [status?.title]);
  return (
    <StatusContext.Provider value={status}>
      <div className="site">
        <header className="header">
          <div className="header-top wrap">
            <Link to="/" className="brand">
              <img src="/favicon.svg" alt="" />
              <span>{status?.title ?? 'ConnectCoin Explorer'}</span>
            </Link>
            <div className="connection">
              <span className={`status-dot ${status?.connected ? 'online' : ''}`} />
              {status?.connected ? (status.syncing ? 'Indexing' : 'Node connected') : 'Node unavailable'}
              {status && (
                <Badge tone="network">
                  {status.network === 'testnet4' ? 'TESTNET 4' : status.network.toUpperCase()}
                </Badge>
              )}
            </div>
          </div>
          <div className="nav-row wrap">
            <nav aria-label="Main navigation">
              <NavLink to="/" end>
                <Layers size={16} />
                Overview
              </NavLink>
              <NavLink to="/blocks">
                <Box size={16} />
                Blocks
              </NavLink>
              <NavLink to="/mempool">
                <Zap size={16} />
                Mempool
              </NavLink>
              <NavLink to="/bounties">
                <Globe2 size={16} />
                P2C bounties
              </NavLink>
            </nav>
            <span className="protocol-label">Powered by ConnectCoin RPC</span>
          </div>
        </header>
        <main className="wrap main">
          {(api.error || status?.error) && (
            <div className="notice warn" role="status">
              <CircleAlert size={18} />
              <span>
                {api.error || status?.error}{' '}
                {status && status.indexedHeight >= 0
                  ? `Showing cached chain data through block ${number(status.indexedHeight)}.`
                  : ''}
              </span>
            </div>
          )}
          {status?.connected && (status.syncing || status.initialBlockDownload) && (
            <div className="notice">
              <Database size={18} />
              <span>
                {status.initialBlockDownload ? 'Node is synchronizing with the network. ' : ''}Explorer
                indexed {number(status.indexedHeight)} of {number(status.nodeHeight)} blocks. Address and
                domain history may be incomplete.
              </span>
            </div>
          )}
          <Routes>
            <Route path="/" element={<Overview />} />
            <Route path="/blocks" element={<Blocks />} />
            <Route path="/block/:id" element={<BlockDetail />} />
            <Route path="/tx/:id" element={<TransactionDetail />} />
            <Route path="/mempool" element={<Mempool />} />
            <Route path="/bounties" element={<Bounties />} />
            <Route path="/address/:address" element={<Account kind="address" />} />
            <Route path="/domain/:domain" element={<Account kind="domain" />} />
            <Route
              path="*"
              element={
                <Empty
                  title="Page not found"
                  detail="Use the search to find a block, transaction, address or domain."
                />
              }
            />
          </Routes>
        </main>
        <footer className="wrap footer">
          <span>
            ConnectCoin <span className="muted">/</span> Open blockchain data
          </span>
          <span>
            {status?.network !== 'main' ? 'Test network · test coins have no mainnet balance' : 'Mainnet'}{' '}
            <span className="footer-dot">·</span> 1 CC = 10¹⁰ connects
          </span>
        </footer>
      </div>
    </StatusContext.Provider>
  );
}
function Heading({
  eyebrow,
  title,
  action,
  children,
}: {
  eyebrow?: string;
  title: string;
  action?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-heading">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {children}
      </div>
      {action}
    </div>
  );
}
function Metric({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  icon: React.ReactNode;
}) {
  return (
    <div className="metric">
      <div className="metric-label">
        {label}
        {icon}
      </div>
      <div className="metric-value">{value}</div>
      <div className="metric-sub">{sub}</div>
    </div>
  );
}
function Panel({
  title,
  link,
  children,
}: {
  title: string;
  link?: { to: string; label: string };
  children: React.ReactNode;
}) {
  return (
    <section className="panel">
      <div className="panel-heading">
        <h2>{title}</h2>
        {link && (
          <Link className="text-link" to={link.to}>
            {link.label}
            <ArrowUpRight size={15} />
          </Link>
        )}
      </div>
      {children}
    </section>
  );
}
function BlockTable({ blocks }: { blocks: BlockSummary[] }) {
  if (!blocks.length)
    return (
      <Empty
        title="No indexed blocks yet"
        detail="Blocks will appear after the RPC connection is available."
      />
    );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Height</th>
            <th>Block hash</th>
            <th>Transactions</th>
            <th>Size</th>
            <th className="right">Age</th>
          </tr>
        </thead>
        <tbody>
          {blocks.map((b) => (
            <tr key={b.hash}>
              <td>
                <Link className="block-link mono" to={`/block/${b.height}`}>
                  <Box size={16} />
                  {number(b.height)}
                </Link>
              </td>
              <td>
                <HashValue value={b.hash} to={`/block/${b.hash}`} />
              </td>
              <td>{number(b.txCount)}</td>
              <td className="muted">{bytes(b.size)}</td>
              <td className="right muted" title={date(b.time)}>
                {ago(b.time)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function TxTable({ transactions }: { transactions: TransactionSummary[] }) {
  if (!transactions.length) return <Empty title="No transactions" />;
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Transaction</th>
            <th>Outputs</th>
            <th>Type</th>
            <th className="right">Output value</th>
          </tr>
        </thead>
        <tbody>
          {transactions.map((tx) => (
            <tr key={tx.txid}>
              <td>
                <HashValue value={tx.txid} to={`/tx/${tx.txid}`} />
              </td>
              <td>{number(tx.outputCount)}</td>
              <td>{tx.p2cCount ? <Badge tone="p2c">P2C × {tx.p2cCount}</Badge> : <Badge>P2PK</Badge>}</td>
              <td className="right mono">{money(tx.totalOutput)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
function Overview() {
  const api = useApi<{ status: ExplorerStatus; index: IndexOverview; blocks: Page<BlockSummary> }>(
    '/api/overview',
    10000,
  );
  const pool = useApi<Page<{ txid: string; time: number; vsize: number; fee: string }>>(
    '/api/mempool',
    10000,
  );
  const s = api.data?.status,
    index = api.data?.index;
  return (
    <>
      <Heading
        eyebrow="NETWORK OVERVIEW"
        title="The chain, in view."
        action={
          <span className="live-label">
            <span className={`status-dot ${s?.connected ? 'online' : ''}`} />
            {s?.lastUpdated ? `Updated ${ago(s.lastUpdated / 1000)}` : 'Waiting for node'}
          </span>
        }
      />
      <SearchBox large />
      <div className="metrics">
        <Metric
          label="Block height"
          value={number(s?.nodeHeight)}
          sub={
            <>
              Target interval <strong>{s?.network === 'regtest' ? '10 minutes' : '10 seconds'}</strong>
            </>
          }
          icon={<Box size={18} />}
        />
        <Metric
          label="Network hashrate"
          value={hashrate(s?.networkHashps)}
          sub="RandomX v2 proof of work"
          icon={<Zap size={18} />}
        />
        <Metric
          label="Mempool"
          value={number(s?.mempoolCount)}
          sub={<>{bytes(s?.mempoolBytes)} awaiting confirmation</>}
          icon={<Layers size={18} />}
        />
        <Metric
          label="Available P2C bounties"
          value={number(index?.availableBountyCount)}
          sub={money(index?.availableBountyValue)}
          icon={<Globe2 size={18} />}
        />
      </div>
      <div className="overview-grid">
        <Panel title="Latest blocks" link={{ to: '/blocks', label: 'All blocks' }}>
          {api.data ? (
            <BlockTable blocks={api.data.blocks.items} />
          ) : (
            <Load error={api.error} retry={api.reload} />
          )}
        </Panel>
        <section className="p2c-feature">
          <div className="p2c-feature-top">
            <span className="eyebrow">PAY-TO-CONNECT</span>
            <Globe2 size={36} strokeWidth={1.2} />
          </div>
          <h2>
            Explore connection
            <br />
            bounties.
          </h2>
          <p>Browse rewards by domain and follow their TLS proofs from creation to claim.</p>
          <div className="feature-total">
            <span>Unclaimed rewards · indexed chain</span>
            <strong>{money(index?.availableBountyValue)}</strong>
          </div>
          <Link to="/bounties" className="feature-link">
            Browse P2C bounties
            <ArrowUpRight size={20} />
          </Link>
        </section>
      </div>
      <div className="overview-grid lower">
        <Panel title="Pending transactions" link={{ to: '/mempool', label: 'View mempool' }}>
          {pool.data ? (
            pool.data.items.length ? (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Transaction</th>
                      <th>Size</th>
                      <th className="right">Fee</th>
                    </tr>
                  </thead>
                  <tbody>
                    {pool.data.items.slice(0, 5).map((tx) => (
                      <tr key={tx.txid}>
                        <td>
                          <HashValue value={tx.txid} to={`/tx/${tx.txid}`} />
                        </td>
                        <td className="muted">{number(tx.vsize)} vB</td>
                        <td className="right mono">{money(tx.fee)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="Mempool is clear" detail="No pending transactions reported by this node." />
            )
          ) : pool.error ? (
            <Empty title="Mempool unavailable" detail="Live RPC access is required." />
          ) : (
            <Load />
          )}
        </Panel>
        <Panel title="Explorer index">
          <dl className="compact-dl">
            <div>
              <dt>Blocks indexed</dt>
              <dd>{number(index?.blockCount)}</dd>
            </div>
            <div>
              <dt>Transactions indexed</dt>
              <dd>{number(index?.transactionCount)}</dd>
            </div>
            <div>
              <dt>P2C outputs indexed</dt>
              <dd>{number(index?.bountyCount)}</dd>
            </div>
            <div>
              <dt>Node peers</dt>
              <dd>{number(s?.connections)}</dd>
            </div>
            <div>
              <dt>Network</dt>
              <dd>{s?.chain ?? '—'}</dd>
            </div>
          </dl>
        </Panel>
      </div>
    </>
  );
}
function Blocks() {
  const [page, setPage] = usePage();
  const api = useApi<Page<BlockSummary>>(`/api/blocks?page=${page}`, 15000);
  return (
    <>
      <Heading eyebrow="BLOCKCHAIN" title="Blocks" />
      <SearchBox />
      <Panel title="Confirmed blocks">
        {api.data ? (
          <>
            <BlockTable blocks={api.data.items} />
            <Pager {...api.data} onChange={setPage} />
          </>
        ) : (
          <Load error={api.error} retry={api.reload} />
        )}
      </Panel>
    </>
  );
}
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <dt>{label}</dt>
      <dd>{children ?? '—'}</dd>
    </div>
  );
}
function BlockDetail() {
  const { id } = useParams();
  const [page, setPage] = usePage();
  const api = useApi<{ block: BlockSummary; transactions: Page<TransactionSummary>; confirmations: number }>(
    `/api/blocks/${id}?page=${page}`,
    15000,
  );
  const b = api.data?.block;
  return (
    <>
      <Link className="back-link" to="/blocks">
        <ChevronLeft size={16} />
        All blocks
      </Link>
      <Heading
        eyebrow="BLOCK DETAILS"
        title={`Block ${b ? number(b.height) : id && /^\d+$/.test(id) ? id : ''}`}
        action={
          api.data && (
            <Badge tone="success">
              <Check size={13} />
              {number(api.data.confirmations)} confirmations
            </Badge>
          )
        }
      />
      {!api.data || !b ? (
        <Load error={api.error} retry={api.reload} />
      ) : (
        <>
          <section className="panel details">
            <dl>
              <Field label="Block hash">
                <HashValue value={b.hash} full />
              </Field>
              <div className="field-grid">
                <Field label="Timestamp">{date(b.time)}</Field>
                <Field label="Transactions">{number(b.txCount)}</Field>
                <Field label="Block size">{bytes(b.size)}</Field>
                <Field label="Weight">{number(b.weight)} WU</Field>
                <Field label="Difficulty">
                  <span className="mono">{b.difficulty}</span>
                </Field>
                <Field label="Nonce">
                  <span className="mono">{number(b.nonce)}</span>
                </Field>
                <Field label="Bits">
                  <span className="mono">{b.bits}</span>
                </Field>
                <Field label="Version">{b.version}</Field>
              </div>
              <Field label="Merkle root">
                <HashValue value={b.merkleRoot} full />
              </Field>
              <Field label="Previous block">
                {b.previousHash ? (
                  <HashValue value={b.previousHash} to={`/block/${b.previousHash}`} />
                ) : (
                  'Genesis block'
                )}
              </Field>
              {b.nextHash && (
                <Field label="Next block">
                  <HashValue value={b.nextHash} to={`/block/${b.nextHash}`} />
                </Field>
              )}
            </dl>
          </section>
          <Panel title="Transactions">
            <TxTable transactions={api.data.transactions.items} />
            <Pager {...api.data.transactions} onChange={setPage} />
          </Panel>
        </>
      )}
    </>
  );
}
type TxResponse = Omit<Transaction, 'inputs' | 'outputs'> & {
  inputs: Page<TxInput & { hasProof: boolean; witnessCount: number }>;
  outputs: Page<TxOutput>;
  totalOutput: string;
  confirmations?: number;
};
function OutputCard({
  output,
  txid,
  confirmed = true,
}: {
  output: TxOutput;
  txid?: string;
  confirmed?: boolean;
}) {
  const o = output;
  return (
    <article className={`output-card ${o.type === 2 ? 'p2c-output' : ''}`} id={`output-${o.index}`}>
      <div className="output-top">
        <span className="output-index">OUTPUT #{o.index}</span>
        <strong className="mono">{money(o.value)}</strong>
      </div>
      <p className="output-type">{outputLabel(o.type)}</p>
      {o.type === 1 && (
        <>
          <div className="output-destination">
            <ArrowUpRight size={16} />
            <HashValue value={o.address} to={o.address ? `/address/${o.address}` : undefined} />
          </div>
          <div className="output-property">
            <span>Public key</span>
            <HashValue value={o.pubkey} />
          </div>
        </>
      )}
      {o.type === 2 && (
        <>
          <Link className="domain-link" to={`/domain/${o.domain}`}>
            <Globe2 size={17} />
            {o.domain}
            <ArrowUpRight size={14} />
          </Link>
          <div className="output-property">
            <span>Work target</span>
            <HashValue value={o.target} />
          </div>
          <div className="output-property">
            <span>Expected attempts</span>
            <strong>{attempts(o.target)}</strong>
          </div>
          <div className="output-property">
            <span>Root certificates version</span>
            <strong>{o.rootsVersion ?? '—'}</strong>
          </div>
        </>
      )}
      <div className="output-footer">
        {o.spent ? (
          <>
            <Badge tone={o.spent.confirmed ? '' : 'pending'}>
              {o.spent.confirmed ? 'Spent' : 'Spend pending'}
            </Badge>
            <Link to={`/tx/${o.spent.txid}`}>
              Spending transaction
              <ArrowUpRight size={13} />
            </Link>
          </>
        ) : (
          <Badge tone={confirmed ? 'success' : 'pending'}>
            {confirmed ? 'Unspent in indexed chain' : 'Unconfirmed output'}
          </Badge>
        )}
        {txid && (
          <Link className="muted mono" to={`/tx/${txid}`}>
            {short(txid, 6)}
          </Link>
        )}
      </div>
    </article>
  );
}
function TransactionDetail() {
  const { id } = useParams();
  const [inputsPage, setInputsPage] = usePage('inputsPage'),
    [outputsPage, setOutputsPage] = usePage('outputsPage');
  const api = useApi<TxResponse>(
    `/api/transactions/${id}?inputsPage=${inputsPage}&outputsPage=${outputsPage}`,
    15000,
  );
  const [proof, setProof] = useState<number>();
  useEffect(() => {
    setProof(undefined);
  }, [id]);
  const tx = api.data;
  const { hash: anchor } = useLocation();
  useEffect(() => {
    if (tx && /^#output-\d+$/.test(anchor))
      document.getElementById(anchor.slice(1))?.scrollIntoView({ block: 'center' });
  }, [tx?.txid, outputsPage, Boolean(tx), anchor]);
  return (
    <>
      <Link to="/" className="back-link">
        <ChevronLeft size={16} />
        Overview
      </Link>
      <Heading
        eyebrow="TRANSACTION DETAILS"
        title="Transaction"
        action={
          tx && (
            <Badge tone={tx.blockHash ? 'success' : 'pending'}>
              {tx.blockHash
                ? `${tx.confirmations !== undefined ? `${number(tx.confirmations)} confirmations` : 'Confirmed · indexing'}`
                : 'In mempool'}
            </Badge>
          )
        }
      />
      {!tx ? (
        <Load error={api.error} retry={api.reload} />
      ) : (
        <>
          <section className="panel details">
            <dl>
              <Field label="Transaction ID">
                <HashValue value={tx.txid} full />
              </Field>
              <div className="field-grid">
                <Field label="Included in block">
                  {tx.blockHash ? (
                    <Link to={`/block/${tx.blockHash}`}>
                      {tx.height !== undefined ? number(tx.height) : short(tx.blockHash)}
                    </Link>
                  ) : (
                    'Awaiting confirmation'
                  )}
                </Field>
                <Field label="Timestamp">{date(tx.time)}</Field>
                <Field label="Total output value">
                  <span className="mono">{money(tx.totalOutput)}</span>
                </Field>
                <Field label="Transaction fee">
                  <span className="mono">
                    {tx.inputs.items.some((i) => i.coinbase !== undefined)
                      ? 'Coinbase · no fee'
                      : money(tx.fee)}
                  </span>
                </Field>
                <Field label="Size / virtual size">
                  {bytes(tx.size)} / {number(tx.vsize)} vB
                </Field>
                <Field label="Weight">{number(tx.weight)} WU</Field>
              </div>
              <Field label="Witness transaction ID">
                <HashValue value={tx.wtxid} full />
              </Field>
            </dl>
          </section>
          <div className="flow-heading">
            <h2>Transaction flow</h2>
            <span>
              {number(tx.inputs.total)} inputs <ArrowRight size={15} /> {number(tx.outputs.total)} outputs
            </span>
          </div>
          <div className="flow-grid">
            <section>
              <div className="flow-label">
                <ArrowDownLeft size={18} />
                Inputs <Badge>{tx.inputs.total}</Badge>
              </div>
              {tx.inputs.items.map((input) => (
                <article className="input-card" key={input.index}>
                  <div className="output-top">
                    <span className="output-index">INPUT #{input.index}</span>
                    <strong className="mono">{money(input.value)}</strong>
                  </div>
                  {input.coinbase !== undefined ? (
                    <>
                      <Badge>Coinbase</Badge>
                      <p className="muted">New block reward and collected fees.</p>
                      <details>
                        <summary>Coinbase data</summary>
                        <code className="raw-data">{input.coinbase}</code>
                      </details>
                    </>
                  ) : (
                    <>
                      <div className="input-source">
                        <HashValue
                          value={input.txid}
                          to={`/tx/${input.txid}?outputsPage=${Math.floor((input.vout ?? 0) / 20) + 1}#output-${input.vout}`}
                        />
                        <span className="muted">output #{input.vout}</span>
                      </div>
                      {input.outputType !== undefined && (
                        <p className="output-type">{outputLabel(input.outputType)}</p>
                      )}
                      {input.domain ? (
                        <Link className="domain-link" to={`/domain/${input.domain}`}>
                          <Globe2 size={16} />
                          {input.domain}
                        </Link>
                      ) : input.address ? (
                        <HashValue value={input.address} to={`/address/${input.address}`} />
                      ) : (
                        <p className="muted small">Previous output not indexed yet.</p>
                      )}
                      {input.hasProof && (
                        <button className="proof-button" onClick={() => setProof(input.index)}>
                          <FileCheck2 size={17} />
                          Inspect TLS connection proof
                          <ArrowUpRight size={15} />
                        </button>
                      )}
                      <div className="output-property">
                        <span>Sequence</span>
                        <span className="mono">{input.sequence}</span>
                      </div>
                    </>
                  )}
                </article>
              ))}
              {tx.inputs.total > 20 && <Pager {...tx.inputs} onChange={setInputsPage} />}
            </section>
            <section>
              <div className="flow-label">
                <ArrowUpRight size={18} />
                Outputs <Badge>{tx.outputs.total}</Badge>
              </div>
              {tx.outputs.items.map((output) => (
                <OutputCard output={output} key={output.index} confirmed={Boolean(tx.blockHash)} />
              ))}
              {tx.outputs.total > 20 && <Pager {...tx.outputs} onChange={setOutputsPage} />}
            </section>
          </div>
          {proof !== undefined && (
            <ProofPanel txid={tx.txid} index={proof} onClose={() => setProof(undefined)} />
          )}
        </>
      )}
    </>
  );
}
function ProofPanel({ txid, index, onClose }: { txid: string; index: number; onClose: () => void }) {
  const api = useApi<any>(`/api/transactions/${txid}/proof/${index}`);
  const p = api.data;
  useEffect(() => {
    document.getElementById('proof-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${txid}-input-${index}-proof.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return (
    <section className="panel proof-panel" id="proof-panel">
      <div className="panel-heading">
        <h2>
          <FileCheck2 size={20} />
          TLS connection proof · input #{index}
        </h2>
        <button className="button secondary" onClick={onClose}>
          Close
        </button>
      </div>
      {!p ? (
        <Load error={api.error} />
      ) : (
        <div className="proof-content">
          <div className="proof-checks">
            <Badge tone={p.challengeMatches ? 'success' : 'warn'}>
              {p.challengeMatches ? 'Challenge matches' : 'Challenge mismatch'}
            </Badge>
            {p.meetsTarget !== undefined && (
              <Badge tone={p.meetsTarget ? 'success' : 'warn'}>
                {p.meetsTarget ? 'Work target met' : 'Work target not met'}
              </Badge>
            )}
            <button className="button secondary" onClick={download}>
              <Download size={15} />
              Download JSON
            </button>
          </div>
          <p className="muted small">
            These are decoding and hash checks. Full TLS signature, certificate trust and consensus validation
            are performed by the node.
          </p>
          <dl>
            <div className="field-grid">
              <Field label="Proof version">{p.version}</Field>
              <Field label="Proof size">{bytes(p.byteLength)}</Field>
              <Field label="TLS cipher suite">{p.cipherSuite?.name ?? '—'}</Field>
              <Field label="Signature scheme">{p.signatureScheme?.name ?? '—'}</Field>
            </div>
            <Field label="Work hash">
              <HashValue value={p.workHash} full />
            </Field>
            <Field label="ClientHello challenge">
              <HashValue value={p.challenge} full />
            </Field>
            <Field label="Expected challenge">
              <HashValue value={p.expectedChallenge} full />
            </Field>
          </dl>
          <h3>Handshake messages</h3>
          <div className="handshake">
            {p.messages.map((m: any, i: number) => (
              <div key={m.name}>
                <span>{i + 1}</span>
                <strong>{m.name}</strong>
                <small>{bytes(m.length)}</small>
              </div>
            ))}
          </div>
          <h3>Certificate chain</h3>
          {p.certificates.map((c: any, i: number) => (
            <details className="certificate" key={i} open={i === 0}>
              <summary>
                Certificate {i + 1} · {i === 0 ? 'Server certificate' : 'Intermediate'}
              </summary>
              <dl>
                <Field label="Subject">
                  <span className="multiline">{c.subject}</span>
                </Field>
                <Field label="Issuer">
                  <span className="multiline">{c.issuer}</span>
                </Field>
                <Field label="Validity">
                  {c.validFrom} — {c.validTo}
                </Field>
                <Field label="Subject alternative names">
                  <span className="break">{c.subjectAltName}</span>
                </Field>
                <Field label="SHA-256 fingerprint">
                  <span className="mono break">{c.fingerprint256}</span>
                </Field>
              </dl>
            </details>
          ))}
          <details className="certificate">
            <summary>Raw proof hexadecimal</summary>
            <div className="raw-toolbar">
              <CopyButton value={p.rawHex} />
            </div>
            <code className="raw-data">{p.rawHex}</code>
          </details>
        </div>
      )}
    </section>
  );
}
function Mempool() {
  const [page, setPage] = usePage();
  const api = useApi<Page<{ txid: string; time: number; vsize: number; fee: string; depends: number }>>(
    `/api/mempool?page=${page}`,
    10000,
  );
  return (
    <>
      <Heading eyebrow="LIVE NODE VIEW" title="Mempool">
        <p>Transactions waiting for confirmation on this node.</p>
      </Heading>
      <SearchBox />
      <Panel title="Pending transactions">
        {!api.data ? (
          <Load error={api.error} retry={api.reload} />
        ) : api.data.total ? (
          <>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Transaction</th>
                    <th>First seen</th>
                    <th>Virtual size</th>
                    <th>Fee</th>
                    <th className="right">Unconfirmed parents</th>
                  </tr>
                </thead>
                <tbody>
                  {api.data.items.map((tx) => (
                    <tr key={tx.txid}>
                      <td>
                        <HashValue value={tx.txid} to={`/tx/${tx.txid}`} />
                      </td>
                      <td className="muted" title={date(tx.time)}>
                        {ago(tx.time)}
                      </td>
                      <td>{number(tx.vsize)} vB</td>
                      <td className="mono">{money(tx.fee)}</td>
                      <td className="right">{tx.depends}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pager {...api.data} onChange={setPage} />
          </>
        ) : (
          <Empty title="Mempool is clear" detail="This node has no pending transactions." />
        )}
      </Panel>
    </>
  );
}
function Bounties() {
  const [params, setParams] = useSearchParams(),
    [page, setPage] = usePage();
  const state = params.get('state') ?? 'available',
    filter = params.get('domain') ?? '';
  const [draft, setDraft] = useState(filter);
  const api = useApi<Page<Bounty>>(
    `/api/bounties?page=${page}&state=${encodeURIComponent(state)}&domain=${encodeURIComponent(filter)}`,
    15000,
  );
  return (
    <>
      <Heading eyebrow="PAY-TO-CONNECT" title="P2C bounties">
        <p>Discover domain rewards and trace their claims on the indexed chain.</p>
      </Heading>
      <div className="filter-bar">
        <div className="segments" aria-label="Bounty state">
          {[
            ['available', 'Available'],
            ['spent', 'Claimed'],
            ['all', 'All outputs'],
          ].map(([key, label]) => (
            <button
              key={key}
              aria-pressed={state === key}
              className={state === key ? 'active' : ''}
              onClick={() => {
                const p = new URLSearchParams(params);
                p.set('state', key);
                p.set('page', '1');
                setParams(p);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <form
          className="domain-filter"
          onSubmit={(e) => {
            e.preventDefault();
            const p = new URLSearchParams(params);
            draft.trim() ? p.set('domain', draft.trim().toLowerCase()) : p.delete('domain');
            p.set('page', '1');
            setParams(p);
          }}
        >
          <Globe2 size={17} />
          <input
            aria-label="Filter by domain"
            placeholder="Filter by domain"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <button className="button secondary">Filter</button>
        </form>
      </div>
      <p className="scope-note">
        Availability reflects confirmed indexed spends. A pending claim can be inspected on the transaction
        page. Expected attempts are statistical, not measured connections.
      </p>
      {!api.data ? (
        <Load error={api.error} retry={api.reload} />
      ) : (
        <>
          {api.data.items.length ? (
            <div className="bounty-grid">
              {api.data.items.map((b) => (
                <OutputCard key={`${b.txid}:${b.index}`} output={b} txid={b.txid} />
              ))}
            </div>
          ) : (
            <section className="panel">
              <Empty
                title="No matching P2C outputs"
                detail={
                  filter
                    ? 'Try another domain or choose all outputs.'
                    : 'Bounties will appear here when P2C outputs are confirmed and indexed.'
                }
              />
            </section>
          )}
          <Pager {...api.data} onChange={setPage} />
        </>
      )}
    </>
  );
}
function Account({ kind }: { kind: 'address' | 'domain' }) {
  const params = useParams(),
    value = params[kind] ?? '';
  const [page, setPage] = usePage();
  const api = useApi<AccountSummary>(`/api/${kind}/${encodeURIComponent(value)}?page=${page}`, 15000);
  const a = api.data;
  return (
    <>
      <Link className="back-link" to={kind === 'domain' ? '/bounties' : '/'}>
        <ChevronLeft size={16} />
        {kind === 'domain' ? 'P2C bounties' : 'Overview'}
      </Link>
      <Heading
        eyebrow={kind === 'domain' ? 'DOMAIN ACTIVITY' : 'ADDRESS DETAILS'}
        title={kind === 'domain' ? value : 'Address'}
        action={kind === 'domain' && <Badge tone="p2c">pay-to-connect</Badge>}
      />
      {kind === 'address' && (
        <div className="address-strip">
          <HashValue value={value} full />
        </div>
      )}
      {!a ? (
        <Load error={api.error} retry={api.reload} />
      ) : (
        <>
          <div className="metrics account-metrics">
            <Metric
              label={kind === 'domain' ? 'Available rewards' : 'Confirmed balance'}
              value={money(a.balance)}
              sub={`${number(a.unspentCount)} unspent outputs`}
              icon={kind === 'domain' ? <Globe2 size={18} /> : <Database size={18} />}
            />
            <Metric
              label={kind === 'domain' ? 'Total rewards funded' : 'Total received'}
              value={money(a.totalReceived)}
              sub={`${number(a.outputCount)} outputs`}
              icon={<ArrowDownLeft size={18} />}
            />
            <Metric
              label={kind === 'domain' ? 'Rewards consumed by claims' : 'Total spent'}
              value={money(a.totalSent)}
              sub="Confirmed indexed transactions"
              icon={<ArrowUpRight size={18} />}
            />
          </div>
          <p className="scope-note">
            {kind === 'domain'
              ? 'A domain is a bounty target, not an owner or recipient of these rewards. '
              : ''}
            Totals exclude mempool activity and cover the currently indexed chain.
          </p>
          {kind === 'domain' && (
            <Link
              className="button secondary domain-action"
              to={`/bounties?domain=${encodeURIComponent(value)}`}
            >
              View available bounties
              <ArrowRight size={16} />
            </Link>
          )}
          <Panel title="Transaction history">
            <TxTable transactions={a.transactions.items} />
            <Pager {...a.transactions} onChange={setPage} />
          </Panel>
        </>
      )}
    </>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Layout />
    </BrowserRouter>
  </React.StrictMode>,
);
