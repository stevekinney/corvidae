/**
 * COR-2165 — what a contributed trigger's listener is doing, through a Bureau: the `listener` on
 * `workflows.list` and `get`, and the `trigger-failed` problem a failed start adds to its plugin
 * (`bureau.plugins.list()`, which `GET /host/plugins` serves) and a later success removes.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { waitUntil } from '@lostgradient/testing/wait-until';

import { REDACTED_SECRET } from './plugins/compose-plugins';
import { listedPlugins } from './testing/plugin-listing.test-support';
import {
  WATCH_TOKEN,
  WATCH_TOKEN_KEY,
  watchPlugin,
  type WatchPlugin,
} from './testing/watch-plugin.test-support';
import {
  startWorkflowBureau,
  type WorkflowBureauHarness,
} from './testing/workflow-bureau.test-support';
import { workflowFileText } from './testing/workflow-file-fixtures.test-support';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

/** A Bureau that loads plugin `x`. */
async function bureauWith(plugin: WatchPlugin, secret = false): Promise<WorkflowBureauHarness> {
  const harness = await startWorkflowBureau({
    overrides: {
      plugins: [plugin.entry],
      onDiagnostic: () => undefined,
      ...(secret
        ? {
            pluginSecrets: {
              get: async (key: string) => (key === WATCH_TOKEN_KEY ? WATCH_TOKEN : undefined),
              watch: () => () => undefined,
            },
          }
        : {}),
    },
  });
  cleanups.push(() => harness.dispose());
  return harness;
}

/** The file `id`, which `x:watch` triggers on `account`. */
const watching = (id: string, account: string, overrides: Record<string, unknown> = {}) =>
  workflowFileText(id, {
    trigger: { kind: 'x:watch', account },
    ...overrides,
  });

/** The `trigger-failed` problems plugin `x` lists. */
async function failedWorkflows(harness: WorkflowBureauHarness): Promise<string[]> {
  const problems = await triggerProblems(harness);
  return (problems ?? []).map((problem) => (problem as { workflow: string }).workflow);
}

/** What `workflows.get` says the listener of workflow `id` is doing. */
async function listenerOf(harness: WorkflowBureauHarness, id: string) {
  const detail = await harness.bureau.workflows?.get(id);
  return detail?.listener;
}

async function triggerProblems(harness: WorkflowBureauHarness) {
  const [listing] = await listedPlugins(harness.bureau);
  return listing?.problems.filter((problem) => problem.code === 'trigger-failed');
}

describe('the listener of a contributed trigger, through a Bureau', () => {
  it('is listening once start resolved, on workflows.list and workflows.get', async () => {
    const plugin = watchPlugin();
    const harness = await bureauWith(plugin);
    await harness.put('watcher.json', watching('watcher', 'good'));
    await harness.bureau.workflows?.refresh();

    const listed = harness.bureau.workflows?.list().find((entry) => entry.id === 'watcher');
    expect(listed?.listener).toMatchObject({
      state: 'listening',
      code: null,
      lastFiredAt: null,
    });
    expect(typeof listed?.listener?.since).toBe('string');
    const detail = await harness.bureau.workflows?.get('watcher');
    expect(detail?.listener).toEqual(listed?.listener ?? null);
    expect(await triggerProblems(harness)).toEqual([]);
  });

  it('adds one trigger-failed problem naming the workflow, redacted, and a later success removes it', async () => {
    const plugin = watchPlugin({ secret: true });
    plugin.failing.add('bad');
    const harness = await bureauWith(plugin, true);
    await harness.put('watcher.json', watching('watcher', 'bad'));
    await harness.bureau.workflows?.refresh();

    expect(
      harness.bureau.workflows?.list().find((entry) => entry.id === 'watcher')?.listener,
    ).toMatchObject({ state: 'failed', code: 'start-failed' });
    const problems = await triggerProblems(harness);
    expect(problems).toEqual([
      {
        code: 'trigger-failed',
        workflow: 'watcher',
        message: `the source refused ${REDACTED_SECRET} for "bad"`,
      },
    ]);
    expect(JSON.stringify(await harness.bureau.plugins.list())).not.toContain(WATCH_TOKEN);
    // Unrelated to the file's change of state: a second failing file is a second problem.
    await harness.put('second.json', watching('second', 'bad'));
    await harness.bureau.workflows?.refresh();
    expect(await failedWorkflows(harness)).toEqual(['watcher', 'second']);

    // The file is edited onto an account that starts: listening, and the problem is gone.
    await harness.put('watcher.json', watching('watcher', 'good'));
    await harness.bureau.workflows?.refresh();
    expect(await listenerOf(harness, 'watcher')).toMatchObject({ state: 'listening', code: null });
    expect(await failedWorkflows(harness)).toEqual(['second']);

    // Pausing the failed file clears its problem too: it is stopped, not failed.
    await harness.put('second.json', watching('second', 'good', { paused: true }));
    await harness.bureau.workflows?.refresh();
    expect(await triggerProblems(harness)).toEqual([]);
  });

  it('is stopped for a paused file, which starts nothing', async () => {
    const plugin = watchPlugin();
    const harness = await bureauWith(plugin);
    await harness.put('watcher.json', watching('watcher', 'good', { paused: true }));
    await harness.bureau.workflows?.refresh();

    expect(
      harness.bureau.workflows?.list().find((entry) => entry.id === 'watcher')?.listener,
    ).toMatchObject({ state: 'stopped', code: null });
    expect(plugin.contexts).toEqual([]);
    await harness.put('watcher.json', watching('watcher', 'good'));
    await harness.bureau.workflows?.refresh();
    await waitUntil(() => plugin.contexts.length === 1, { message: 'the unpaused file to start' });
    expect(await listenerOf(harness, 'watcher')).toMatchObject({ state: 'listening' });
  });

  it('is null for a built-in trigger, an invalid file, and a file whose listener is gone', async () => {
    const plugin = watchPlugin();
    const harness = await bureauWith(plugin);
    await harness.putWorkflow('scheduled');
    await harness.put('broken.json', '{ not json');
    await harness.put('watcher.json', watching('watcher', 'good'));
    await harness.bureau.workflows?.refresh();

    const listed = harness.bureau.workflows?.list() ?? [];
    expect(listed.find((entry) => entry.id === 'scheduled')?.listener).toBeNull();
    const broken = listed.find((entry) => entry.state === 'invalid');
    expect(broken?.listener).toBeNull();
    expect(listed.find((entry) => entry.id === 'watcher')?.listener).toMatchObject({
      state: 'listening',
    });

    // The file is now invalid: its listener is stopped, and says nothing.
    await harness.put('watcher.json', '{ not json');
    await harness.bureau.workflows?.refresh();
    expect(
      harness.bureau.workflows?.list().find((entry) => entry.id === 'watcher')?.listener,
    ).toBeNull();
  });

  describe('retrying a failed start on the Bureau’s timers (COR-2166)', () => {
    /** A Bureau on a manual clock and manual timers, with `x:watch` failing for `bad`. */
    async function onManualTimers() {
      const runtime = createManualRuntimeServices({ origin: '2026-11-15T00:00:00.000Z' });
      const plugin = watchPlugin({ secret: true });
      plugin.failing.add('bad');
      const harness = await startWorkflowBureau({
        overrides: {
          plugins: [plugin.entry],
          runtime,
          onDiagnostic: () => undefined,
          pluginSecrets: {
            get: async (key: string) => (key === WATCH_TOKEN_KEY ? WATCH_TOKEN : undefined),
            watch: () => () => undefined,
          },
        },
      });
      cleanups.push(() => harness.dispose());
      return { runtime, plugin, harness };
    }

    it('starts again after 1, then 2, then 4 seconds, with retryAt on the listener, and a success clears the problem', async () => {
      const { runtime, plugin, harness } = await onManualTimers();
      await harness.put('watcher.json', watching('watcher', 'bad'));
      await harness.bureau.workflows?.refresh();
      const listener = () =>
        harness.bureau.workflows?.list().find((e) => e.id === 'watcher')?.listener;
      const started = () => plugin.startCounts.get('bad') ?? 0;

      expect(listener()).toMatchObject({ state: 'failed', retryAt: '2026-11-15T00:00:01.000Z' });
      expect(started()).toBe(1);
      await runtime.advance(1_000);
      await waitUntil(() => started() === 2, { message: 'the first retry' });
      await waitUntil(() => listener()?.retryAt === '2026-11-15T00:00:03.000Z', {
        message: 'the second delay',
      });
      await runtime.advance(2_000);
      await waitUntil(() => started() === 3, { message: 'the second retry' });
      await waitUntil(() => listener()?.retryAt === '2026-11-15T00:00:07.000Z', {
        message: 'the third delay',
      });
      expect(await failedWorkflows(harness)).toEqual(['watcher']);

      plugin.failing.delete('bad');
      await runtime.advance(4_000);
      await waitUntil(() => listener()?.state === 'listening', { message: 'the success' });
      expect(listener()).toMatchObject({ code: null, retryAt: null });
      expect(await failedWorkflows(harness)).toEqual([]);
    });

    it('retryTrigger starts at once and clears the backoff, and a refused configuration is not retried', async () => {
      const { runtime, plugin, harness } = await onManualTimers();
      await harness.put('watcher.json', watching('watcher', 'bad'));
      await harness.bureau.workflows?.refresh();
      await runtime.advance(1_000);
      // The retry has started and failed again, and the next one is two seconds on.
      await waitUntil(
        () =>
          harness.bureau.workflows?.list().find((entry) => entry.id === 'watcher')?.listener
            ?.retryAt === '2026-11-15T00:00:03.000Z',
        { message: 'the retry to settle' },
      );
      expect(plugin.startCounts.get('bad')).toBe(2);

      const outcome = await harness.bureau.workflows?.retryTrigger('watcher');
      expect(outcome).toMatchObject({ outcome: 'retried', listener: { state: 'failed' } });
      expect(plugin.startCounts.get('bad')).toBe(3);
      // The backoff was cleared: the next wait is one second, not four.
      const listener = (await listenerOf(harness, 'watcher'))!;
      expect(Date.parse(listener.retryAt!) - runtime.clock.now()).toBe(1_000);

      expect(await harness.bureau.workflows?.retryTrigger('ghost')).toBeUndefined();
      await harness.putWorkflow('scheduled');
      expect(await harness.bureau.workflows?.retryTrigger('scheduled')).toEqual({
        outcome: 'no-listener',
      });
    });

    it('waits for a file queued behind another file’s slow start, instead of answering that it has no listener', async () => {
      const { plugin, harness } = await onManualTimers();
      await harness.put('aa-held.json', watching('aa-held', 'hold'));
      await harness.put('bb-late.json', watching('bb-late', 'late'));
      const release = plugin.hold('hold');
      const applying = harness.bureau.workflows?.refresh();
      await waitUntil(() => plugin.startCounts.get('hold') === 1, { message: 'the held start' });
      expect(plugin.startCounts.get('late')).toBeUndefined();

      const retrying = harness.bureau.workflows?.retryTrigger('bb-late');
      release();
      expect(await retrying).toMatchObject({
        outcome: 'retried',
        listener: { state: 'listening' },
      });
      await applying;
      expect(plugin.startCounts.get('late')).toBe(1);
    });

    it('closing the Bureau cancels the pending retry', async () => {
      const { runtime, plugin, harness } = await onManualTimers();
      await harness.put('watcher.json', watching('watcher', 'bad'));
      await harness.bureau.workflows?.refresh();
      expect(plugin.startCounts.get('bad')).toBe(1);
      await harness.bureau.dispose();
      await runtime.advance(3_600_000);
      expect(plugin.startCounts.get('bad')).toBe(1);
    });
  });

  it('keeps lastFiredAt for a fire that started a run', async () => {
    const plugin = watchPlugin();
    const harness = await bureauWith(plugin);
    await harness.put('watcher.json', watching('watcher', 'good'));
    await harness.bureau.workflows?.refresh();

    const outcome = await plugin.contexts[0]!.fire({ n: 1 });
    expect(outcome.outcome).toBe('started');
    const listener = await listenerOf(harness, 'watcher');
    expect(listener?.state).toBe('listening');
    expect(typeof listener?.lastFiredAt).toBe('string');
  });
});
