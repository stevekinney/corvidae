/**
 * COR-1524 — adding, editing, and deleting an agent file takes effect without a restart. These
 * tests change real files in a real directory and wait for the catalog's own change event, so a
 * change the watcher misses fails by the test's timeout instead of passing on a sleep.
 */
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import type { AgentCatalogChange } from './agent-file-catalog';
import { DIRECTORY_POLL_INTERVAL_MILLISECONDS } from './sources/watched-directory';
import { nodeAgentFileOperations } from './sources/agent-file-operations';
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

/**
 * Writes `text` to a temporary file the directory ignores and renames it over `name`, so a scan
 * reads the file as it was before or as `text`, never between the two. `fixture.put` writes in
 * place, which a watcher scan can read after the file is created and before its bytes land.
 */
async function publish(fixture: AgentFileFixture, name: string, text: string): Promise<void> {
  const temporary = join(fixture.directory, `.${name}.tmp`);
  await writeFile(temporary, text);
  await rename(temporary, join(fixture.directory, name));
}

describe('watching the agent directory', () => {
  it('picks up an added file', async () => {
    const fixture = await start();
    const changed = fixture.nextChange((change) => change.added.includes('late'));
    await publish(fixture, 'late.md', validAgentFile());
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
    await publish(fixture, 'one.md', agentFileText({ model: 'anthropic/none' }));
    await broken;
    expect(fixture.catalog.list()[0]?.state).toBe('invalid');
    const repaired = fixture.nextChange((change) => change.changed.includes('one'));
    await publish(fixture, 'one.md', validAgentFile());
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
    await publish(fixture, 'two.md', validAgentFile());
    await added;
    expect(fixture.catalog.find('two')).toBeDefined();
  });

  it('picks up an agent file when the directory did not exist at start', async () => {
    const fixture = await start({ subdirectory: 'agents' });
    expect(fixture.catalog.list()).toEqual([]);
    const added = fixture.nextChange((change) => change.added.includes('first'));
    await mkdir(fixture.directory);
    await publish(fixture, 'first.md', validAgentFile());
    await added;
    expect(fixture.catalog.find('first')).toBeDefined();
  });

  it('reports each change once and stays silent when nothing changed', async () => {
    const fixture = await start();
    const changes: string[][] = [];
    fixture.catalog.onChange((change) => changes.push([...change.added]));
    // Published whole, so no scan can read it half written: COR-2374, where a watcher scan on Linux
    // read `one.md` between its creation and its bytes and rightly reported it twice (the next test).
    await publish(fixture, 'one.md', validAgentFile());
    await fixture.catalog.refresh();
    await fixture.catalog.refresh();
    expect(changes).toEqual([['one']]);
  });

  it('reports a file read half written as invalid, then as changed once it is whole', async () => {
    const fixture = await start();
    const changes: { added: string[]; changed: string[]; state: string | undefined }[] = [];
    fixture.catalog.onChange((change) =>
      changes.push({
        added: [...change.added],
        changed: [...change.changed],
        state: fixture.catalog.list()[0]?.state,
      }),
    );
    const whole = validAgentFile();
    await publish(fixture, 'one.md', whole.slice(0, Math.floor(whole.length / 2)));
    await fixture.catalog.refresh();
    await publish(fixture, 'one.md', whole);
    await fixture.catalog.refresh();
    await fixture.catalog.refresh();
    expect(changes).toEqual([
      { added: ['one'], changed: [], state: 'invalid' },
      { added: [], changed: ['one'], state: 'ready' },
    ]);
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

/**
 * COR-2291 — `watch: 'poll'` opens no native watcher: the directory's own once-a-second rescan is
 * the only thing that looks, and it lists the real directory. Every row changes real files, calls
 * nothing but the manual clock, and waits for the catalog's own change event.
 */
describe("the polling-only watch (watch: 'poll')", () => {
  /** A watcher factory that records its calls and opens nothing: a poll-mode source must not call it. */
  function countedWatcherFactory() {
    const calls: string[] = [];
    const openWatcher = (path: string): never => {
      calls.push(path);
      throw new Error(`A native watcher was opened for ${path}.`);
    };
    return { calls, openWatcher };
  }

  async function startPolling(options?: Parameters<typeof createAgentFileFixture>[0]) {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const watchers = countedWatcherFactory();
    const diagnoses: string[] = [];
    const fixture = await start({
      runtime,
      watch: 'poll',
      openWatcher: watchers.openWatcher,
      diagnose: (message) => diagnoses.push(message),
      ...options,
    });
    return { fixture, runtime, watchers, diagnoses };
  }

  /** Make `act` real changes, then let one interval pass and wait for the change that satisfies `predicate`. */
  async function afterInterval(
    context: Awaited<ReturnType<typeof startPolling>>,
    predicate: Parameters<AgentFileFixture['nextChange']>[0],
    act: () => Promise<void>,
  ): Promise<void> {
    const changed = context.fixture.nextChange(predicate);
    await act();
    await context.runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await changed;
  }

  const rows: ReadonlyArray<{
    readonly name: string;
    readonly arrange?: (fixture: AgentFileFixture) => Promise<void>;
    readonly act: (fixture: AgentFileFixture) => Promise<void>;
    readonly expected: (change: AgentCatalogChange) => boolean;
    readonly afterwards: (fixture: AgentFileFixture) => void;
  }> = [
    {
      name: 'an added file',
      act: (fixture) => fixture.put('late.md', validAgentFile()),
      expected: (change) => change.added.includes('late'),
      afterwards: (fixture) => expect(fixture.catalog.find('late')).toBeDefined(),
    },
    {
      name: 'an edit in place',
      arrange: (fixture) => fixture.put('one.md', validAgentFile('First.\n')),
      act: (fixture) => fixture.put('one.md', validAgentFile('Second.\n')),
      expected: (change) => change.changed.includes('one'),
      afterwards: (fixture) => expect(fixture.catalog.find('one')).toBeDefined(),
    },
    {
      name: 'a file renamed into place over the old one',
      arrange: (fixture) => fixture.put('one.md', validAgentFile('First.\n')),
      act: async (fixture) => {
        await writeFile(join(fixture.directory, '.one.tmp'), validAgentFile('Renamed in.\n'));
        await rename(join(fixture.directory, '.one.tmp'), join(fixture.directory, 'one.md'));
      },
      expected: (change) => change.changed.includes('one'),
      afterwards: (fixture) => expect(fixture.catalog.find('one')).toBeDefined(),
    },
    {
      name: 'a file renamed to another name',
      arrange: (fixture) => fixture.put('one.md', validAgentFile()),
      act: (fixture) =>
        rename(join(fixture.directory, 'one.md'), join(fixture.directory, 'two.md')),
      expected: (change) => change.added.includes('two') && change.removed.includes('one'),
      afterwards: (fixture) => {
        expect(fixture.catalog.find('one')).toBeUndefined();
        expect(fixture.catalog.find('two')).toBeDefined();
      },
    },
    {
      name: 'a removed file',
      arrange: (fixture) => fixture.put('one.md', validAgentFile()),
      act: (fixture) => rm(join(fixture.directory, 'one.md')),
      expected: (change) => change.removed.includes('one'),
      afterwards: (fixture) => expect(fixture.catalog.list()).toEqual([]),
    },
    {
      name: 'the directory itself deleted',
      arrange: (fixture) => fixture.put('one.md', validAgentFile()),
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
      expect(context.watchers.calls).toEqual([]);
      expect(context.diagnoses).toEqual([]);
    });
  }

  it('finds the directory created again, and a file in it', async () => {
    const context = await startPolling();
    await afterInterval(
      context,
      (change) => change.added.includes('one'),
      () => context.fixture.put('one.md', validAgentFile()),
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
        await context.fixture.put('two.md', validAgentFile());
      },
    );
    expect(context.fixture.catalog.find('two')).toBeDefined();
    expect(context.watchers.calls).toEqual([]);
  });

  it('keeps exactly one timer, the existing interval, armed while it watches', async () => {
    const context = await startPolling();
    expect(context.runtime.pendingTimers()).toHaveLength(1);
    await context.runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS * 3);
    expect(context.runtime.pendingTimers()).toHaveLength(1);
  });

  it('reports a scan that throws the way the safety rescan does, and finds the change once it works', async () => {
    let failing = false;
    const failure = new Error('the directory could not be listed');
    const operations = {
      ...nodeAgentFileOperations,
      listDirectory: (directory: string) => {
        if (failing) return Promise.reject(failure);
        return nodeAgentFileOperations.listDirectory(directory);
      },
    };
    const context = await startPolling({ operations });
    failing = true;
    const before = context.diagnoses.length;
    await context.runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await waitUntil(() => context.diagnoses.length > before, { message: 'the scan failure' });
    expect(context.diagnoses.at(-1)).toBe('The agent directory could not be scanned.');
    failing = false;
    await afterInterval(
      context,
      (change) => change.added.includes('after'),
      () => context.fixture.put('after.md', validAgentFile()),
    );
    expect(context.fixture.catalog.find('after')).toBeDefined();
  });

  it('finds nothing without a watcher or a timer under watch: false, until a scan is asked for', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const watchers = countedWatcherFactory();
    const fixture = await start({ runtime, watch: false, openWatcher: watchers.openWatcher });
    await fixture.put('quiet.md', validAgentFile());
    await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS * 3);
    expect(runtime.pendingTimers()).toEqual([]);
    expect(watchers.calls).toEqual([]);
    expect(fixture.catalog.find('quiet')).toBeUndefined();
    await fixture.catalog.refresh();
    expect(fixture.catalog.find('quiet')).toBeDefined();
  });

  it('closes twice without error, leaving no timer armed', async () => {
    const context = await startPolling();
    await context.fixture.catalog.close();
    await context.fixture.catalog.close();
    expect(context.runtime.pendingTimers()).toEqual([]);
    expect(context.watchers.calls).toEqual([]);
  });
});
