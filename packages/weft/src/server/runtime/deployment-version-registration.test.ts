/**
 * Worker registration records the worker's deployment version in the durable
 * catalog (COR-277), on both transports. Without it nothing populated
 * `WorkerDeploymentCatalog`, so `weft.worker.deployments.*` listed no versions.
 */
import { describe, expect, it, spyOn } from 'bun:test';

import { MemoryStorage } from '../../storage/memory.ts';
import { waitForCondition } from '../../testing/fake-timers.test-support.ts';
import { WorkerDeploymentCatalog } from '../../worker/deployment-routing.ts';
import type { WorkerManifest } from '../../worker/manifest/types.ts';
import { REMOTE_WORKER_PROTOCOL_VERSION } from '../../worker/protocol.ts';
import { manifestForActivities } from '../../worker/registry-fixtures.test-support.ts';
import type { WebSocketData } from '../json-rpc-websocket-runtime.ts';
import { minimalServeOptions, minimalServerContext } from './server-context.test-support.ts';
import { handleWorkerWebSocketMessage } from './websocket-worker.ts';
import { handleWorkerSessionRequest } from './worker-sessions.ts';

class FlakyStorage extends MemoryStorage {
  failing = false;
  override async get(key: string) {
    if (this.failing) throw new Error('storage offline');
    return super.get(key);
  }
}

function manifest(artifactDigest = 'sha256:artifact-a', buildId = 'build-1'): WorkerManifest {
  return manifestForActivities(['checkout.charge'], {
    deployment: { name: 'billing', buildId, artifactDigest },
  });
}

function setup() {
  const storage = new FlakyStorage();
  const catalog = new WorkerDeploymentCatalog(storage);
  const context = { ...minimalServerContext(), workerDeploymentCatalog: catalog };
  return { storage, catalog, context, options: minimalServeOptions() };
}

type Context = ReturnType<typeof setup>['context'];

interface FakeSocket {
  data: WebSocketData;
  sentMessages: string[];
  readyState: number;
  closeCode?: number;
  send(message: string): void;
  close(code?: number, reason?: string): void;
  unsubscribe(topic: string): void;
  terminate(): void;
}

function socket(): FakeSocket {
  return {
    data: { pathname: '/v1/tasks/default/stream', connectionType: 'worker', queue: 'default' },
    sentMessages: [],
    readyState: WebSocket.OPEN,
    send(message) {
      this.sentMessages.push(message);
    },
    close(code) {
      if (code !== undefined) this.closeCode = code;
    },
    unsubscribe() {},
    terminate() {},
  };
}

/** Registers a WebSocket worker and waits for it to be answered (ack, error, or close). */
async function registerSocket(
  context: Context,
  options: ReturnType<typeof setup>['options'],
  workerId: string,
  workerManifest: WorkerManifest,
): Promise<FakeSocket> {
  const ws = socket();
  handleWorkerWebSocketMessage(
    context,
    options,
    ws as never,
    JSON.stringify({
      type: 'register',
      protocolVersion: REMOTE_WORKER_PROTOCOL_VERSION,
      workerId,
      manifest: workerManifest,
      concurrency: 2,
    }),
    () => {},
  );
  await waitForCondition(() => ws.sentMessages.length > 0 || ws.closeCode !== undefined, {
    timeoutMs: 1_000,
    label: 'registration answer',
  });
  return ws;
}

async function registerSession(
  context: Context,
  options: ReturnType<typeof setup>['options'],
  workerManifest: WorkerManifest,
): Promise<Response> {
  const request = new Request('http://127.0.0.1/v1/worker-sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ manifest: workerManifest }),
  });
  const response = await handleWorkerSessionRequest(
    context,
    options,
    request,
    new URL(request.url),
  );
  if (response === null) throw new Error('expected a registration response');
  return response;
}

function answer(ws: FakeSocket): { type: string; code?: string; acceptedManifestDigest?: string } {
  return JSON.parse(ws.sentMessages[0] ?? '{}');
}

async function versionOf(catalog: WorkerDeploymentCatalog, buildId = 'build-1') {
  return catalog.getVersion('billing', buildId);
}

async function stateOf(catalog: WorkerDeploymentCatalog) {
  const version = await versionOf(catalog);
  return version?.state;
}

async function artifactOf(catalog: WorkerDeploymentCatalog) {
  const version = await versionOf(catalog);
  return version?.artifactDigest;
}

describe.each([
  ['WebSocket', 'websocket'],
  ['HTTP long-poll', 'long-poll'],
] as const)('registration records the version — %s', (_label, transport) => {
  /** Registers one worker on this transport; resolves to whether it was accepted. */
  async function register(
    env: ReturnType<typeof setup>,
    workerManifest: WorkerManifest,
    workerId = `worker-${Math.random()}`,
  ): Promise<{ accepted: boolean; digest?: string; detail: string }> {
    if (transport === 'websocket') {
      const ws = await registerSocket(env.context, env.options, workerId, workerManifest);
      const message = answer(ws);
      return {
        accepted: message.type === 'registerAck',
        ...(message.acceptedManifestDigest === undefined
          ? {}
          : { digest: message.acceptedManifestDigest }),
        detail: message.code ?? String(ws.closeCode ?? ''),
      };
    }
    const response = await registerSession(env.context, env.options, workerManifest);
    const body = (await response.json()) as { acceptedManifestDigest?: string; code?: string };
    return {
      accepted: response.status === 200,
      ...(body.acceptedManifestDigest === undefined ? {} : { digest: body.acceptedManifestDigest }),
      detail: body.code ?? String(response.status),
    };
  }

  it('records an accepted worker’s build as a ready version with the digests it registered', async () => {
    const env = setup();
    const result = await register(env, manifest());
    expect(result.accepted).toBe(true);

    const stored = await versionOf(env.catalog);
    expect(stored).toMatchObject({
      deploymentName: 'billing',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact-a',
      manifestDigest: result.digest,
      state: 'ready',
      executionReferences: 0,
    });
    expect(stored?.firstSeenAt).toBeGreaterThan(0);
    expect(stored?.manifest.deployment).toEqual(manifest().deployment);
  });

  it('is idempotent: another worker, or a reconnect, of the same build leaves the version untouched', async () => {
    const env = setup();
    await register(env, manifest(), 'worker-1');
    const first = await versionOf(env.catalog);

    await register(env, manifest(), 'worker-2');
    await register(env, manifest(), 'worker-1');

    expect(await versionOf(env.catalog)).toEqual(first);
    expect(await env.catalog.listVersions()).toHaveLength(1);
  });

  it.each(['draining', 'removed'] as const)(
    'never moves a %s version back to ready',
    async (state) => {
      const env = setup();
      await register(env, manifest(), 'worker-1');
      if (state === 'draining') await env.catalog.markDraining('billing', 'build-1');
      else await env.catalog.removeVersion('billing', 'build-1');

      const result = await register(env, manifest(), 'worker-2');

      expect(result.accepted).toBe(true);
      expect(await stateOf(env.catalog)).toBe(state);
    },
  );

  it('two workers of one new build registering at once produce one version', async () => {
    const env = setup();
    const results = await Promise.all([
      register(env, manifest(), 'worker-a'),
      register(env, manifest(), 'worker-b'),
      register(env, manifest(), 'worker-c'),
    ]);
    expect(results.every((result) => result.accepted)).toBe(true);
    const versions = await env.catalog.listVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]?.state).toBe('ready');
  });

  it('refuses a conflicting artifact digest from a connected worker first, and writes nothing', async () => {
    const env = setup();
    await register(env, manifest('sha256:artifact-a'), 'worker-1');
    const before = await env.storage.get('worker-deployment-version:billing:build-1');

    const conflicting = await register(env, manifest('sha256:artifact-b'), 'worker-2');

    expect(conflicting.accepted).toBe(false);
    expect(conflicting.detail).toBe('deployment_conflict');
    expect(await env.storage.get('worker-deployment-version:billing:build-1')).toEqual(before);
    expect(await artifactOf(env.catalog)).toBe('sha256:artifact-a');
  });

  it('refuses a build whose digests differ from the stored version, with nothing connected, as a conflict', async () => {
    const env = setup();
    // A previous run of the server recorded this build; this process has no connected worker for it.
    await env.catalog.registerVersion({
      deploymentName: 'billing',
      buildId: 'build-1',
      artifactDigest: 'sha256:artifact-old',
      manifestDigest: 'sha256:manifest-old',
      manifest: manifest('sha256:artifact-old'),
      state: 'ready',
      firstSeenAt: 1,
    });

    const result = await register(env, manifest('sha256:artifact-new'), 'worker-1');

    expect(result.accepted).toBe(false);
    expect(result.detail).toBe('deployment_conflict');
    expect(env.context.registry.size).toBe(0);
    expect(await artifactOf(env.catalog)).toBe('sha256:artifact-old');
  });

  it('refuses a registration the catalog cannot record, retryably, accepting no worker', async () => {
    const env = setup();
    env.storage.failing = true;
    using warning = spyOn(console, 'warn').mockImplementation(() => {});

    const result = await register(env, manifest(), 'worker-1');

    expect(result.accepted).toBe(false);
    // WebSocket: closed with 1013 (Try Again Later). Long-poll: 503 `catalog_unavailable` with Retry-After.
    expect(result.detail).toBe(transport === 'websocket' ? '1013' : 'catalog_unavailable');
    expect(env.context.registry.size).toBe(0);
    expect(warning).toHaveBeenCalled();

    // The catalog recovers and the same worker's retry is accepted.
    env.storage.failing = false;
    const retried = await register(env, manifest(), 'worker-1');
    expect(retried.accepted).toBe(true);
    expect(await versionOf(env.catalog)).not.toBeNull();
  });

  it('registers without a catalog on a hand-built context', async () => {
    const env = setup();
    const bare = { ...env, context: minimalServerContext() };
    const result = await register(bare as never, manifest(), 'worker-1');
    expect(result.accepted).toBe(true);
  });
});

describe('long-poll catalog failure carries Retry-After', () => {
  it('answers 503 with a retry hint', async () => {
    const env = setup();
    env.storage.failing = true;
    using warning = spyOn(console, 'warn').mockImplementation(() => {});
    const response = await registerSession(env.context, env.options, manifest());
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('1');
    expect(warning).toHaveBeenCalled();
  });
});
