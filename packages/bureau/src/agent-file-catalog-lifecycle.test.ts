/**
 * COR-1524 — the catalog's own lifecycle: `close()` leaves no watcher open however it lands,
 * `refresh()` never returns before a scan that began after the call, the watcher reports a change
 * without the safety rescan, and a write whose model cannot be set up is refused.
 */
import { watch, type FSWatcher } from 'node:fs';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { awakeTurns } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentFileError } from './agent-file';
import { readFileAgentBinding } from './agent-file-catalog';
import { type AgentFileOperations, nodeAgentFileOperations } from './sources/agent-file-operations';
import {
  type AgentFileFixture,
  createAgentFileFixture,
  KNOWN_MODEL,
  OTHER_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';

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
      .nextChange((change) => change.added.includes('watched') || change.changed.includes('watched'))
      .then(() => {
        reported = true;
      });
    for await (const attempt of awakeTurns()) {
      if (reported) break;
      await fixture.put('watched.md', validAgentFile(`Attempt ${attempt}.\n`));
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
