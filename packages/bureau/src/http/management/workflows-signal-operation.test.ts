/**
 * COR-1528 — `bureau.workflows.signal` over the handler, with two principals: the deployment's
 * owner, and an API-key caller who holds no scope. The second is answered as if nothing matched,
 * and nothing is started or delivered for it.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { workflowFileText } from '../../testing/workflow-file-fixtures.test-support.ts';
import { rpc } from './management-fixtures.test-support.ts';
import { ownerRpc, serveWorkflows } from './workflows-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function served() {
  const harness = await serveWorkflows(cleanups);
  const { directory, bureau } = harness;
  await writeFile(
    join(directory, 'starter.json'),
    workflowFileText('starter', { trigger: { kind: 'signal', name: 'go' } }),
  );
  await writeFile(
    join(directory, 'waiter.json'),
    workflowFileText('waiter', {
      trigger: { kind: 'signal', name: 'begin' },
      steps: [{ kind: 'await-signal', signal: 'go' }],
    }),
  );
  await bureau.workflows!.refresh();
  const engine = bureau.durableEngine()!;
  await engine.start('waiter', null, { id: 'waiting-run' });
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const state = await engine.get('waiting-run');
    if (state?.waitingForSignals?.includes('go') === true) break;
    await Bun.sleep(5);
  }
  return harness;
}

async function instancesOf(harness: Awaited<ReturnType<typeof served>>, workflow: string) {
  const runs = await harness.bureau.workflows!.listRuns({ workflow, limit: 50, offset: 0 });
  return runs.runs;
}

describe('bureau.workflows.signal', () => {
  it('starts the owner’s signal workflows and delivers to the owner’s waiting instances', async () => {
    const harness = await served();

    const response = await ownerRpc(harness.owner, 'bureau.workflows.signal', {
      name: 'go',
      payload: { n: 1 },
    });

    expect(response.error).toBeUndefined();
    const result = response.result as { started: string[]; delivered: string[] };
    expect(result.delivered).toEqual(['waiting-run']);
    expect(result.started).toHaveLength(1);
    const instances = await instancesOf(harness, 'starter');
    expect(instances.map((run) => run.id)).toEqual(result.started);
    const waiting = await harness.bureau.workflows!.getRun('waiting-run');
    expect(waiting?.status).not.toBe('failed');
  });

  it('answers an API-key caller with no scope as if nothing matched, and starts and delivers nothing', async () => {
    const harness = await served();

    const response = await rpc(
      harness.keyed,
      'bureau.workflows.signal',
      { name: 'go', payload: { n: 1 } },
      'alice-key',
    );

    expect(response.error).toBeUndefined();
    expect(response.result).toEqual({ started: [], delivered: [] });
    expect(await instancesOf(harness, 'starter')).toEqual([]);
    const waiting = await harness.bureau.durableEngine()!.get('waiting-run');
    expect(waiting?.status).toBe('running');
    expect(waiting?.waitingForSignals).toEqual(['go']);
  });

  it('serves a caller who holds bureau.workflows:write, and not one who holds only read', async () => {
    const harness = await served();

    const reader = await rpc(
      harness.keyed,
      'bureau.workflows.signal',
      { name: 'go' },
      'workflows-reader-key',
    );
    expect(reader.result).toEqual({ started: [], delivered: [] });
    expect(await instancesOf(harness, 'starter')).toEqual([]);

    const writer = await rpc(
      harness.keyed,
      'bureau.workflows.signal',
      { name: 'go' },
      'workflows-writer-key',
    );
    expect((writer.result as { started: string[] }).started).toHaveLength(1);
  });

  it('rejects a call with no name, a blank signalId, or a key the operation does not declare', async () => {
    const harness = await served();
    for (const params of [
      {},
      { name: '' },
      { name: 'go', signalId: '' },
      { name: 'go', workflow: 'starter' },
    ]) {
      const response = await ownerRpc(harness.owner, 'bureau.workflows.signal', params);
      expect(response.error?.data?.httpStatus, JSON.stringify(params)).toBe(400);
    }
    expect(await instancesOf(harness, 'starter')).toEqual([]);
  });
});
