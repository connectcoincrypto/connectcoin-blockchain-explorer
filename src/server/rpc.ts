import { readFile } from 'node:fs/promises';

export interface RpcConfig {
  url: string;
  user?: string;
  password?: string;
  cookieFile?: string;
  timeoutMs?: number;
}

const READ_ONLY_METHODS = new Set([
  'getblockchaininfo',
  'getblockhash',
  'getblock',
  'getblockheader',
  'getrawtransaction',
  'getrawmempool',
  'getmempoolinfo',
  'getmempoolentry',
  'getmininginfo',
  'getnetworkinfo',
  'getindexinfo',
  'gettxout',
  'gettxspendingprevout',
  'validateaddress',
  'getp2cchallenge',
  'decoderawtransaction',
]);

// Core permits 50,000,000 WU. getblock(..., 2) duplicates witness in hex and
// txinwitness (~200 MB). Output-dense blocks can exceed even 300 MB because
// compatibility script ASM expands target bytes into long opcode names.
// Allow that JSON expansion, remaining below V8's maximum string length.
const MAX_RESPONSE_BYTES = 512 * 1024 * 1024 - 1024;

export class RpcError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
  ) {
    super(message);
    this.name = 'RpcError';
  }
}

/** Monetary tokens must remain exact before any conversion to JavaScript numbers. */
export function parseRpcJson(text: string): any {
  type Reviver = (key: string, value: unknown, context?: { source?: string }) => unknown;
  const parse = JSON.parse as (source: string, reviver: Reviver) => any;
  return parse(text, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (!context?.source) throw new RpcError('Node.js 24 or newer is required for exact RPC amounts.');
    return context.source;
  });
}

function rpcFailure(code: unknown): RpcError {
  const number = Number(code);
  const safeCode = Number.isSafeInteger(number) ? number : undefined;
  const messages: Record<number, string> = {
    [-5]: 'The requested block, transaction, or output was not found by the node.',
    [-8]: 'The node rejected an RPC parameter.',
    [-28]: 'The node is starting up. Try again shortly.',
    [-32601]: 'The node does not support a required read-only RPC method.',
    [-32602]: 'The node rejected an RPC parameter.',
    [-32603]: 'The node reported an internal RPC error.',
  };
  return new RpcError(messages[number] ?? 'The node could not complete the RPC request.', safeCode);
}

export class RpcClient {
  readonly #url: string;
  readonly #config: RpcConfig;
  readonly #timeoutMs: number;
  #nextId = 0;

  constructor(config: RpcConfig) {
    let parsed: URL;
    try {
      parsed = new URL(config.url);
    } catch {
      throw new RpcError('The RPC URL is invalid.');
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
      throw new RpcError('Use an HTTP or HTTPS RPC URL without embedded credentials or a fragment.');
    }
    if ((config.user === undefined) !== (config.password === undefined)) {
      throw new RpcError('Both RPC username and password must be configured together.');
    }
    this.#timeoutMs = config.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new RpcError('The RPC timeout must be a positive integer.');
    }
    this.#url = parsed.toString();
    this.#config = { ...config };
  }

  async #authorization(): Promise<string | undefined> {
    let credentials: string;
    if (this.#config.user !== undefined) {
      if (this.#config.user.includes(':') || /[\r\n]/.test(this.#config.user + this.#config.password)) {
        throw new RpcError('The RPC credentials are not valid for HTTP Basic authentication.');
      }
      credentials = `${this.#config.user}:${this.#config.password}`;
    } else if (this.#config.cookieFile) {
      // The node replaces its cookie on restart: never cache credentials.
      try {
        credentials = (await readFile(this.#config.cookieFile, 'utf8')).trim();
      } catch {
        throw new RpcError('The RPC cookie could not be read. Check the node and cookie-file setting.');
      }
      const separator = credentials.indexOf(':');
      if (separator < 1 || separator === credentials.length - 1 || /[\r\n]/.test(credentials)) {
        throw new RpcError('The RPC cookie has an invalid format.');
      }
    } else {
      return undefined;
    }
    return `Basic ${Buffer.from(credentials, 'utf8').toString('base64')}`;
  }

  async call<T = any>(method: string, params: unknown[] = []): Promise<T> {
    if (!READ_ONLY_METHODS.has(method))
      throw new RpcError('This RPC method is not permitted by the explorer.');
    const authorization = await this.#authorization();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    timeout.unref();
    const id = String(++this.#nextId);
    try {
      const response = await fetch(this.#url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json', ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: controller.signal,
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        throw new RpcError('RPC authentication failed. Check the configured credentials or cookie file.');
      }
      const declaredLength = Number(response.headers.get('content-length'));
      if (declaredLength > MAX_RESPONSE_BYTES) {
        await response.body?.cancel();
        throw new RpcError('The node RPC response exceeds the allowed size.');
      }
      if (!response.body) throw new RpcError('The node returned an empty RPC response.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new RpcError('The node RPC response exceeds the allowed size.');
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      let envelope: any;
      try {
        envelope = parseRpcJson(Buffer.concat(chunks, total).toString('utf8'));
      } catch (error) {
        if (error instanceof RpcError) throw error;
        throw new RpcError('The node returned an invalid JSON RPC response.');
      }
      if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope) || envelope.id !== id) {
        throw new RpcError('The node returned an unexpected RPC response.');
      }
      if (envelope.error) throw rpcFailure(envelope.error.code);
      if (!response.ok) throw new RpcError('The node RPC HTTP request failed.');
      if (!Object.hasOwn(envelope, 'result'))
        throw new RpcError('The node RPC response is missing its result.');
      return envelope.result as T;
    } catch (error) {
      if (error instanceof RpcError) throw error;
      if (controller.signal.aborted) throw new RpcError('The node RPC request timed out.');
      // Never forward fetch errors, response messages, URLs, or authentication data.
      throw new RpcError('Unable to connect to the node RPC service.');
    } finally {
      clearTimeout(timeout);
    }
  }
}
