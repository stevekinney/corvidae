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

  it('answers a signalId over 128 bytes, counted in bytes, with InvalidParams and no effect', async () => {
    const harness = await served();
    for (const signalId of ['a'.repeat(129), '😀'.repeat(50), 'a'.repeat(200)]) {
      const response = await ownerRpc(harness.owner, 'bureau.workflows.signal', {
        name: 'go',
        signalId,
      });
      expect(response.error?.data?.httpStatus, signalId).toBe(400);
    }
    expect(await instancesOf(harness, 'starter')).toEqual([]);
    const waiting = await harness.bureau.durableEngine()!.get('waiting-run');
    expect(waiting?.waitingForSignals).toEqual(['go']);
    const ok = await ownerRpc(harness.owner, 'bureau.workflows.signal', {
      name: 'go',
      signalId: 'a'.repeat(128),
    });
    expect(ok.error).toBeUndefined();
  });

  it('answers an engine error during delivery as Unavailable carrying what was delivered, and starts nothing', async () => {
    const harness = await served();
    const engine = harness.bureau.durableEngine()!;
    await engine.start('waiter', null, { id: 'second-run' });
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      const state = await engine.get('second-run');
      if (state?.waitingForSignals?.includes('go') === true) break;
      await Bun.sleep(5);
    }
    const original = engine.signal.bind(engine) as (...args: unknown[]) => Promise<void>;
    let calls = 0;
    (engine as unknown as { signal: unknown }).signal = async (...args: unknown[]) => {
      calls += 1;
      if (calls === 2) throw new Error('storage unavailable');
      return original(...args);
    };

    const response = await ownerRpc(harness.owner, 'bureau.workflows.signal', { name: 'go' });

    expect(response.error?.data?.httpStatus).toBe(503);
    expect(response.error?.data?.['reason']).toBe('signal-delivery-failed');
    expect(response.error?.message).toMatch(/Delivered to: (waiting-run|second-run)\./);
    expect(await instancesOf(harness, 'starter')).toEqual([]);
  });

  it('answers a pending apply failure as Unavailable carrying what was delivered, and starts nothing', async () => {
    const harness = await served();
    const engine = harness.bureau.durableEngine()!;
    await writeFile(
      join(harness.directory, 'digest.json'),
      workflowFileText('digest', { trigger: { kind: 'schedule', spec: '1h' } }),
    );
    await harness.bureau.workflows!.refresh();
    (engine as unknown as { pauseSchedule: unknown }).pauseSchedule = async () => {
      throw new Error('storage unavailable');
    };
    const hash = harness.bureau.workflows!.list().find((entry) => entry.id === 'digest')!.hash!;
    await harness.bureau.workflows!.pause('digest', { expectedHash: hash }).catch(() => undefined);

    const response = await ownerRpc(harness.owner, 'bureau.workflows.signal', { name: 'go' });

    expect(response.error?.data?.httpStatus).toBe(503);
    expect(response.error?.data?.['reason']).toBe('workflow-apply-failed');
    expect(response.error?.message).toContain('Delivered to: waiting-run.');
    expect(await instancesOf(harness, 'starter')).toEqual([]);
  });
});
