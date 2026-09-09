import { createServer, type RequestListener } from 'node:http';

interface HttpLifecycleOptions {
  listener: RequestListener;
  host: string;
  port: number;
  onListening(): void;
  onStopping(): void;
  waitForWork(): Promise<unknown> | undefined;
  waitForRequests?(): Promise<void>;
  closeResources(): Promise<void> | void;
  onError(error: Error): void;
}

/** Keep the database alive until both HTTP handlers and background work finish. */
export function startHttpServer(options: HttpLifecycleOptions) {
  const server = createServer(options.listener);
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  let stopping = false;
  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    options.onStopping();
    const serverClosed = new Promise<void>((resolve, reject) => {
      server.close((error?: NodeJS.ErrnoException) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
    });
    shutdownPromise = (async () => {
      // A failure in one task must not close resources underneath another task.
      // After all sockets close, no more handlers can start. An aborted client's
      // async handler can still be running, so explicitly drain those as well.
      const requestsDrained = serverClosed.then(() => options.waitForRequests?.());
      const results = await Promise.allSettled([requestsDrained, options.waitForWork()]);
      await options.closeResources();
      const failed = results.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    })();
    return shutdownPromise;
  }

  function fail(error: Error) {
    options.onError(error);
    void shutdown().catch(options.onError);
  }

  // Express 5's app.listen callback also runs on bind failure. A native
  // listening event only fires after the socket was actually bound.
  server.once('listening', () => {
    if (!stopping) options.onListening();
  });
  server.on('error', fail);
  try {
    server.listen(options.port, options.host);
  } catch (error) {
    fail(error instanceof Error ? error : new Error(String(error)));
  }
  return { server, shutdown };
}
