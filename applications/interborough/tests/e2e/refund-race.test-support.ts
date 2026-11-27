import { createFakeProcessor, createRefundLedger } from '@lostgradient/plugin-demo/refunds';
import { BunSQLiteStorage } from '@lostgradient/storage-bun-sqlite';
import { spawnWithHangGuard } from '@lostgradient/testing/hang-guard';
import { createPostgresTestServer } from '@lostgradient/testing/postgres-server';
import { createS3TestServer } from '@lostgradient/testing/s3-server';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { join } from 'node:path';
import { startHost } from '../../src/host/host.ts';
import { createHostStorage, disposeHostStorage } from '../../src/host/locations.ts';
import {
  createFreshDatabaseUrl,
  remoteEnvironment,
} from '../../src/host/remote-backends.test-support.ts';
import { createSyntheticIssuer } from '../../src/host/server-integration/synthetic-issuer.test-support.ts';
import { startRefundProxy } from './refund-https-proxy.test-support.ts';

type Host = { pid: number; url: string; control: string };
export async function startRefundRace(
  buildDirectory: string,
  options: {
    regate?: boolean;
    distinctOwners?: boolean;
    onHang?: (release: () => Promise<void>) => void;
  } = {},
) {
  const directory = createTemporaryDirectory('refund-browser-race');
  const pendingCleanup: Array<() => void | Promise<void>> = [() => removeTemporaryPath(directory)];
  let setupStage = 'opening PostgreSQL';
  let stoppingSetup = false;
  let pendingCleanupPromise: Promise<void> | undefined;
  const cleanupPending = () => {
    stoppingSetup = true;
    return (pendingCleanupPromise ??= (async () => {
      const failures: unknown[] = [];
      while (pendingCleanup.length) {
        try {
          await pendingCleanup.pop()!();
        } catch (error) {
          failures.push(error);
        }
      }
      if (failures.length)
        throw new AggregateError(failures, 'Refund fixture setup cleanup failed');
    })());
  };
  options.onHang?.(async () => {
    console.error(`Refund fixture setup stopped during ${setupStage}`);
    await cleanupPending();
  });
  const acquire = async <T>(
    open: () => T | Promise<T>,
    release: (value: T) => void | Promise<void>,
  ) => {
    try {
      const value = await open();
      if (stoppingSetup) {
        await release(value);
        throw new Error('Refund fixture setup was stopped');
      }
      pendingCleanup.push(() => release(value));
      return value;
    } catch (error) {
      try {
        await cleanupPending();
      } catch (cleanup) {
        throw new AggregateError([error, cleanup], 'Refund fixture setup and cleanup failed', {
          cause: cleanup,
        });
      }
      throw error;
    }
  };
  const database = await acquire(
    () => createPostgresTestServer(),
    (value) => value[Symbol.asyncDispose](),
  );
  setupStage = 'opening S3';
  const bucket = await acquire(
    () => createS3TestServer(),
    (value) => value.stop(),
  );
  setupStage = 'opening identity provider';
  const issuer = await acquire(
    () => createSyntheticIssuer(),
    (value) => value.provider.stop(true),
  );
  const children: ReturnType<typeof spawnWithHangGuard<'pipe', 'pipe', 'pipe'>>[] = [];
  const intentionallyCrashed = new Set<number>();
  const errors: Promise<string>[] = [];
  setupStage = 'opening ledger';
  const ledgerStorage = await acquire(
    () => new BunSQLiteStorage(join(directory, 'ledger.sqlite')),
    (value) => value[Symbol.dispose](),
  );
  setupStage = 'opening provider store';
  const providerStorage = await acquire(
    () => new BunSQLiteStorage(join(directory, 'provider.sqlite')),
    (value) => value[Symbol.dispose](),
  );
  setupStage = 'opening HTTPS proxy';
  const proxy = await acquire(
    () => startRefundProxy(directory),
    (value) => value.close(),
  );
  const ledger = createRefundLedger(ledgerStorage);
  const provider = createFakeProcessor(providerStorage);
  pendingCleanup.push(async () => {
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
  });
  const closeResources = async () => {
    const failures: string[] = [];
    try {
      await proxy.drain();
    } catch (error) {
      const details = error instanceof AggregateError ? error.errors.map(String).join('; ') : '';
      failures.push(`Proxy drain failed: ${String(error)} ${details}`);
    }
    try {
      await proxy.close();
    } catch (error) {
      failures.push(`Proxy close failed: ${String(error)}`);
    }
    for (const child of children) child.stdin.end();
    for (const [index, child] of children.entries()) {
      const exit = await child.exited;
      const stderr = await errors[index];
      if (exit !== 0 && !intentionallyCrashed.has(child.pid))
        failures.push(`Refund host exited ${String(exit)}: ${stderr}`);
    }
    ledgerStorage[Symbol.dispose]();
    providerStorage[Symbol.dispose]();
    issuer.provider.stop(true);
    await bucket.stop();
    await database[Symbol.asyncDispose]();
    removeTemporaryPath(directory);
    if (failures.length) throw new Error(failures.join('\n'));
  };
  let closePromise: Promise<void> | undefined;
  const close = () => (closePromise ??= closeResources());
  const abort = async () => {
    stoppingSetup = true;
    for (const child of children) if (child.exitCode === null) child.kill();
    await Promise.all(children.map((child) => child.exited));
    await close();
  };
  try {
    setupStage = 'creating database';
    const environment = remoteEnvironment(
      await createFreshDatabaseUrl(database),
      bucket,
      `refund-${crypto.randomUUID()}/`,
    );
    setupStage = 'opening bootstrap host';
    const bootstrap = await acquire(
      async () => {
        const host = await startHost({
          environment,
          port: 0,
          log: (message) => console.error(message),
        });
        let closing: Promise<void> | undefined;
        return { host, close: () => (closing ??= host.close()) };
      },
      (value) => value.close(),
    );
    const workspaceId = bootstrap.host.workspaceId;
    setupStage = 'closing bootstrap host';
    await bootstrap.close();
    if (stoppingSetup) throw new Error('Refund fixture setup was stopped');
    pendingCleanup.pop();
    setupStage = 'seeding charge';
    await ledger.addCharge({
      merchant: 'merchant',
      order: 'order',
      amount: 10000,
      currency: 'USD',
      paymentReference: 'charge',
      providerAccount: 'account',
    });
    const configuration = {
      environment,
      workspaceId,
      issuer: issuer.issuer,
      ledgerPath: join(directory, 'ledger.sqlite'),
      providerPath: join(directory, 'provider.sqlite'),
      buildDirectory,
      origin: proxy.origin,
      distinctOwners: options.distinctOwners,
    };
    const childPath = new URL('./refund-race-host.test-support.ts', import.meta.url).pathname;
    const startPeer = async (regate = false, revokedActors: string[] = []): Promise<Host> => {
      if (stoppingSetup) throw new Error('Refund fixture setup was stopped');
      const child = spawnWithHangGuard([process.execPath, childPath], {
        env: {
          ...process.env,
          REFUND_RACE_CONFIG: JSON.stringify({ ...configuration, regate, revokedActors }),
        },
        stdin: 'pipe',
        stdout: 'pipe',
        stderr: 'pipe',
      });
      children.push(child);
      const stderr = new Response(child.stderr).text();
      errors.push(stderr);
      const message = await child.stdout.getReader().read();
      if (!message.value) throw new Error(await stderr);
      if (stoppingSetup) throw new Error('Refund fixture setup was stopped');
      return JSON.parse(new TextDecoder().decode(message.value)) as Host;
    };
    setupStage = 'opening peer hosts';
    const hosts = await Promise.all([startPeer(options.regate), startPeer()] as const);
    if (stoppingSetup) throw new Error('Refund fixture setup was stopped');
    if (new Set(hosts.map((host) => host.pid)).size !== 2) throw new Error('Hosts share a process');
    proxy.setTargets(hosts.map((host) => host.url));
    const crashHost = async (index: 0 | 1) => {
      const child = children.find((candidate) => candidate.pid === hosts[index].pid);
      if (!child || child.exitCode !== null) throw new Error('Refund host is not running');
      intentionallyCrashed.add(child.pid);
      child.kill('SIGKILL');
      const exit = await child.exited;
      if (exit === 0) throw new Error('Refund host did not crash');
      return exit;
    };
    const restartHost = async (index: 0 | 1, revokedActors: string[] = []) => {
      hosts[index] = await startPeer(index === 0 && options.regate, revokedActors);
      proxy.setTargets(hosts.map((host) => host.url));
      return hosts[index];
    };
    const send = (host: Host, path: string, init: RequestInit = {}) =>
      fetch(new URL(path, host.url), {
        ...init,
        redirect: 'manual',
        headers: {
          ...Object.fromEntries(new Headers(init.headers)),
          host: new URL(proxy.origin).host,
        },
      });
    const signIn = async (host: Host, actor: string) => {
      issuer.setSubject(actor);
      const started = await send(host, '/auth/sign-in');
      const temporaryCookie = started.headers.getSetCookie()[0]!.split(';')[0]!;
      const authorized = await fetch(started.headers.get('location')!, { redirect: 'manual' });
      const callback = new URL(authorized.headers.get('location')!);
      const result = await send(host, callback.pathname + callback.search, {
        headers: { cookie: temporaryCookie },
      });
      if (result.status !== 303) throw new Error('Synthetic reviewer sign-in failed');
      return result.headers.getSetCookie()[0]!.split(';')[0]!;
    };
    const requestRefund = async () => {
      const commandId = crypto.randomUUID();
      const response = await fetch(new URL('/bureau/jsonrpc', hosts[0].url), {
        method: 'POST',
        headers: { 'x-api-key': 'machine', 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'demo.refunds.request',
          params: { commandId, orderId: 'order', cents: 4200 },
        }),
      });
      const answer = (await response.json()) as { result?: { refundId: string } };
      if (!answer.result) throw new Error('Refund request failed');
      const refundId = answer.result.refundId;
      await waitUntil(
        async () => {
          const value = await ledger.get(refundId);
          return Boolean(value?.reviewId);
        },
        {
          message: 'refund review admission',
        },
      );
      const refund = await ledger.get(refundId);
      if (!refund?.reviewId) throw new Error('Refund review disappeared');
      return { refundId, reviewId: refund.reviewId, commandId };
    };
    const approvalMetadata = async (runId: string) => {
      const storage = createHostStorage({
        kind: 'postgres',
        url: environment['INTERBOROUGH_DATABASE_URL']!,
      });
      try {
        for await (const [, value] of storage.scan('agent-session-v2:body:')) {
          const session = JSON.parse(new TextDecoder().decode(value)) as {
            metadata?: {
              lastRunId?: string;
              lastRunStatus?: string;
              pendingApprovalOverrides?: Record<string, unknown>;
              lastRequestAuthorities?: Record<string, unknown>;
              approvalResolutionStartedIds?: unknown;
              resolvedReviewIds?: unknown;
            };
          };
          if (session.metadata?.lastRunId === runId)
            return {
              status: session.metadata.lastRunStatus,
              reviewIds: Object.keys(session.metadata.pendingApprovalOverrides ?? {}),
              authority: session.metadata.lastRequestAuthorities?.[runId],
              started: session.metadata.approvalResolutionStartedIds,
              resolved: session.metadata.resolvedReviewIds,
            };
        }
        return undefined;
      } finally {
        await disposeHostStorage(storage);
      }
    };
    const durableEvidence = async (reviewId: string) => {
      const storage = createHostStorage({
        kind: 'postgres',
        url: environment['INTERBOROUGH_DATABASE_URL']!,
      });
      try {
        const claims: string[] = [];
        const tasks: string[] = [];
        const pendingOutbox: {
          key: string;
          kind: string | undefined;
          namespace: string | undefined;
          claim: unknown;
        }[] = [];
        const decisions: {
          decision?: string;
          decidedBy?: string;
          decisionSurface?: string;
          review?: { id?: string };
        }[] = [];
        for await (const [key] of storage.scan('review-decision:v1:')) claims.push(key);
        for await (const [key] of storage.scan('bureau-task:v1:')) tasks.push(key);
        for await (const [key, value] of storage.scan('agent-session-outbox:v1:entry:')) {
          const raw = new TextDecoder().decode(value);
          if (!raw.includes(reviewId)) continue;
          const entry = JSON.parse(raw) as { kind?: string; namespace?: string; claim?: unknown };
          pendingOutbox.push({
            key,
            kind: entry.kind,
            namespace: entry.namespace,
            claim: entry.claim,
          });
        }
        for await (const [, value] of storage.scan('bureau-resolved-review:v1:')) {
          const entry = JSON.parse(new TextDecoder().decode(value)) as (typeof decisions)[number];
          if (entry.review?.id === reviewId) decisions.push(entry);
        }
        const starts: string[] = [];
        for await (const [key] of ledgerStorage.scan('start:')) starts.push(key);
        return { claims, tasks, starts, decisions, pendingOutbox };
      } finally {
        await disposeHostStorage(storage);
      }
    };
    setupStage = 'ready';
    pendingCleanup.length = 0;
    return {
      hosts,
      startPeer,
      send,
      signIn,
      crashHost,
      restartHost,
      requestRefund,
      ledger,
      provider,
      proxy,
      origin: proxy.origin,
      approvalMetadata,
      durableEvidence,
      abort,
      close,
    };
  } catch (error) {
    try {
      await cleanupPending();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Refund fixture setup and cleanup failed', {
        cause: cleanup,
      });
    }
    throw error;
  }
}
