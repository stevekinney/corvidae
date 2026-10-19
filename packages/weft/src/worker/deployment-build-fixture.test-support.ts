/**
 * Shared fixtures for the tests that drive real engine runs against a deployment catalog
 * (COR-1582): an engine whose `checkout` runs wait for a `go` signal, a catalog with two ready
 * builds, and a storage that lets a test run its own work just before one of a batch commit.
 */
import { decode } from '../core/codec/index.ts';
import { Engine } from '../core/engine.ts';
import { workflow } from '../core/types.ts';
import type { OperationFault } from '../server/operation-fault.ts';
import { MemoryStorage } from '../storage/memory.ts';
import { WorkerDeploymentCatalog } from './deployment-routing.ts';
import type { WorkerManifest } from './manifest/types.ts';

export const DEPLOYMENT = 'test-deployment';

export function buildManifest(
  revision: string,
  buildId: string,
  workflowType = 'checkout',
): WorkerManifest {
  return {
    manifestVersion: 1,
    protocolVersion: 1,
    sdkVersion: 'test',
    runtime: { name: 'bun', version: 'test' },
    deployment: { name: DEPLOYMENT, buildId, artifactDigest: `sha256:${buildId}` },
    workflows: {
      [workflowType]: {
        workflowVersion: '0.0.0',
        workflowRevision: revision,
        contractHash: 'sha256:workflow',
        activities: { charge: { contractHash: 'sha256:charge', implementationRevision: buildId } },
      },
    },
    capabilities: {},
  };
}

export type Invocable = { invoke: (context: never) => Promise<unknown> };

export function invoke(operation: Invocable, input: unknown, host?: unknown): Promise<unknown> {
  return operation.invoke({ input, host } as never);
}

export async function faultOf(promise: Promise<unknown>): Promise<OperationFault> {
  try {
    await promise;
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'code' in error && 'data' in error) {
      return error as OperationFault;
    }
    throw new Error(`Expected an OperationFault, received ${String(error)}`, { cause: error });
  }
  throw new Error('Expected the operation to fault, but it succeeded.');
}

/** An engine whose `checkout` runs wait for a `go` signal, over a catalog with two ready builds. */
export async function fixture(storage: MemoryStorage = new MemoryStorage(), seedCatalog = true) {
  const engine = new Engine({ storage });
  engine.register(
    workflow({ name: 'checkout', workerVersioningPolicy: { mode: 'pinned' } }).execute(
      async function* (ctx) {
        return yield* ctx.waitForSignal<string>('go');
      },
    ),
  );
  const [firstRevision] = await engine.workflows.listRevisions('checkout');
  const revision = firstRevision?.manifest.revision ?? '';
  const catalog = new WorkerDeploymentCatalog(storage);
  const disposable = {
    storage,
    engine,
    catalog,
    revision,
    async [Symbol.asyncDispose]() {
      engine[Symbol.dispose]();
    },
  };
  if (!seedCatalog) return disposable;
  for (const buildId of ['build-1', 'build-2']) {
    await catalog.registerVersion({
      deploymentName: DEPLOYMENT,
      buildId,
      artifactDigest: `sha256:${buildId}`,
      manifestDigest: `sha256:manifest-${buildId}`,
      manifest: buildManifest(revision, buildId),
      state: 'ready',
      firstSeenAt: 1,
    });
  }
  await catalog.setRouting({
    deploymentName: DEPLOYMENT,
    currentBuildId: 'build-1',
    rampBasisPoints: 10_000,
    updatedAt: 1,
  });
  return disposable;
}

/** Route new work off `build-1` and drain it, so only the work already on it keeps it alive. */
export async function drainBuildOne(catalog: WorkerDeploymentCatalog): Promise<void> {
  await catalog.setRouting({
    deploymentName: DEPLOYMENT,
    currentBuildId: 'build-2',
    rampBasisPoints: 10_000,
    updatedAt: 2,
    expectedGeneration: 1,
  });
  await catalog.setVersionState(DEPLOYMENT, 'build-1', 'draining');
}

export const REMOVE_BUILD_ONE = { deploymentName: DEPLOYMENT, buildId: 'build-1' };

type BatchOperations = Parameters<MemoryStorage['conditionalBatch']>[1];

/** Whether a batch writes the version record of some build in the given state (`removed`, say). */
export function writesVersionState(operations: BatchOperations, state: string): boolean {
  return operations.some(
    (operation) =>
      operation.type === 'put' &&
      operation.key.startsWith('worker-deployment-version:') &&
      (decode(operation.value) as { state?: string }).state === state,
  );
}

/** Whether a batch puts a key that starts with `prefix`. */
export function putsKeyWithPrefix(operations: BatchOperations, prefix: string): boolean {
  return operations.some(
    (operation) => operation.type === 'put' && operation.key.startsWith(prefix),
  );
}

/**
 * A storage that runs a test's own work just before a chosen `conditionalBatch` commits: the next
 * one, or the first whose operations satisfy `when`. The work runs once, and `fired` says whether
 * it did, so a test can tell a batch that never came from one that came and passed.
 */
export class InterleavingStorage extends MemoryStorage {
  #beforeCommit: (() => Promise<void>) | undefined;
  #when: ((operations: BatchOperations) => boolean) | undefined;
  fired: boolean;
  /** The key of every put a committed batch carried, in order. */
  readonly committedPuts: string[];
  // Assigned here, not by field initializers: Bun reports a class's synthetic initializer
  // function as never called, which fails the coverage gate's function count.
  constructor() {
    super();
    this.fired = false;
    this.committedPuts = [];
  }
  arm(beforeCommit: () => Promise<void>, when?: (operations: BatchOperations) => boolean): void {
    this.#beforeCommit = beforeCommit;
    this.#when = when;
    this.fired = false;
  }
  override async conditionalBatch(...args: Parameters<MemoryStorage['conditionalBatch']>) {
    const beforeCommit = this.#beforeCommit;
    if (beforeCommit !== undefined && (this.#when?.(args[1]) ?? true)) {
      this.#beforeCommit = undefined;
      this.fired = true;
      await beforeCommit();
    }
    const committed = await super.conditionalBatch(...args);
    if (committed) {
      for (const operation of args[1]) {
        if (operation.type === 'put') this.committedPuts.push(operation.key);
      }
    }
    return committed;
  }
}
