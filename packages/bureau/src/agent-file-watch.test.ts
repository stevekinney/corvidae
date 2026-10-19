/**
 * COR-1524 — adding, editing, and deleting an agent file takes effect without a restart. These
 * tests change real files in a real directory and wait for the catalog's own change event, so a
 * change the watcher misses fails by the test's timeout instead of passing on a sleep.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { afterEach, describe, expect, it } from 'bun:test';

import { DIRECTORY_POLL_INTERVAL_MILLISECONDS } from './watched-directory';
import { nodeAgentFileOperations } from './agent-file-operations';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];

async function start(options?: Parameters<typeof createAgentFileFixture>[0]) {
  const fixture = await createAgentFileFixture(options);
  fixtures.push(fixture);
  await fixture.catalog.refresh();
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe('watching the agent directory', () => {
  it('picks up an added file', async () => {
    const fixture = await start();
    const changed = fixture.nextChange((change) => change.added.includes('late'));
    await fixture.put('late.md', validAgentFile());
    await changed;
    expect(fixture.catalog.find('late')).toBeDefined();
  });

  it('picks up an edit in place', async () => {
    const fixture = await start();
    await fixture.put('one.md', validAgentFile('First.\n'));
    await fixture.catalog.refresh();
    const before = fixture.catalog.list()[0]?.definitionHash;
    const changed = fixture.nextChange((change) => change.changed.includes('one'));
    await fixture.put('one.md', validAgentFile('Second.\n'));
    await changed;
    expect(fixture.catalog.list()[0]?.definitionHash).not.toBe(before);
  });

  it('picks up an edit made by renaming a new file over the old one', async () => {
    const fixture = await start();
    await fixture.put('one.md', validAgentFile('First.\n'));
    await fixture.catalog.refresh();
    const changed = fixture.nextChange((change) => change.changed.includes('one'));
    await writeFile(join(fixture.directory, '.one.tmp'), validAgentFile('Renamed in.\n'));
    await rename(join(fixture.directory, '.one.tmp'), join(fixture.directory, 'one.md'));
    await changed;
    const hash = fixture.catalog.list()[0]?.definitionHash;
    expect(hash).toBeDefined();
  });

  it('picks up a deleted file, and a file turning invalid and valid again', async () => {
    const fixture = await start();
    await fixture.put('one.md', validAgentFile());
    await fixture.catalog.refresh();
    const broken = fixture.nextChange((change) => change.changed.includes('one'));
    await fixture.put('one.md', agentFileText({ model: 'anthropic/none' }));
    await broken;
    expect(fixture.catalog.list()[0]?.state).toBe('invalid');
    const repaired = fixture.nextChange((change) => change.changed.includes('one'));
    await fixture.put('one.md', validAgentFile());
    await repaired;
    expect(fixture.catalog.list()[0]?.state).toBe('ready');
    const removed = fixture.nextChange((change) => change.removed.includes('one'));
    await rm(join(fixture.directory, 'one.md'));
    await removed;
    expect(fixture.catalog.list()).toEqual([]);
    expect(fixture.catalog.find('one')).toBeUndefined();
  });

  it('survives its directory being deleted and created again', async () => {
    const fixture = await start();
    await fixture.put('one.md', validAgentFile());
    await fixture.catalog.refresh();
    const removed = fixture.nextChange((change) => change.removed.includes('one'));
    await rm(fixture.directory, { recursive: true });
    await removed;
    expect(fixture.catalog.list()).toEqual([]);
    const added = fixture.nextChange((change) => change.added.includes('two'));
    await mkdir(fixture.directory);
    await fixture.put('two.md', validAgentFile());
    await added;
    expect(fixture.catalog.find('two')).toBeDefined();
  });

  it('picks up an agent file when the directory did not exist at start', async () => {
    const fixture = await start({ subdirectory: 'agents' });
    expect(fixture.catalog.list()).toEqual([]);
    const added = fixture.nextChange((change) => change.added.includes('first'));
    await mkdir(fixture.directory);
    await fixture.put('first.md', validAgentFile());
    await added;
    expect(fixture.catalog.find('first')).toBeDefined();
  });

  it('reports each change once and stays silent when nothing changed', async () => {
    const fixture = await start();
    const changes: string[][] = [];
    fixture.catalog.onChange((change) => changes.push([...change.added]));
    await fixture.put('one.md', validAgentFile());
    await fixture.catalog.refresh();
    await fixture.catalog.refresh();
    expect(changes).toEqual([['one']]);
  });

  it('converges on the final state of a burst of changes', async () => {
    const fixture = await start();
    for (let index = 0; index < 20; index += 1) {
      await fixture.put('burst.md', validAgentFile(`Draft ${index}.\n`));
    }
    await fixture.catalog.refresh();
    const agent = fixture.catalog.find('burst');
    expect(agent).toBeDefined();
    const final = await fixture.catalog.read('burst');
    expect(final?.text).toContain('Draft 19.');
  });

  it('stops reporting once closed', async () => {
    const fixture = await start();
    let calls = 0;
    fixture.catalog.onChange(() => {
      calls += 1;
    });
    await fixture.catalog.close();
    await fixture.put('after.md', validAgentFile());
    await fixture.catalog.refresh();
    expect(calls).toBe(0);
    expect(KNOWN_MODEL).toBeTruthy();
  });
});

describe('the safety rescan', () => {
  it('rescans the directory every interval, so a change the watcher dropped is still found', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    let listings = 0;
    const fixture = await start({
      runtime,
      operations: {
        ...nodeAgentFileOperations,
        listDirectory: (directory) => {
          listings += 1;
          return nodeAgentFileOperations.listDirectory(directory);
        },
      },
    });
    // Without the interval, `refresh()` alone is one scan. A tick that already started a scan
    // makes it two: the scan the tick began, and the one `refresh()` asks for behind it.
    const before = listings;
    await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await fixture.catalog.refresh();
    expect(listings - before).toBeGreaterThanOrEqual(2);

    // Stops with the catalog.
    await fixture.catalog.close();
    const afterClose = listings;
    await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS * 3);
    await fixture.catalog.refresh();
    expect(listings).toBe(afterClose);
  });
});
