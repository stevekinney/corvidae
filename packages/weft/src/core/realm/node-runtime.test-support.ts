import assert from 'node:assert/strict';
import { basename, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { nodeWorkerFactory } from '../../node-host.ts';
import { ActivityWorkerDispatcher } from '../../workers/activity-worker-dispatcher.ts';
import { WorkerPool } from '../../workers/pool.ts';
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

const childFailure = (async () => {
  const realm = new ChildProcessRealm({
    scriptPath: fixtureUrl('node-runtime-throwing-child.mjs'),
    expectedWorkflowTypes: ['node-runtime'],
    isReferenced: () => true,
  });
  const readiness = await realm.waitUntilReady();
  await realm.whenReclaimed();
  return readiness;
})();

void test('Node worker and child realms run through portable transports', async () => {
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
