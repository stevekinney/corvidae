/**
 * COR-1527 — adding, editing, and deleting a workflow file takes effect without a restart, and a
 * change the watcher drops is found by the agent files' one-second backstop rescan. These tests
 * change real files in a real directory and wait for the catalog's own change event.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { afterEach, describe, expect, it } from 'bun:test';

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
