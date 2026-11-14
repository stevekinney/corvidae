/**
 * COR-1524 — the catalog's own lifecycle: `close()` leaves no watcher open however it lands,
 * `refresh()` never returns before a scan that began after the call, the watcher reports a change
 * without the safety rescan, and a write whose model cannot be set up is refused.
 */
import { watch, type FSWatcher } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { awakeTurns, quietFor } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import { type BackendDescriptor } from '@lostgradient/operative';

import { AgentFileError, AgentSnapshotError } from './agent-file';
import { readFileAgentBinding } from './agent-file-catalog';
import { createFileAgentRuntime } from './agent-file-runtime';
import { createAgentSnapshotStore } from './agent-snapshot-store';
import { DIRECTORY_POLL_INTERVAL_MILLISECONDS } from './sources/watched-directory';
import { type AgentFileOperations, nodeAgentFileOperations } from './sources/agent-file-operations';
import {
  agentFileText,
  type AgentFileFixture,
  createAgentFileFixture,
  KNOWN_MODEL,
  OTHER_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';
import { createVendorCatalog } from './testing/vendor-catalog.test-support';

const fixtures: AgentFileFixture[] = [];

async function start(options?: Parameters<typeof createAgentFileFixture>[0]) {
  const fixture = await createAgentFileFixture(options);
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

/** The watchers a catalog opened, and whether each has been closed. */
function observedWatchers() {
  const opened: Array<{ path: string; closed: boolean }> = [];
  const openWatcher = (
    path: string,
    listener: (event: string, filename: string | null) => void,
  ): FSWatcher => {
    const watcher = watch(path, { persistent: false }, listener);
    const record = { path, closed: false };
    opened.push(record);
    const close = watcher.close.bind(watcher);
    watcher.close = () => {
      record.closed = true;
      close();
    };
    return watcher;
  };
  return { opened, openWatcher };
}

describe('close()', () => {
  it('leaves no watcher open when it lands while a scan is setting watchers up', async () => {
    const { opened, openWatcher } = observedWatchers();
    const gate = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    let blocked = false;
    const operations: AgentFileOperations = {
      ...nodeAgentFileOperations,
      size: async (path) => {
        if (!blocked) {
          blocked = true;
          reached.resolve();
          await gate.promise;
        }
        return nodeAgentFileOperations.size(path);
      },
    };
    const fixture = await start({ operations, openWatcher });
    const refreshing = fixture.catalog.refresh();
    await reached.promise;
    const closing = fixture.catalog.close();
    gate.resolve();
    await closing;
    await refreshing;
    expect(opened.filter((record) => !record.closed)).toEqual([]);
  });

  it('leaves no watcher open after a plain close either', async () => {
    const { opened, openWatcher } = observedWatchers();
    const fixture = await start({ openWatcher });
    await fixture.catalog.refresh();
    expect(opened.length).toBeGreaterThan(0);
    await fixture.catalog.close();
    expect(opened.filter((record) => !record.closed)).toEqual([]);
  });
});

describe("close() under watch: 'poll' (COR-2291)", () => {
  /** A catalog over a manual clock whose directory listings can be held at a gate once `hold()` is called. */
  async function pollingCatalog() {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const reached = Promise.withResolvers<void>();
    const gate = Promise.withResolvers<void>();
    let listings = 0;
    let holding = false;
    const operations: AgentFileOperations = {
      ...nodeAgentFileOperations,
      listDirectory: async (directory) => {
        listings += 1;
        if (holding) {
          holding = false;
          reached.resolve();
          await gate.promise;
        }
        return nodeAgentFileOperations.listDirectory(directory);
      },
    };
    const openedWatchers: string[] = [];
    const fixture = await start({
      runtime,
      watch: 'poll',
      operations,
      openWatcher: (path) => {
        openedWatchers.push(path);
        return { on: () => undefined, close: () => undefined } as never;
      },
    });
    await fixture.catalog.refresh();
    return {
      fixture,
      runtime,
      reached: reached.promise,
      release: () => gate.resolve(),
      hold: () => {
        holding = true;
      },
      listings: () => listings,
      openedWatchers,
    };
  }

  it('cancels the interval and reports nothing later when no scan is in flight', async () => {
    const context = await pollingCatalog();
    let calls = 0;
    context.fixture.catalog.onChange(() => {
      calls += 1;
    });
    expect(context.runtime.pendingTimers()).toHaveLength(1);
    await context.fixture.catalog.close();
    expect(context.runtime.pendingTimers()).toEqual([]);
    const afterClose = context.listings();
    await context.fixture.put('late.md', validAgentFile());
    await context.runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS * 3);
    await quietFor(20);
    expect(context.listings()).toBe(afterClose);
    expect(calls).toBe(0);
    expect(context.openedWatchers).toEqual([]);
  });

  it('stays pending while a scan the interval began is in flight, then leaves nothing running', async () => {
    const context = await pollingCatalog();
    let calls = 0;
    context.fixture.catalog.onChange(() => {
      calls += 1;
    });
    context.hold();
    // The tick, not a `refresh()`, begins this scan: nothing but the directory's own loop is in it.
    await context.runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await context.reached;
    let closed = false;
    const closing = context.fixture.catalog.close().then(() => {
      closed = true;
    });
    // hang-guard-self-test: nothing but the held scan can settle the close, so any window shows it pending.
    await quietFor(20);
    expect(closed).toBe(false);
    expect(context.runtime.pendingTimers()).toEqual([]);
    context.release();
    await closing;
    expect(closed).toBe(true);
    const settledListings = context.listings();
    await context.fixture.put('late.md', validAgentFile());
    await context.runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS * 3);
    await quietFor(20);
    expect(context.listings()).toBe(settledListings);
    expect(calls).toBe(0);
    expect(context.openedWatchers).toEqual([]);
  });

  it('keeps a second close pending too while the scan is in flight, and settles both with it', async () => {
    const context = await pollingCatalog();
    context.hold();
    await context.runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await context.reached;
    const settled: string[] = [];
    const first = context.fixture.catalog.close().then(() => settled.push('first'));
    const second = context.fixture.catalog.close().then(() => settled.push('second'));
    // hang-guard-self-test: only the held scan can settle either close, so any window shows both pending.
    await quietFor(20);
    expect(settled).toEqual([]);
    context.release();
    await Promise.all([first, second]);
    expect(settled.toSorted()).toEqual(['first', 'second']);
    await context.fixture.catalog.close();
    expect(context.runtime.pendingTimers()).toEqual([]);
  });
});

describe('a watcher event that lands after close()', () => {
  it('starts no scan, even when the event was already queued', async () => {
    let deliver: ((event: string, filename: string | null) => void) | undefined;
    let listings = 0;
    const operations: AgentFileOperations = {
      ...nodeAgentFileOperations,
      listDirectory: (directory) => {
        listings += 1;
        return nodeAgentFileOperations.listDirectory(directory);
      },
    };
    const fixture = await start({
      operations,
      openWatcher: (path, listener) => {
        if (path === fixture.directory) deliver = listener;
        return { on: () => undefined, close: () => undefined } as never;
      },
    });
    await fixture.catalog.refresh();
    expect(deliver).toBeDefined();
    await fixture.catalog.close();
    const afterClose = listings;
    deliver?.('change', 'late.md');
    await quietFor(20);
    expect(listings).toBe(afterClose);
  });
});

/** A directory held in memory, so a test controls exactly when it changes. */
function memoryDirectory() {
  const files = new Map<string, Uint8Array>();
  const encoder = new TextEncoder();
  const operations: AgentFileOperations = {
    ...nodeAgentFileOperations,
    listDirectory: async () => [...files.keys()].map((name) => ({ name, isFile: true })),
    size: async (path) => files.get(path.slice(path.lastIndexOf('/') + 1))?.length ?? 0,
    read: async (path) => files.get(path.slice(path.lastIndexOf('/') + 1)),
  };
  return {
    files,
    operations,
    put: (name: string, text: string) => files.set(name, encoder.encode(text)),
  };
}

describe('refresh()', () => {
  it('never returns before a scan that began after the call has finished', async () => {
    const memory = memoryDirectory();
    memory.put('one.md', validAgentFile('Version start.\n'));
    const fixture = await start({ operations: memory.operations, watch: false });
    await fixture.catalog.refresh();
    // Every microtask offset at which a call can land relative to the loop winding down.
    for (let offset = 0; offset < 80; offset += 1) {
      const first = fixture.catalog.refresh();
      for (let turn = 0; turn < offset; turn += 1) await Promise.resolve();
      memory.put('one.md', validAgentFile(`Version ${offset}.\n`));
      await fixture.catalog.refresh();
      const agent = fixture.catalog.find('one');
      expect(
        readFileAgentBinding(agent as object)?.definition.instructions,
        `offset ${offset}`,
      ).toBe(`Version ${offset}.\n`);
      await first;
    }
  });
});

describe('the watcher', () => {
  it('reports a change without the safety rescan, which a manual clock cannot fire', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = await start({ runtime });
    await fixture.catalog.refresh();
    // `fs.watch` can drop an event, so a lost one is tolerated by touching the file again, never
    // by advancing the clock.
    let reported = false;
    void fixture
      .nextChange(
        (change) => change.added.includes('watched') || change.changed.includes('watched'),
      )
      .then(() => {
        reported = true;
      });
    for await (const attempt of awakeTurns()) {
      if (reported) break;
      // Renamed into place so no scan reads the file created and not yet written (COR-2374).
      const temporary = join(fixture.directory, '.watched.md.tmp');
      await writeFile(temporary, validAgentFile(`Attempt ${attempt}.\n`));
      await rename(temporary, join(fixture.directory, 'watched.md'));
    }
    expect(reported).toBe(true);
    expect(fixture.catalog.find('watched')).toBeDefined();
  });
});

describe('a write whose model cannot be set up', () => {
  const unresolvable = (descriptor: { model: string }) => {
    if (descriptor.model === 'claude-opus-5') throw new Error('no client for this provider');
    return async () => ({ content: 'scripted', toolCalls: [] });
  };

  it('is refused at create, with the typed error the invalid state uses, and writes nothing', async () => {
    const fixture = await start({ watch: false, resolveGenerate: unresolvable });
    let thrown: unknown;
    try {
      await fixture.catalog.create('lost', { model: OTHER_MODEL, instructions: 'Hi.\n' });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentFileError);
    expect(thrown).toMatchObject({ code: 'unknown-model' });
    expect(fixture.catalog.list()).toEqual([]);
    expect(await fixture.catalog.read('lost')).toBeUndefined();
  });

  it('is refused at update, and leaves the file as it was', async () => {
    const fixture = await start({ watch: false, resolveGenerate: unresolvable });
    await fixture.put('one.md', validAgentFile());
    const read = await fixture.catalog.read('one');
    let thrown: unknown;
    try {
      await fixture.catalog.update(
        'one',
        { model: OTHER_MODEL, instructions: 'Hi.\n' },
        { expectedHash: read?.hash ?? '' },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'unknown-model' });
    const unchanged = await fixture.catalog.read('one');
    expect(unchanged?.text).toBe(validAgentFile());
    expect(KNOWN_MODEL).toBeTruthy();
  });
});

describe('a run resumed from its snapshot after a model alias moved (COR-2152)', () => {
  const [first, second] = createVendorCatalog().descriptors.filter(
    (row) => row.provider === 'anthropic' && row.lifecycle !== 'retired',
  );
  const house = 'anthropic/house';
  /** The model catalog with the alias `house` pointing at `target`. */
  const catalogWith = (target: BackendDescriptor | undefined) =>
    createVendorCatalog().descriptors.map((row) => ({
      ...row,
      aliases: row.aliases.filter((alias) => alias.alias !== 'house'),
      ...(target !== undefined && row.model === target.model && row.provider === target.provider
        ? { aliases: [...row.aliases, { alias: 'house', resolvesTo: row.model }] }
        : {}),
    })) as BackendDescriptor[];
  const named = (row: BackendDescriptor | undefined) => `${row?.provider}/${row?.model}`;
  /** Starts a run on `house` while it names `first`, and returns the snapshot the store kept. */
  async function snapshotOfRunOnFirst() {
    const before = await start({ watch: false, descriptors: catalogWith(first) });
    await before.put('housed.md', agentFileText({ name: 'Housed', model: house }));
    await before.catalog.refresh();
    const binding = readFileAgentBinding(before.catalog.find('housed')!)!;
    const snapshots = createAgentSnapshotStore({ nowISO: () => '2026-11-13T00:00:00.000Z' });
    await snapshots.recordRun(binding, 'run-1');
    const snapshot = (await snapshots.load('housed', binding.hash))!;
    const reference = await snapshots.reference('run-1');
    return {
      directory: before.directory,
      binding,
      snapshots,
      snapshot,
      pin: reference?.resolvedModel,
    };
  }

  it("records the resolved model on the run's reference, beside the authored string", async () => {
    const { binding, snapshot, pin } = await snapshotOfRunOnFirst();
    expect(snapshot.definition.model).toBe(house);
    expect(pin).toBe(named(first));
    expect(binding.resolvedModel).toBe(named(first));
  });

  it('resumes on the pinned model, though the alias now names another', async () => {
    const { directory, snapshot, pin } = await snapshotOfRunOnFirst();
    const after = await start({ watch: false, directory, descriptors: catalogWith(second) });
    const rebuilt = after.catalog.agentFromSnapshot(snapshot, 1, pin);
    expect(readFileAgentBinding(rebuilt)?.resolvedModel).toBe(named(first));
    // The model the host was asked to call is the pinned one, not the alias's new target.
    expect(named(after.generated.at(-1))).toBe(named(first));
  });

  it('resumes a snapshot written before the pin by resolving the authored string today', async () => {
    const { directory, snapshot } = await snapshotOfRunOnFirst();
    const after = await start({ watch: false, directory, descriptors: catalogWith(second) });
    const rebuilt = after.catalog.agentFromSnapshot(snapshot, 1);
    expect(readFileAgentBinding(rebuilt)?.resolvedModel).toBe(named(second));
  });

  it('fails with snapshot-unresolvable, naming the pinned model, when its row is gone', async () => {
    const { directory, snapshot, pin } = await snapshotOfRunOnFirst();
    const without = catalogWith(second).filter((row) => row.model !== first?.model);
    const after = await start({ watch: false, directory, descriptors: without });
    let thrown: unknown;
    try {
      after.catalog.agentFromSnapshot(snapshot, 1, pin);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentSnapshotError);
    expect(thrown).toMatchObject({ code: 'snapshot-unresolvable' });
    expect((thrown as Error).message).toContain(named(first));
  });

  it('keeps each run on its own model when two runs of one unchanged file started on different ones', async () => {
    const { directory, binding, snapshots } = await snapshotOfRunOnFirst();
    // Run A is parked; the alias moves; run B of the same file starts on the new target.
    const after = await start({ watch: false, directory, descriptors: catalogWith(second) });
    await after.catalog.refresh();
    const bindingB = readFileAgentBinding(after.catalog.find('housed')!)!;
    expect(bindingB.hash).toBe(binding.hash);
    expect(bindingB.resolvedModel).toBe(named(second));
    await snapshots.recordRun(bindingB, 'run-2');
    const runtime = createFileAgentRuntime({
      files: after.catalog,
      snapshots,
      diagnose: (message, cause) => {
        throw new Error(`${message} ${String(cause)}`);
      },
    });
    const resumedA = await runtime.agentForRecordedRun('housed', binding.hash, 1, 'run-1');
    const resumedB = await runtime.agentForRecordedRun('housed', binding.hash, 1, 'run-2');
    expect(resumedA.binding.resolvedModel).toBe(named(first));
    expect(resumedB.binding.resolvedModel).toBe(named(second));
  });
});
