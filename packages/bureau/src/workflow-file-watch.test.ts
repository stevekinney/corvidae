/**
 * COR-1527 — adding, editing, and deleting a workflow file takes effect without a restart, and a
 * change the watcher drops is found by the agent files' one-second backstop rescan. These tests
 * change real files in a real directory and wait for the catalog's own change event.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { quietFor } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { DefinitionChange } from './definition-scanner';
import { nodeAgentFileOperations } from './sources/agent-file-operations';
import {
  createWorkflowFileFixture,
  type WorkflowFileFixture,
  workflowFileText,
} from './testing/workflow-file-fixtures.test-support';
import { DIRECTORY_POLL_INTERVAL_MILLISECONDS } from './sources/watched-directory';

const fixtures: WorkflowFileFixture[] = [];

async function start(options?: Parameters<typeof createWorkflowFileFixture>[0]) {
  const fixture = await createWorkflowFileFixture(options);
  fixtures.push(fixture);
  await fixture.catalog.refresh();
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe('watching the workflow directory', () => {
  it('picks up an added file', async () => {
    const fixture = await start();
    const changed = fixture.nextChange((change) => change.added.includes('late'));
    await fixture.put('late.json', workflowFileText('late'));
    await changed;
    expect(fixture.catalog.find('late')).toBeDefined();
  });

  it('picks up an edit in place and one made by renaming a new file over the old one', async () => {
    const fixture = await start();
    await fixture.put('one.json', workflowFileText('one'));
    await fixture.catalog.refresh();
    const first = fixture.catalog.find('one')?.version;
    const edited = fixture.nextChange((change) => change.changed.includes('one'));
    await fixture.put(
      'one.json',
      workflowFileText('one', { steps: [{ kind: 'sleep', duration: 1 }] }),
    );
    await edited;
    const second = fixture.catalog.find('one')?.version;
    expect(second).not.toBe(first);

    const renamed = fixture.nextChange((change) => change.changed.includes('one'));
    await writeFile(join(fixture.directory, '.one.tmp'), workflowFileText('one'));
    await rename(join(fixture.directory, '.one.tmp'), join(fixture.directory, 'one.json'));
    await renamed;
    expect(fixture.catalog.find('one')?.version).toBe(first);
  });

  it('picks up a deleted file, and a file turning invalid and valid again', async () => {
    const fixture = await start();
    await fixture.put('one.json', workflowFileText('one'));
    await fixture.catalog.refresh();
    const broken = fixture.nextChange((change) => change.changed.includes('one'));
    await fixture.put('one.json', '{');
    await broken;
    expect(fixture.catalog.list()[0]?.state).toBe('invalid');
    const repaired = fixture.nextChange((change) => change.changed.includes('one'));
    await fixture.put('one.json', workflowFileText('one'));
    await repaired;
    expect(fixture.catalog.list()[0]?.state).toBe('ready');
    const removed = fixture.nextChange((change) => change.removed.includes('one'));
    await rm(join(fixture.directory, 'one.json'));
    await removed;
    expect(fixture.catalog.list()).toEqual([]);
  });

  it('survives its directory being deleted and created again, and starts without one', async () => {
    const fixture = await start({ subdirectory: 'workflows' });
    expect(fixture.catalog.list()).toEqual([]);
    const added = fixture.nextChange((change) => change.added.includes('first'));
    await mkdir(fixture.directory);
    await fixture.put('first.json', workflowFileText('first'));
    await added;
    const removed = fixture.nextChange((change) => change.removed.includes('first'));
    await rm(fixture.directory, { recursive: true });
    await removed;
    const again = fixture.nextChange((change) => change.added.includes('second'));
    await mkdir(fixture.directory);
    await fixture.put('second.json', workflowFileText('second'));
    await again;
    expect(fixture.catalog.find('second')).toBeDefined();
  });

  it('reports each change once and stays silent when nothing changed', async () => {
    const fixture = await start();
    const changes: string[][] = [];
    fixture.catalog.onChange((change) => changes.push([...change.added]));
    await fixture.put('one.json', workflowFileText('one'));
    await fixture.catalog.refresh();
    await fixture.catalog.refresh();
    expect(changes).toEqual([['one']]);
  });
});

describe('the backstop rescan', () => {
  it('lists a disk edit within the agent files’ rescan interval, even if the watcher reports nothing', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = await start({
      runtime,
      // A watcher that never reports anything: only the interval can find the edit.
      openWatcher: () => ({ on: () => undefined, close: () => undefined }) as never,
      operations: { ...nodeAgentFileOperations },
    });
    expect(fixture.catalog.list()).toEqual([]);

    await fixture.put('quiet.json', workflowFileText('quiet'));
    const changed = fixture.nextChange((change) => change.added.includes('quiet'));
    await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await changed;
    expect(fixture.catalog.list().map((entry) => entry.id)).toEqual(['quiet']);
  });
});

/**
 * COR-2291 — `watch: 'poll'` opens no native watcher: the directory's own once-a-second rescan is
 * the only thing that looks, and it lists the real directory. Every row changes real files, calls
 * nothing but the manual clock, and waits for the catalog's own change event.
 */
describe("the polling-only watch (watch: 'poll')", () => {
  async function startPolling(options?: Parameters<typeof createWorkflowFileFixture>[0]) {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const watcherCalls: string[] = [];
    const diagnoses: string[] = [];
    const fixture = await start({
      runtime,
      watch: 'poll',
      // Records the call and opens nothing, so a source that calls it anyway is caught by the count.
      openWatcher: (path) => {
        watcherCalls.push(path);
        return { on: () => undefined, close: () => undefined } as never;
      },
      diagnose: (message) => diagnoses.push(message),
      ...options,
    });
    return { fixture, runtime, watcherCalls, diagnoses };
  }

  /** Make `act` real changes, then let one interval pass and wait for the change that satisfies `predicate`. */
  async function afterInterval(
    context: Awaited<ReturnType<typeof startPolling>>,
    predicate: Parameters<WorkflowFileFixture['nextChange']>[0],
    act: () => Promise<void>,
  ): Promise<void> {
    const changed = context.fixture.nextChange(predicate);
    await act();
    await context.runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await changed;
  }

  const rows: ReadonlyArray<{
    readonly name: string;
    readonly arrange?: (fixture: WorkflowFileFixture) => Promise<void>;
    readonly act: (fixture: WorkflowFileFixture) => Promise<void>;
    readonly expected: (change: DefinitionChange) => boolean;
    readonly afterwards: (fixture: WorkflowFileFixture) => void;
  }> = [
    {
      name: 'an added file',
      act: (fixture) => fixture.put('late.json', workflowFileText('late')),
      expected: (change) => change.added.includes('late'),
      afterwards: (fixture) => expect(fixture.catalog.find('late')).toBeDefined(),
    },
    {
      name: 'an edit in place',
      arrange: (fixture) => fixture.put('one.json', workflowFileText('one')),
      act: (fixture) =>
        fixture.put(
          'one.json',
          workflowFileText('one', { steps: [{ kind: 'sleep', duration: 1 }] }),
        ),
      expected: (change) => change.changed.includes('one'),
      afterwards: (fixture) => expect(fixture.catalog.find('one')).toBeDefined(),
    },
    {
      name: 'a file renamed into place over the old one',
      arrange: (fixture) =>
        fixture.put(
          'one.json',
          workflowFileText('one', { steps: [{ kind: 'sleep', duration: 1 }] }),
        ),
      act: async (fixture) => {
        await writeFile(join(fixture.directory, '.one.tmp'), workflowFileText('one'));
        await rename(join(fixture.directory, '.one.tmp'), join(fixture.directory, 'one.json'));
      },
      expected: (change) => change.changed.includes('one'),
      afterwards: (fixture) => expect(fixture.catalog.find('one')).toBeDefined(),
    },
    {
      name: 'a file renamed to another name',
      arrange: (fixture) => fixture.put('one.json', workflowFileText('one')),
      act: (fixture) =>
        rename(join(fixture.directory, 'one.json'), join(fixture.directory, 'two.json')),
      expected: (change) => change.added.includes('two') && change.removed.includes('one'),
      afterwards: (fixture) => {
        // The file names itself `one`, so under its new name it is listed, but as an invalid file.
        expect(fixture.catalog.list().map((entry) => entry.id)).toEqual(['two']);
      },
    },
    {
      name: 'a removed file',
      arrange: (fixture) => fixture.put('one.json', workflowFileText('one')),
      act: (fixture) => rm(join(fixture.directory, 'one.json')),
      expected: (change) => change.removed.includes('one'),
      afterwards: (fixture) => expect(fixture.catalog.list()).toEqual([]),
    },
    {
      name: 'the directory itself deleted',
      arrange: (fixture) => fixture.put('one.json', workflowFileText('one')),
      act: (fixture) => rm(fixture.directory, { recursive: true }),
      expected: (change) => change.removed.includes('one'),
      afterwards: (fixture) => expect(fixture.catalog.list()).toEqual([]),
    },
  ];

  for (const row of rows) {
    it(`finds ${row.name} at the interval, through a real scan, and opens no watcher`, async () => {
      const context = await startPolling();
      if (row.arrange !== undefined) {
        await afterInterval(
          context,
          (change) => change.added.includes('one'),
          () => row.arrange!(context.fixture),
        );
      }
      await afterInterval(context, row.expected, () => row.act(context.fixture));
      row.afterwards(context.fixture);
      expect(context.watcherCalls).toEqual([]);
      expect(context.diagnoses).toEqual([]);
    });
  }

  it('finds the directory created again, and a file in it', async () => {
    const context = await startPolling();
    await afterInterval(
      context,
      (change) => change.added.includes('one'),
      () => context.fixture.put('one.json', workflowFileText('one')),
    );
    await afterInterval(
      context,
      (change) => change.removed.includes('one'),
      () => rm(context.fixture.directory, { recursive: true }),
    );
    await afterInterval(
      context,
      (change) => change.added.includes('two'),
      async () => {
        await mkdir(context.fixture.directory);
        await context.fixture.put('two.json', workflowFileText('two'));
      },
    );
    expect(context.fixture.catalog.find('two')).toBeDefined();
    expect(context.watcherCalls).toEqual([]);
  });

  it('finds nothing without a watcher or a timer under watch: false, until a scan is asked for', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const watcherCalls: string[] = [];
    const fixture = await start({
      runtime,
      watch: false,
      openWatcher: (path) => {
        watcherCalls.push(path);
        return { on: () => undefined, close: () => undefined } as never;
      },
    });
    await fixture.put('quiet.json', workflowFileText('quiet'));
    await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS * 3);
    expect(runtime.pendingTimers()).toEqual([]);
    expect(watcherCalls).toEqual([]);
    expect(fixture.catalog.find('quiet')).toBeUndefined();
    await fixture.catalog.refresh();
    expect(fixture.catalog.find('quiet')).toBeDefined();
  });

  it('cancels its interval on close, closes twice, and reports nothing later', async () => {
    const context = await startPolling();
    let calls = 0;
    context.fixture.catalog.onChange(() => {
      calls += 1;
    });
    expect(context.runtime.pendingTimers()).toHaveLength(1);
    await context.fixture.catalog.close();
    await context.fixture.catalog.close();
    expect(context.runtime.pendingTimers()).toEqual([]);
    await context.fixture.put('late.json', workflowFileText('late'));
    await context.runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS * 3);
    await quietFor(20);
    expect(calls).toBe(0);
    expect(context.watcherCalls).toEqual([]);
  });
});
