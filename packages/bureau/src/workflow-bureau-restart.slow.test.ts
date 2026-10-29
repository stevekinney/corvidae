/**
 * COR-1527 — a graceful restart resumes workflow instances. A Bureau holds instances parked in a
 * `sleep`, on an `await-signal`, and mid agent step, is shut down with `shutdown()`, and a new
 * Bureau over the same store must resume every one on the revision it began on, with nothing
 * reported as failed. Recovery once read these instances as foreign runs and cancelled them, which
 * the SIGKILL scenario cannot show, because a dead process's expired claims are taken over by
 * another path and never reach that classifier.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { startWorkflowBureau } from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';
import { awakeTurns } from '@lostgradient/testing/wait-until';
import { createSqliteStorageFixture } from './test/storage-fixtures';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const trigger = { kind: 'schedule', spec: '1h' };
const agentStep = (message: string) => ({
  kind: 'activity',
  handler: 'agent',
  input: { agent: 'writer', message },
});

const OWNERSHIPS = [
  ['ownership: none', { ownership: 'none' }],
  ['the default workflow lease', undefined],
] as const;

for (const [label, ownership] of OWNERSHIPS) {
  describe(`a graceful restart under ${label}`, () => {
    it('resumes instances parked in a sleep, on a signal, and mid agent step, each on its original revision', async () => {
      const root = await mkdtemp(join(tmpdir(), 'bureau-workflow-graceful-'));
      cleanups.push(() => rm(root, { recursive: true, force: true }));
      const workflows = join(root, 'workflows');
      const database = createSqliteStorageFixture({ path: join(root, 'bureau.sqlite') });
      cleanups.push(() => database.dispose());
      const overrides = {
        // A getter: each Bureau started with these overrides opens its own handle.
        get storage() {
          return database.open();
        },
        ...(ownership === undefined ? {} : { durableOwnership: ownership }),
        onDiagnostic: () => undefined,
      } as const;

      // The first Bureau's model never answers the mid-step question, so that instance is in the
      // agent step when the Bureau is shut down.
      const first = await startWorkflowBureau({
        directory: workflows,
        overrides,
        replies: {
          writer: (call) =>
            call.message.startsWith('midstep') ? new Promise<never>(() => {}) : 'first',
        },
      });
      await first.put(
        'sleeper.json',
        workflowFileText('sleeper', {
          trigger,
          steps: [{ kind: 'sleep', duration: '2s' }, agentStep('sleeper original')],
        }),
      );
      await first.put(
        'waiter.json',
        workflowFileText('waiter', {
          trigger,
          steps: [{ kind: 'await-signal', signal: 'go' }, agentStep('waiter original')],
        }),
      );
      await first.put(
        'midstep.json',
        workflowFileText('midstep', { trigger, steps: [agentStep('midstep original')] }),
      );
      await first.bureau.workflows?.refresh();
      const engine = first.bureau.durableEngine()!;
      await engine.start('sleeper', null, { id: 'sleeper-run' });
      await engine.start('waiter', null, { id: 'waiter-run' });
      await engine.start('midstep', null, { id: 'midstep-run' });
      for await (const _turn of awakeTurns()) {
        if (!(first.calls.length < 1)) break;
        await Bun.sleep(5);
      }
      // Edit every file after the instances started, so the originals must come from snapshots.
      await first.put(
        'sleeper.json',
        workflowFileText('sleeper', {
          trigger,
          steps: [{ kind: 'sleep', duration: '2s' }, agentStep('sleeper EDITED')],
        }),
      );
      await first.put(
        'waiter.json',
        workflowFileText('waiter', {
          trigger,
          steps: [{ kind: 'await-signal', signal: 'go' }, agentStep('waiter EDITED')],
        }),
      );
      await first.bureau.workflows?.refresh();
      const shutdown = await first.bureau.shutdown();
      expect(shutdown.unresolved).toBeLessThanOrEqual(1);

      const second = await startWorkflowBureau({ directory: workflows, overrides });
      cleanups.push(() => second.dispose());
      const report = await second.bureau.recovery();
      expect(report?.perRunFailures).toEqual([]);
      expect(report?.outcome).toBe('clean');

      await second.bureau.durableEngine()!.signal('waiter-run', 'go', null);
      for (const id of ['sleeper-run', 'waiter-run', 'midstep-run']) {
        const state = await second.bureau.tasks.wait(id);
        expect(state?.status, id).toBe('completed');
      }
      expect(
        second.calls
          .map((call) => call.message.split('\n')[0])
          .toSorted((left, right) => (left ?? '').localeCompare(right ?? '')),
      ).toEqual(['midstep original', 'sleeper original', 'waiter original']);
    });
  });
}
