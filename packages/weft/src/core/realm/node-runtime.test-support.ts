import assert from 'node:assert/strict';
import test from 'node:test';

import { MemoryStorage } from '@lostgradient/storage';
import { nodeWorkerFactory } from '../../node-host.ts';
import { deriveWorkflowDefinitionRevision } from '../engine/definition-revision.ts';
import { Engine } from '../engine/index.ts';
import { workflowSource } from '../source/index.ts';
import { activity, workflow, type WorkflowDefinition } from '../types.ts';
import { NODE_RUNTIME_WORKFLOW_NAME } from './__fixtures__/node-runtime-activity-handler.fixture.ts';
import { readNodeRuntimeRealmTestEnvironment } from './node-runtime-test-environment.ts';

const echo = activity({
  name: 'echo',
  execute: async (input: unknown) => ({ activity: input }),
});
const throwActivity = activity({
  name: 'throw',
  execute: async () => {
    throw new Error('node runtime child failure');
  },
});

function realmDefinition(): WorkflowDefinition {
  return workflow({ name: NODE_RUNTIME_WORKFLOW_NAME })
    .activities({ echo, throw: throwActivity })
    .execute(async function* () {
      throw new Error('realm fixture must execute this workflow');
    });
}

async function revisionFor(definition: WorkflowDefinition): Promise<string> {
  return deriveWorkflowDefinitionRevision(definition);
}

async function runRealm(
  transport: 'worker' | 'child-process',
  workerUrl: string,
  input: 'native' | 'fail',
): Promise<void> {
  const definition = realmDefinition();
  const revision = await revisionFor(definition);
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
              expectedWorkflowTypes: [NODE_RUNTIME_WORKFLOW_NAME],
              transport,
              maxRestarts: 0,
            }
          : undefined,
    },
  });
  engine.registerSource(
    workflowSource(
      {
        name: NODE_RUNTIME_WORKFLOW_NAME,
        location: './sentinel.ts',
        exportName: NODE_RUNTIME_WORKFLOW_NAME,
        revision,
      },
      () => Promise.resolve({ [NODE_RUNTIME_WORKFLOW_NAME]: definition }),
    ),
  );
  await engine.resolveWorkflowSource(NODE_RUNTIME_WORKFLOW_NAME, revision);
  const active = await engine.workflows.getActive(NODE_RUNTIME_WORKFLOW_NAME);
  const activation = await engine.workflows.activate(NODE_RUNTIME_WORKFLOW_NAME, revision, {
    ...(active === null ? {} : { expectedGeneration: active.generation }),
    policy: { requireExactRevision: false },
  });
  assert.equal(activation.applied, true);
  const handle = await engine.start(NODE_RUNTIME_WORKFLOW_NAME, input);
  if (input === 'fail') {
    await assert.rejects(handle.result(), /node runtime child failure/u);
    return;
  }
  assert.deepEqual(await handle.result(), { activity: 'native' });
}

void test('Node Engine executes one in-process activity workflow', async () => {
  const definition = workflow({ name: 'node-runtime-in-process' })
    .activities({ echo })
    .execute(async function* (context, input: unknown) {
      return yield* context.run(echo, input);
    });
  using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
  engine.register(definition);
  const handle = await engine.start(definition.name, 'native');
  assert.deepEqual(await handle.result(), {
    activity: 'native',
  });
});

void test('Node Engine executes one Worker realm activity workflow', async () => {
  const { workerFixture } = readNodeRuntimeRealmTestEnvironment();
  assert.ok(workerFixture);
  await runRealm('worker', workerFixture, 'native');
});

void test('Node Engine executes and fails child-process realm activity workflows', async () => {
  const { childFixture } = readNodeRuntimeRealmTestEnvironment();
  assert.ok(childFixture);
  await runRealm('child-process', childFixture, 'native');
  await runRealm('child-process', childFixture, 'fail');
});

void test('Node worker factory reports a crashing module through its error event', async () => {
  const worker = nodeWorkerFactory(
    new URL('data:text/javascript,throw%20new%20Error(%22native%20worker%20crash%22)'),
  );
  try {
    const message = await new Promise<string>((resolve) => {
      worker.addEventListener('error', (event) => {
        const message = Reflect.get(event, 'message');
        if (typeof message === 'string') {
          resolve(message);
        }
      });
    });
    assert.equal(message, 'native worker crash');
  } finally {
    await worker.terminate();
  }
});
