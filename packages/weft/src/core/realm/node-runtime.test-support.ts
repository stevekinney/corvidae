import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { MemoryStorage } from '@lostgradient/storage';
import { nodeWorkerFactory } from '../../node-host.ts';
import { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import { WorkerPool } from '../../workers/pool.ts';
import { ActivityRegistry } from '../activity-registry.ts';
import { copyWorkflowDefinition } from '../engine/construction.ts';
import { Engine } from '../engine/index.ts';
import { buildRegistrationEntry } from '../engine/registration.ts';
import { buildWorkflowManifestFromDefinition } from '../registry-workflow-manifest.ts';
import { workflowSource } from '../source/index.ts';
import { workflow, type WorkflowDefinition } from '../types.ts';
import { ChildProcessRealm } from './child-process-realm.ts';

const fixtureUrl = (name: string) =>
  pathToFileURL(
    join(
      process.cwd(),
      basename(process.cwd()) === 'weft'
        ? 'src/core/realm/__fixtures__'
        : 'packages/weft/src/core/realm/__fixtures__',
      name,
    ),
  );

const activityWorkerUrl = fixtureUrl('node-runtime-activity-worker.mjs');
const SENTINEL_WORKFLOW_NAME = 'r2e-sentinel-workflow';

function placeholderDefinition(): WorkflowDefinition {
  return workflow({ name: SENTINEL_WORKFLOW_NAME }).execute(async function* () {
    throw new Error('realm fixture must execute this workflow');
  });
}

async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  const entry = buildRegistrationEntry(definition.name, definition);
  const registered = copyWorkflowDefinition(definition.name, entry);
  return (
    await buildWorkflowManifestFromDefinition(registered, new ActivityRegistry().listDefinitions())
  ).revision;
}

async function runRealm(transport: 'worker' | 'child-process', workerUrl: string): Promise<void> {
  const revision = await revisionFor(placeholderDefinition());
  using engine = new Engine({
    storage: new MemoryStorage(),
    backgroundTasks: 'manual',
    workflowExecutionMode: 'realm',
    revisionRealmExecution: {
      resolveRevisionRealmConfig: (_name, candidate) =>
        candidate === revision
          ? {
              workerUrl,
              createWorker: nodeWorkerFactory,
              expectedWorkflowTypes: [SENTINEL_WORKFLOW_NAME],
              transport,
              maxRestarts: 0,
            }
          : undefined,
    },
  });
  const definition = placeholderDefinition();
  engine.registerSource(
    workflowSource(
      {
        name: SENTINEL_WORKFLOW_NAME,
        location: './sentinel.ts',
        exportName: SENTINEL_WORKFLOW_NAME,
        revision,
      },
      () => Promise.resolve({ [SENTINEL_WORKFLOW_NAME]: definition }),
    ),
  );
  await engine.resolveWorkflowSource(SENTINEL_WORKFLOW_NAME, revision);
  const active = await engine.workflows.getActive(SENTINEL_WORKFLOW_NAME);
  const activation = await engine.workflows.activate(SENTINEL_WORKFLOW_NAME, revision, {
    ...(active === null ? {} : { expectedGeneration: active.generation }),
    policy: { requireExactRevision: false },
  });
  assert.equal(activation.applied, true);
  assert.deepEqual(await (await engine.start(SENTINEL_WORKFLOW_NAME, 'native')).result(), {
    sawInput: 'native',
    ranInsideRealm: true,
  });
}

const childFailure = (async () => {
  const realm = new ChildProcessRealm({
    scriptPath: fixtureUrl('node-runtime-throwing-child.mjs'),
    expectedWorkflowTypes: ['node-runtime'],
    isReferenced: () => true,
    maxRestarts: 0,
  });
  const readiness = await realm.waitUntilReady();
  await realm.whenReclaimed();
  return readiness;
})();

void test('Node worker adapter and child realm failure use portable transports', async () => {
  await using pool = new WorkerPool({
    concurrency: 1,
    workerUrl: activityWorkerUrl,
    createWorker: nodeWorkerFactory,
  });
  await using dispatcher = new ActivityWorkerDispatcher(pool);
  const result = await dispatcher.execute({
    operationId: 'node-runtime-activity',
    activityName: 'echo',
    input: { activity: 'ran' },
    attempt: 1,
  });
  assert.deepEqual(result, {
    operationId: 'node-runtime-activity',
    status: 'completed',
    result: { activity: 'ran' },
  });

  const readiness = await childFailure;
  assert.equal(readiness.ok, false);
});

void test('Node Engine executes a real worker realm workflow', async () => {
  const workerFixture = process.env.WEFT_NODE_WORKER_REALM_FIXTURE;
  assert.ok(workerFixture);
  await runRealm('worker', workerFixture);
});
