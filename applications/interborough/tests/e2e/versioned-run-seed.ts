/**
 * Seeds COR-164's worker-versioning evidence through real Weft paths. Nothing here writes a
 * binding, a catalog record, or a policy directly.
 *
 * Two real `RemoteWorker`s register two builds of one deployment, each with a manifest built from
 * the engine registry, so the server's own registration records both versions in its catalog.
 * Routing is then set on the first build through the `weft.worker.deployments.setrouting`
 * operation, and two workflow types are started and run to completion:
 *
 * - a pinned one, which binds to the routed build and stays on it;
 * - an auto-upgrade one, whose policy names the first build's exact digests. Those digests include
 *   the server-computed manifest digest, which only exists once the workers have registered, so
 *   the auto-upgrade workflow is registered on the engine after that, using the same contract the
 *   manifest was built from (a worker policy is not part of a workflow's contract, so the revision
 *   the manifest advertises is the revision the engine registers).
 *
 * A third, held run of a pinned workflow that waits for a signal nothing sends binds to the first
 * build and stays running, so that build has one piece of durable work bound to it (COR-1582).
 *
 * Routing is moved to the second build afterwards, which bumps its generation to 2. The pinned run
 * stays on the first build at generation 1. The auto-upgrade run's preview resolves against the
 * policy's pinned first build at generation 2, so spending the preview is what moves its
 * replacement from generation 1 to 2.
 */
import {
  buildWorkerManifestFromRegistry,
  Engine,
  HttpClient,
  RemoteWorker,
  workflow,
  type WorkerManifest,
} from '@lostgradient/weft';

import {
  E2E_AUTO_UPGRADE_RUN_ID,
  E2E_AUTO_UPGRADE_WORKFLOW_TYPE,
  E2E_HELD_RUN_ID,
  E2E_HELD_WORKFLOW_TYPE,
  E2E_PINNED_RUN_ID,
  E2E_PINNED_WORKFLOW_TYPE,
  E2E_PORT,
  E2E_VERSIONED_DEPLOYMENT_NAME,
  E2E_VERSIONED_FIRST_BUILD_ID,
  E2E_VERSIONED_SECOND_BUILD_ID,
} from './e2e-constants.ts';

type AutoUpgradeCompatibility = Extract<
  NonNullable<Parameters<typeof workflow>[0]['workerVersioningPolicy']>,
  { mode: 'auto-upgrade' }
>['compatibility'];

interface RegistrableEngine {
  register(
    definition: ReturnType<typeof versionedWorkflow> | ReturnType<typeof heldWorkflow>,
  ): unknown;
  start(
    type: string,
    input: unknown,
    options: { id: string },
  ): Promise<{ result(): Promise<unknown> }>;
}

function versionedWorkflow(
  name: string,
  policy: NonNullable<Parameters<typeof workflow>[0]['workerVersioningPolicy']>,
) {
  return workflow({ name, workerVersioningPolicy: policy }).execute(async function* () {
    return 'ok';
  });
}

/** A pinned workflow that never finishes: it waits for a signal nothing sends. */
function heldWorkflow() {
  return workflow({
    name: E2E_HELD_WORKFLOW_TYPE,
    workerVersioningPolicy: { mode: 'pinned' },
  }).execute(async function* (ctx) {
    return yield* ctx.waitForSignal<string>('release');
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function acceptedManifestDigest(diagnostics: unknown, buildId: string): string {
  const versions = isRecord(diagnostics) ? diagnostics['versions'] : undefined;
  if (!Array.isArray(versions)) throw new Error('Deployment diagnostics returned no versions.');
  for (const version of versions) {
    if (
      isRecord(version) &&
      version['deploymentName'] === E2E_VERSIONED_DEPLOYMENT_NAME &&
      version['buildId'] === buildId &&
      typeof version['manifestDigest'] === 'string'
    ) {
      return version['manifestDigest'];
    }
  }
  throw new Error(`The server recorded no version for build ${buildId}.`);
}

async function buildManifest(draft: Engine, buildId: string): Promise<WorkerManifest> {
  return buildWorkerManifestFromRegistry(draft, {
    workflows: {
      [E2E_PINNED_WORKFLOW_TYPE]: [],
      [E2E_AUTO_UPGRADE_WORKFLOW_TYPE]: [],
      [E2E_HELD_WORKFLOW_TYPE]: [],
    },
    deployment: {
      name: E2E_VERSIONED_DEPLOYMENT_NAME,
      buildId,
      artifactDigest: `sha256:${buildId}`,
    },
    runtime: { name: 'bun', version: Bun.version },
  });
}

function workerFor(buildId: string, manifest: WorkerManifest): RemoteWorker {
  return new RemoteWorker({
    serverUrl: `ws://127.0.0.1:${E2E_PORT}/v1/tasks/default/stream`,
    workerId: `${buildId}-worker`,
    deploymentName: E2E_VERSIONED_DEPLOYMENT_NAME,
    buildId,
    workflows: {
      [E2E_PINNED_WORKFLOW_TYPE]: { name: E2E_PINNED_WORKFLOW_TYPE, activities: {} },
      [E2E_AUTO_UPGRADE_WORKFLOW_TYPE]: { name: E2E_AUTO_UPGRADE_WORKFLOW_TYPE, activities: {} },
      [E2E_HELD_WORKFLOW_TYPE]: { name: E2E_HELD_WORKFLOW_TYPE, activities: {} },
    },
    manifest,
  });
}

export async function seedVersionedRuns(
  engine: RegistrableEngine,
  baseUrl: string,
): Promise<RemoteWorker[]> {
  const client = new HttpClient({ baseUrl });
  using draft = new Engine();
  draft.register(versionedWorkflow(E2E_PINNED_WORKFLOW_TYPE, { mode: 'pinned' }));
  draft.register(versionedWorkflow(E2E_AUTO_UPGRADE_WORKFLOW_TYPE, { mode: 'pinned' }));
  draft.register(heldWorkflow());

  const first = await buildManifest(draft, E2E_VERSIONED_FIRST_BUILD_ID);
  const second = await buildManifest(draft, E2E_VERSIONED_SECOND_BUILD_ID);
  const workers = [
    workerFor(E2E_VERSIONED_FIRST_BUILD_ID, first),
    workerFor(E2E_VERSIONED_SECOND_BUILD_ID, second),
  ];
  for (const worker of workers) await worker.connect();

  const diagnostics = await client.operations['weft.worker.deployments.diagnostics']({
    deploymentName: E2E_VERSIONED_DEPLOYMENT_NAME,
  });
  const autoContract = first.workflows[E2E_AUTO_UPGRADE_WORKFLOW_TYPE];
  if (autoContract === undefined) throw new Error('The manifest has no auto-upgrade workflow.');
  const compatibility: AutoUpgradeCompatibility = {
    deploymentName: E2E_VERSIONED_DEPLOYMENT_NAME,
    buildId: E2E_VERSIONED_FIRST_BUILD_ID,
    artifactDigest: first.deployment.artifactDigest,
    manifestDigest: acceptedManifestDigest(diagnostics, E2E_VERSIONED_FIRST_BUILD_ID),
    workflowRevision: autoContract.workflowRevision,
    activityContractHash: autoContract.contractHash,
  };

  engine.register(versionedWorkflow(E2E_PINNED_WORKFLOW_TYPE, { mode: 'pinned' }));
  engine.register(
    versionedWorkflow(E2E_AUTO_UPGRADE_WORKFLOW_TYPE, { mode: 'auto-upgrade', compatibility }),
  );

  engine.register(heldWorkflow());

  await client.operations['weft.worker.deployments.setrouting']({
    deploymentName: E2E_VERSIONED_DEPLOYMENT_NAME,
    currentBuildId: E2E_VERSIONED_FIRST_BUILD_ID,
    rampBasisPoints: 0,
    expectedGeneration: 0,
  });
  for (const [type, id] of [
    [E2E_PINNED_WORKFLOW_TYPE, E2E_PINNED_RUN_ID],
    [E2E_AUTO_UPGRADE_WORKFLOW_TYPE, E2E_AUTO_UPGRADE_RUN_ID],
  ] as const) {
    const handle = await engine.start(type, {}, { id });
    await handle.result();
  }
  // Not awaited: the held run stays running, bound to the first build.
  await engine.start(E2E_HELD_WORKFLOW_TYPE, {}, { id: E2E_HELD_RUN_ID });
  await client.operations['weft.worker.deployments.setrouting']({
    deploymentName: E2E_VERSIONED_DEPLOYMENT_NAME,
    currentBuildId: E2E_VERSIONED_SECOND_BUILD_ID,
    rampBasisPoints: 0,
    expectedGeneration: 1,
  });
  return workers;
}
