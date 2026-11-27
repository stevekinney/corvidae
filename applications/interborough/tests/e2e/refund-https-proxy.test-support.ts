import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { join } from 'node:path';

type DecisionCall = {
  readonly host: number;
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly started: number;
  response?: unknown;
  status?: number;
  finished?: number;
};

/** A single HTTPS origin forwarding each browser context to its own actual host. */
export async function startRefundProxy(directory: string) {
  const key = join(directory, 'proxy-key.pem');
  const certificate = join(directory, 'proxy-certificate.pem');
  const openssl = spawnWithHangGuard(
    [
      'openssl',
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      key,
      '-out',
      certificate,
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
    ],
    { stdout: 'ignore', stderr: 'pipe' },
  );
  const [stderr, exit] = await Promise.all([new Response(openssl.stderr).text(), openssl.exited]);
  if (exit !== 0) throw new Error(`Fixture certificate generation failed: ${stderr}`);
  const calls: DecisionCall[] = [];
  const reads: DecisionCall[] = [];
  const failures: unknown[] = [];
  const cancellations: Error[] = [];
  let phase = 'setup';
  let oldIdentity: string | undefined;
  let sequence = 0;
  const active = new Set<Promise<unknown>>();
  let targets: readonly string[] = [];
  let hostScript = '';
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { key: await Bun.file(key).text(), cert: await Bun.file(certificate).text() },
    // The failure is retained for drain(); the client also receives a non-success response.
    error() {
      return new Response('Fixture proxy request failed', { status: 502 });
    },
    fetch(request) {
      const path = new URL(request.url).pathname;
      const host = request.headers.get('x-refund-fixture-host');
      const ingressPhase = phase;
      const requestIdentity = request.headers.get('x-interborough-expected-identity');
      let procedure: string | undefined;
      let started: number | undefined;
      const work = (async () => {
        const selection = request.headers.get('x-refund-fixture-host');
        if (selection !== '0' && selection !== '1')
          return new Response('Unknown fixture host', { status: 400 });
        const index = Number(selection);
        if (!targets[index]) return new Response('Unknown fixture host', { status: 400 });
        const url = new URL(request.url);
        if (url.pathname === '/__refund-fixture/panel')
          return new Response(
            `<!doctype html><title>Reference host</title><div id="host-outlet"></div><script type="module">${hostScript}</script>`,
            { headers: { 'content-type': 'text/html' } },
          );
        const body =
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : await request.arrayBuffer();
        let call: DecisionCall | undefined;
        if (body && (url.pathname.endsWith('/jsonrpc') || url.pathname.endsWith('/tool-calls'))) {
          const payload = JSON.parse(new TextDecoder().decode(body)) as {
            method?: string;
            name?: string;
            params?: Record<string, unknown>;
            arguments?: Record<string, unknown>;
          };
          const name = payload.method ?? payload.name;
          procedure = name;
          if (
            name === 'bureau.reviews.resolve' ||
            name === 'bureau.reviews.get' ||
            name === 'bureau.reviews.list'
          ) {
            call = {
              host: index,
              name,
              input: payload.params ?? payload.arguments ?? {},
              started: ++sequence,
            };
            started = call.started;
            (name === 'bureau.reviews.resolve' ? calls : reads).push(call);
          }
        }
        const headers = new Headers(request.headers);
        headers.delete('x-refund-fixture-host');
        headers.set('host', url.host);
        const target = new URL(url.pathname + url.search, targets[index]);
        const response = await fetch(target, {
          method: request.method,
          headers,
          ...(body === undefined ? {} : { body }),
          redirect: 'manual',
          signal: request.signal,
        });
        if (response.status >= 500) {
          await response.body?.cancel();
          throw new Error(`Fixture upstream returned ${String(response.status)}`);
        }
        if (call) {
          call.status = response.status;
          call.response =
            response.status >= 400 &&
            response.status < 500 &&
            !response.headers.get('content-type')?.includes('application/json')
              ? await response.clone().text()
              : await response.clone().json();
          call.finished = ++sequence;
        }
        return response;
      })();
      active.add(work);
      void work.then(
        () => active.delete(work),
        (error) => {
          active.delete(work);
          const diagnostic = new Error(
            JSON.stringify({
              host,
              method: request.method,
              path,
              procedure,
              phase,
              ingressPhase,
              started,
              ingressAborted: request.signal.aborted,
              oldIdentity: oldIdentity !== undefined && requestIdentity === oldIdentity,
              error: String(error),
            }),
            { cause: error },
          );
          const aborted =
            request.signal.aborted && error instanceof Error && error.name === 'AbortError';
          const oldContextRead =
            oldIdentity !== undefined &&
            requestIdentity === oldIdentity &&
            procedure === 'bureau.contexts.get' &&
            ingressPhase === 'setup' &&
            phase === 'identity-change';
          if (
            host === '0' &&
            request.method === 'POST' &&
            path === '/jsonrpc' &&
            aborted &&
            (oldContextRead ||
              (procedure === 'bureau.reviews.list' &&
                (phase === 'waiting-for-claims' || phase === 'warning-decision')))
          )
            cancellations.push(diagnostic);
          else failures.push(diagnostic);
        },
      );
      return work;
    },
  });
  return {
    origin: `https://localhost:${proxy.port}`,
    calls,
    reads,
    cancellations,
    allowOldIdentityContextCancellation(identity: string) {
      if (!identity) throw new Error('Missing old identity');
      oldIdentity = identity;
    },
    setPhase(value: string) {
      phase = value;
    },
    setTargets(value: readonly string[]) {
      targets = value;
    },
    setHostScript(value: string) {
      hostScript = value;
    },
    async drain() {
      await Promise.allSettled(active);
      if (failures.length) throw new AggregateError(failures, 'Fixture proxy requests failed');
    },
    async close() {
      await proxy.stop(true);
    },
  };
}
