/**
 * COR-1527 — an instance Bureau cannot register must not stop the rest of the store recovering. A
 * Bureau over a store holds two parked instances, one of a workflow whose file is then deleted and
 * whose pinned revision is corrupted; the next Bureau recovers cleanly, resumes the other instance,
 * and reports the stranded one cancelled with its reason.
 */
import { mkdtemp, rm, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const parked = (question: string) => ({
  trigger: { kind: 'schedule', spec: '1h' },
  steps: [
    { kind: 'await-signal', signal: 'go' },
    { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: question } },
  ],
});

describe('a Bureau started over a store with an instance it cannot register', () => {
  it('recovers cleanly, resumes the other instances, and reads the stranded one as cancelled', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-stranded-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const workflows = join(root, 'workflows');
    const overrides = {
      storage: { type: 'sqlite', path: join(root, 'bureau.sqlite') },
      durableOwnership: { ownership: 'none' },
      onDiagnostic: () => undefined,
    } as const;

    const first = await startWorkflowBureau({ directory: workflows, overrides });
    await first.put('stranded.json', workflowFileText('stranded', parked('stranded question')));
    await first.put('healthy.json', workflowFileText('healthy', parked('healthy question')));
    await first.bureau.workflows?.refresh();
    const engine = first.bureau.durableEngine()!;
    await engine.start('stranded', null, { id: 'stranded-run' });
    await engine.start('healthy', null, { id: 'healthy-run' });
    // A later revision of the stranded workflow, so the identifier stays known, then corrupt the
    // revision the parked instance is pinned to.
    await first.put('stranded.json', workflowFileText('stranded', parked('stranded edited')));
    await first.bureau.workflows?.refresh();
    for (const key of await first.bureau.kv!.list('bureau-workflow-snapshot:v1:stranded:')) {
      const stored = JSON.parse((await first.bureau.kv!.get(key)) ?? '{}');
      if (stored.document?.steps?.[1]?.input?.message === 'stranded question') {
        await first.bureau.kv!.set(key, '{"schemaVersion":1}');
      }
    }
    await first.dispose();
    await unlink(join(workflows, 'stranded.json'));

    const second = await startWorkflowBureau({ directory: workflows, overrides });
    cleanups.push(() => second.dispose());
    const report = await second.bureau.waitForRecovery?.();
    expect(report?.outcome).toBe('clean');
    expect(report?.perRunFailures).toEqual([]);

    await second.bureau.durableEngine()!.signal('healthy-run', 'go', null);
    const healthy = await second.bureau.waitForDurableRun('healthy-run');
    expect(healthy?.status).toBe('completed');
    expect(second.calls.map((call) => call.message)).toEqual(['healthy question']);

    const stranded = await second.bureau.workflows?.getRun('stranded-run');
    expect(stranded?.status).toBe('cancelled');
    expect(stranded?.error).toContain('cannot be used');
    const listed = await second.bureau.workflows?.listRuns({ limit: 10, offset: 0 });
    expect(listed?.runs.map((run) => run.id).toSorted()).toEqual(['healthy-run', 'stranded-run']);
  });
});
