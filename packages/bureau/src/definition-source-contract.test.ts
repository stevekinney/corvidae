/**
 * COR-1702 — the contract every definition source keeps, run against an in-memory source, the
 * directory source, and (COR-1762) the S3 object source over an in-process S3 server. Bureau keeps parsing, validation, snapshots, revisions, publication, and the
 * write-through operations; a source only holds bytes, so the catalogs behave the same over any
 * source that keeps the contract. The outcome matrix at the end is the concurrency contract of
 * `write`, `delete`, and `watch`.
 */
import type { FSWatcher } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createS3TestServer } from '@lostgradient/testing/s3-server';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentFileConflictError } from './agent-file';
import { readFileAgentBinding } from './agent-file-catalog';
import type { AgentSnapshot } from './agent-snapshot-store';
import { agentFileDirectory } from './sources/agent-file-directory';
import { nodeAgentFileOperations } from './sources/agent-file-operations';
import { agentObjectSource } from './sources/agent-object-source';
import {
  type AgentSource,
  hashDefinitionBytes,
  SourceConflictError,
  type WorkflowSource,
} from './sources/definition-source';
import { createS3ObjectOperations, type ObjectStoreOperations } from './sources/object-operations';
import { workflowFileDirectory } from './sources/workflow-file-directory';
import { workflowObjectSource } from './sources/workflow-object-source';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
  lookupTool,
  OTHER_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';
import { createMemoryDefinitionSource } from './testing/memory-definition-source.test-support';
import {
  AGENT_STEP,
  createWorkflowFileFixture,
  FAST_SCHEDULE,
  type WorkflowFileFixture,
  workflowFileText,
} from './testing/workflow-file-fixtures.test-support';
import { WorkflowFileConflictError } from './workflow-file';

const encoder = new TextEncoder();
const hashOf = (text: string): string => hashDefinitionBytes(encoder.encode(text));

/** One source under test, driven from outside Bureau the way a person or another process would. */
interface Harness<TSource> {
  readonly source: TSource;
  /** Change a definition without going through Bureau, reporting nothing. */
  put(id: string, text: string): Promise<void>;
  remove(id: string): Promise<void>;
  text(id: string): Promise<string | undefined>;
  /** Every name the source holds, temporary files included. */
  names(): Promise<string[]>;
  /** Report an external change to the source's watchers, as its change notification would. */
  reportChange(id: string): Promise<void>;
  /** Land an external edit inside the next `write` of `id`, after its first check. */
  editDuringNextWrite(id: string, text: string): void;
  dispose(): Promise<void>;
}

type HarnessKind = 'agent' | 'workflow';
type SourceOf<K extends HarnessKind> = K extends 'agent' ? AgentSource : WorkflowSource;

const EXTENSIONS = { agent: '.md', workflow: '.json' } as const;

function memoryHarness<K extends HarnessKind>(kind: K): Harness<SourceOf<K>> {
  const memory = createMemoryDefinitionSource(kind, kind === 'agent' ? { tools: {} } : {});
  return {
    source: memory.source,
    put: async (id, text) => memory.set(id, text),
    remove: async (id) => memory.remove(id),
    text: async (id) => memory.text(id),
    names: async () => [...(await memory.source.load())].map((entry) => entry.id),
    reportChange: async (id) => memory.emit({ changed: [id] }),
    editDuringNextWrite: (id, text) => memory.beforeCommit(() => memory.set(id, text)),
    dispose: async () => undefined,
  };
}

async function directoryHarness<K extends HarnessKind>(kind: K): Promise<Harness<SourceOf<K>>> {
  const root = await mkdtemp(join(tmpdir(), 'bureau-source-contract-'));
  const extension = EXTENSIONS[kind];
  const pathOf = (id: string): string => join(root, `${id}${extension}`);
  const listeners: Array<(event: string, filename: string | null) => void> = [];
  let armed: { readonly path: string; readonly text: string } | undefined;
  let readsSinceArmed = 0;
  const operations = {
    ...nodeAgentFileOperations,
    read: async (path: string) => {
      // The first read of the target is the write's own check; the second is its last check before
      // the rename, which is the one an edit landing between them has to be caught by.
      if (armed?.path === path && (readsSinceArmed += 1) === 2) {
        const { text } = armed;
        armed = undefined;
        await writeFile(path, text);
      }
      return nodeAgentFileOperations.read(path);
    },
  };
  const options = {
    operations,
    runtime: createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' }),
    diagnose: (message: string, cause: unknown): never => {
      throw new Error(`${message} ${String(cause)}`);
    },
    // A watcher that opens, and is told about changes by the test: no real file-system events.
    watchFactory: (_path: string, listener: (event: string, filename: string | null) => void) => {
      listeners.push(listener);
      return { on: () => undefined, close: () => undefined } as unknown as FSWatcher;
    },
  };
  const source =
    kind === 'agent'
      ? agentFileDirectory(root, { ...options, tools: { 'lookup-order': lookupTool } })
      : workflowFileDirectory(root, options);
  return {
    source: source as SourceOf<K>,
    put: (id, text) => writeFile(pathOf(id), text),
    remove: (id) => rm(pathOf(id), { force: true }),
    text: async (id) => readFile(pathOf(id), 'utf8').catch(() => undefined),
    names: () => readdir(root),
    reportChange: async (id) => {
      for (const listener of listeners) listener('change', `${id}${extension}`);
    },
    editDuringNextWrite: (id, text) => {
      armed = { path: pathOf(id), text };
      readsSinceArmed = 0;
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}

/** The poll interval the S3 harness uses, so `reportChange` advances the manual runtime by one tick. */
const OBJECT_POLL_MILLISECONDS = 50;

async function objectHarness<K extends HarnessKind>(kind: K): Promise<Harness<SourceOf<K>>> {
  const server = createS3TestServer();
  const client = new Bun.S3Client(server.clientOptions());
  const prefix = 'definitions/';
  const extension = EXTENSIONS[kind];
  const keyOf = (id: string): string => `${prefix}${id}${extension}`;
  const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
  const real = createS3ObjectOperations(client, server.bucket, 'text/plain');
  let armed: { readonly key: string; readonly text: string } | undefined;
  const operations: ObjectStoreOperations = {
    ...real,
    // The edit lands inside the conditional PUT: after the write's read and hash check, before the
    // request reaches the store.
    put: (key, bytes, condition) => {
      if (armed?.key === key) {
        const { text } = armed;
        armed = undefined;
        server.put(key, text);
      }
      return real.put(key, bytes, condition);
    },
  };
  const options = {
    client,
    operations,
    runtime,
    pollIntervalMilliseconds: OBJECT_POLL_MILLISECONDS,
    diagnose: (message: string, cause: unknown): never => {
      throw new Error(`${message} ${String(cause)}`);
    },
  };
  const location = { bucket: server.bucket, prefix };
  const source =
    kind === 'agent'
      ? agentObjectSource(location, { ...options, tools: { 'lookup-order': lookupTool } })
      : workflowObjectSource(location, options);
  const decoder = new TextDecoder();
  return {
    source: source as SourceOf<K>,
    put: async (id, text) => {
      server.put(keyOf(id), text);
    },
    remove: (id) => client.delete(keyOf(id)),
    text: async (id) => {
      const bytes = server.objects().get(keyOf(id));
      return bytes === undefined ? undefined : decoder.decode(bytes);
    },
    names: async () => [...server.objects().keys()],
    reportChange: async () => {
      // One poll tick, then a load, which queues behind the scan the tick started.
      await runtime.advance(OBJECT_POLL_MILLISECONDS);
      await source.load();
    },
    editDuringNextWrite: (id, text) => {
      armed = { key: keyOf(id), text };
    },
    dispose: async () => {
      await source.load().catch(() => undefined);
      await server.stop();
    },
  };
}

const SOURCES = [
  ['an in-memory source', <K extends HarnessKind>(kind: K) => Promise.resolve(memoryHarness(kind))],
  ['the directory source', directoryHarness],
  ['the S3 object source', objectHarness],
] as const;

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0).toReversed()) await dispose();
});

/** Resolves once `catalog` has told its listeners of a change, or never if it does not. */
function countChanges(catalog: { onChange: (listener: () => void) => () => void }): () => number {
  let count = 0;
  const stop = catalog.onChange(() => {
    count += 1;
  });
  disposers.push(async () => stop());
  return () => count;
}

describe.each(SOURCES)('agent files over %s', (_name, makeHarness) => {
  async function start(): Promise<{
    harness: Harness<AgentSource>;
    fixture: AgentFileFixture;
  }> {
    const harness = await makeHarness('agent');
    const fixture = await createAgentFileFixture({ source: harness.source });
    // Disposed in reverse: the catalog closes before the store it scans goes away.
    disposers.push(harness.dispose, fixture.dispose);
    return { harness, fixture };
  }

  it('parses a ready file, and lists an invalid one with its typed problem', async () => {
    const { harness, fixture } = await start();
    await harness.put('helper', validAgentFile());
    await harness.put('plain', 'Just text.\n');
    await harness.put('lost', agentFileText({ name: 'Lost', model: 'nobody/nothing' }));
    await fixture.catalog.refresh();
    const listing = Object.fromEntries(fixture.catalog.list().map((entry) => [entry.id, entry]));
    expect(listing['helper']).toMatchObject({ state: 'ready', name: 'Helper' });
    expect(listing['plain']).toMatchObject({
      state: 'invalid',
      problem: { code: 'missing-frontmatter' },
    });
    expect(listing['lost']).toMatchObject({ state: 'invalid', problem: { code: 'unknown-model' } });
    expect(fixture.catalog.find('helper')).toBeDefined();
    expect(fixture.catalog.find('plain')).toBeUndefined();
  });

  it('raises the revision when the content changes and keeps it when it does not', async () => {
    const { harness, fixture } = await start();
    await harness.put('helper', validAgentFile('First.\n'));
    await fixture.catalog.refresh();
    expect(fixture.catalog.list()[0]?.definitionRevision).toBe(1);
    await fixture.catalog.refresh();
    expect(fixture.catalog.list()[0]?.definitionRevision).toBe(1);
    await harness.put('helper', validAgentFile('Second.\n'));
    await fixture.catalog.refresh();
    expect(fixture.catalog.list()[0]?.definitionRevision).toBe(2);
  });

  it('rebuilds an agent from a snapshot of what the source held', async () => {
    const { harness, fixture } = await start();
    await harness.put('helper', validAgentFile('Snapshot me.\n'));
    await fixture.catalog.refresh();
    const detail = await fixture.catalog.detail('helper');
    expect(detail?.definition).not.toBeNull();
    const snapshot: AgentSnapshot = {
      schemaVersion: 1,
      id: 'helper',
      hash: detail?.definitionHash ?? '',
      firstRunAt: '2026-10-18T00:00:00.000Z',
      lastRunAt: '2026-10-18T00:00:00.000Z',
      definition: detail!.definition!,
    };
    const rebuilt = fixture.catalog.agentFromSnapshot(snapshot, 1);
    expect(readFileAgentBinding(rebuilt as object)).toMatchObject({
      id: 'helper',
      hash: hashOf(validAgentFile('Snapshot me.\n')),
    });
  });

  it('opts into and out of A2A through the source, changing only the a2a key', async () => {
    const { harness, fixture } = await start();
    await harness.put('helper', validAgentFile());
    await fixture.catalog.refresh();
    const hash = hashOf(validAgentFile());
    const definition = { name: 'Helper', model: KNOWN_MODEL, instructions: 'You are helpful.\n' };
    const optedIn = await fixture.catalog.update(
      'helper',
      { ...definition, a2a: true },
      { expectedHash: hash },
    );
    expect(await harness.text('helper')).toBe(
      validAgentFile().replace(`model: ${KNOWN_MODEL}\n`, `model: ${KNOWN_MODEL}\na2a: true\n`),
    );
    expect(fixture.catalog.list()[0]).toMatchObject({ a2a: true });
    await fixture.catalog.update(
      'helper',
      { ...definition, a2a: false },
      { expectedHash: optedIn.hash },
    );
    expect(fixture.catalog.list()[0]).toMatchObject({ a2a: false });
  });

  it('reads a definition back as its exact text and hash, and finds nothing for a missing one', async () => {
    const { harness, fixture } = await start();
    await harness.put('helper', validAgentFile());
    expect(await fixture.catalog.read('helper')).toEqual({
      hash: hashOf(validAgentFile()),
      text: validAgentFile(),
    });
    expect(await fixture.catalog.read('missing')).toBeUndefined();
    expect(await fixture.catalog.detail('missing')).toBeUndefined();
  });

  it('picks up a change made outside Bureau on refresh, with nothing watching', async () => {
    const { harness, fixture } = await start();
    await fixture.catalog.refresh();
    expect(fixture.catalog.list()).toEqual([]);
    await harness.put('late', validAgentFile());
    await fixture.catalog.refresh();
    expect(fixture.catalog.list().map((entry) => entry.id)).toEqual(['late']);
    await harness.remove('late');
    await fixture.catalog.refresh();
    expect(fixture.catalog.list()).toEqual([]);
  });

  describe('the outcome matrix', () => {
    it('write with a matching expectedHash returns the entry and the catalog reflects it at once', async () => {
      const { harness, fixture } = await start();
      const created = await fixture.catalog.create('helper', {
        model: KNOWN_MODEL,
        instructions: 'One.\n',
      });
      // No refresh() and no watcher event: the write-through reload is what the listing shows.
      expect(fixture.catalog.list()[0]).toMatchObject({
        id: 'helper',
        definitionHash: created.hash,
      });
      const updated = await fixture.catalog.update(
        'helper',
        { model: OTHER_MODEL, instructions: 'Two.\n' },
        { expectedHash: created.hash },
      );
      expect(fixture.catalog.list()[0]).toMatchObject({ definitionHash: updated.hash });
      expect(hashOf((await harness.text('helper')) ?? '')).toBe(updated.hash);
      const entry = await harness.source.write('other', encoder.encode(validAgentFile()), {
        expectedHash: null,
      });
      expect(entry).toMatchObject({ id: 'other', hash: hashOf(validAgentFile()) });
      expect(entry.bytes).toEqual(encoder.encode(validAgentFile()));
    });

    it('write with a stale expectedHash throws SourceConflictError with both hashes and writes nothing', async () => {
      const { harness, fixture } = await start();
      await harness.put('helper', validAgentFile('Original.\n'));
      await fixture.catalog.refresh();
      const stale = hashOf('something it never held');
      const error = await harness.source
        .write('helper', encoder.encode(validAgentFile('Lost.\n')), { expectedHash: stale })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(SourceConflictError);
      expect(error).toMatchObject({
        id: 'helper',
        expectedHash: stale,
        actualHash: hashOf(validAgentFile('Original.\n')),
      });
      expect(await harness.text('helper')).toBe(validAgentFile('Original.\n'));
      // Through the catalog the same refusal is the typed conflict callers already handle.
      const refused = await fixture.catalog
        .update('helper', { model: OTHER_MODEL, instructions: '' }, { expectedHash: stale })
        .catch((thrown: unknown) => thrown);
      expect(refused).toBeInstanceOf(AgentFileConflictError);
      expect(refused).toMatchObject({
        code: 'agent-file-changed',
        currentHash: hashOf(validAgentFile('Original.\n')),
      });
    });

    it('write with expectedHash null for an existing id throws SourceConflictError', async () => {
      const { harness, fixture } = await start();
      await harness.put('helper', validAgentFile());
      const error = await harness.source
        .write('helper', encoder.encode(validAgentFile('Other.\n')), { expectedHash: null })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(SourceConflictError);
      expect(error).toMatchObject({
        expectedHash: null,
        actualHash: hashOf(validAgentFile()),
      });
      const refused = await fixture.catalog
        .create('helper', { model: KNOWN_MODEL, instructions: '' })
        .catch((thrown: unknown) => thrown);
      expect(refused).toMatchObject({ code: 'agent-file-exists' });
      expect(await harness.text('helper')).toBe(validAgentFile());
    });

    it('delete with a matching expectedHash removes the definition and updates the catalog', async () => {
      const { harness, fixture } = await start();
      const { hash } = await fixture.catalog.create('helper', {
        model: KNOWN_MODEL,
        instructions: '',
      });
      await fixture.catalog.delete('helper', { expectedHash: hash });
      expect(fixture.catalog.list()).toEqual([]);
      expect(await harness.text('helper')).toBeUndefined();
    });

    it('delete with a stale expectedHash throws SourceConflictError and removes nothing', async () => {
      const { harness, fixture } = await start();
      await harness.put('helper', validAgentFile());
      await fixture.catalog.refresh();
      const stale = hashOf('stale');
      const error = await harness.source
        .delete('helper', { expectedHash: stale })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(SourceConflictError);
      expect(error).toMatchObject({ expectedHash: stale, actualHash: hashOf(validAgentFile()) });
      expect(await harness.text('helper')).toBe(validAgentFile());
      expect(fixture.catalog.list()).toHaveLength(1);
    });

    it('an external change seen by watch is picked up by a rescan', async () => {
      const { harness, fixture } = await start();
      await fixture.catalog.refresh();
      const changed = fixture.nextChange((change) => change.added.includes('late'));
      await harness.put('late', validAgentFile());
      await harness.reportChange('late');
      const reported = await changed;
      expect(reported.added).toEqual(['late']);
      expect(fixture.catalog.find('late')).toBeDefined();
    });

    it('an external change during a Bureau write: one wins by hash, the other conflicts, the catalog agrees', async () => {
      const { harness, fixture } = await start();
      const { hash } = await fixture.catalog.create('helper', {
        model: KNOWN_MODEL,
        instructions: 'Original.\n',
      });
      const external = agentFileText({ name: 'Hand', model: KNOWN_MODEL }, 'By hand.\n');
      harness.editDuringNextWrite('helper', external);
      const error = await harness.source
        .write('helper', encoder.encode(validAgentFile('Bureau.\n')), { expectedHash: hash })
        .catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(SourceConflictError);
      expect(error).toMatchObject({ expectedHash: hash, actualHash: hashOf(external) });
      // The external edit won; nothing of the losing write is left behind.
      expect(await harness.text('helper')).toBe(external);
      await fixture.catalog.refresh();
      expect(fixture.catalog.list()[0]).toMatchObject({
        name: 'Hand',
        definitionHash: hashOf(external),
      });
      const names = await harness.names();
      expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });

    it('two writers racing on one hash: exactly one wins, the other conflicts, the catalog matches the winner', async () => {
      const { harness, fixture } = await start();
      const { hash } = await fixture.catalog.create('helper', {
        model: KNOWN_MODEL,
        instructions: 'Original.\n',
      });
      const settled = await Promise.allSettled([
        fixture.catalog.update(
          'helper',
          { model: KNOWN_MODEL, instructions: 'A.\n' },
          { expectedHash: hash },
        ),
        fixture.catalog.update(
          'helper',
          { model: OTHER_MODEL, instructions: 'B.\n' },
          { expectedHash: hash },
        ),
      ]);
      const winners = settled.filter((outcome) => outcome.status === 'fulfilled');
      const losers = settled.filter((outcome) => outcome.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect((losers[0] as PromiseRejectedResult).reason).toBeInstanceOf(AgentFileConflictError);
      const winner = (winners[0] as PromiseFulfilledResult<{ hash: string }>).value;
      expect(hashOf((await harness.text('helper')) ?? '')).toBe(winner.hash);
      expect(fixture.catalog.list()[0]).toMatchObject({ definitionHash: winner.hash });
    });

    it('a watch report of Bureau’s own write is a no-op', async () => {
      const { harness, fixture } = await start();
      const { hash } = await fixture.catalog.create('helper', {
        model: KNOWN_MODEL,
        instructions: 'One.\n',
      });
      const changes = countChanges(fixture.catalog);
      await fixture.catalog.update(
        'helper',
        { model: KNOWN_MODEL, instructions: 'Two.\n' },
        { expectedHash: hash },
      );
      expect(changes()).toBe(1);
      const listed = fixture.catalog.list();
      await harness.reportChange('helper');
      await fixture.catalog.refresh();
      await fixture.catalog.refresh();
      expect(changes()).toBe(1);
      expect(fixture.catalog.list()).toEqual(listed);
    });
  });
});

describe.each(SOURCES)('workflow files over %s', (_name, makeHarness) => {
  const definition = { agent: 'writer', trigger: FAST_SCHEDULE, steps: [AGENT_STEP] };

  async function start(): Promise<{
    harness: Harness<WorkflowSource>;
    fixture: WorkflowFileFixture;
  }> {
    const harness = await makeHarness('workflow');
    const fixture = await createWorkflowFileFixture({ source: harness.source });
    // Disposed in reverse: the catalog closes before the store it scans goes away.
    disposers.push(harness.dispose, fixture.dispose);
    return { harness, fixture };
  }

  it('parses a ready file and lists an invalid one with its typed problem', async () => {
    const { harness, fixture } = await start();
    await harness.put('digest', workflowFileText('digest'));
    await harness.put('broken', '{ not json');
    await fixture.catalog.refresh();
    const listing = Object.fromEntries(fixture.catalog.list().map((entry) => [entry.id, entry]));
    expect(listing['digest']).toMatchObject({ state: 'ready', triggerKind: 'schedule' });
    expect(listing['broken']).toMatchObject({ state: 'invalid' });
    expect(fixture.catalog.find('digest')).toBeDefined();
    expect(fixture.catalog.find('broken')).toBeUndefined();
  });

  it('writes through create, update, pause, and delete, each visible without a watcher', async () => {
    const { harness, fixture } = await start();
    const created = await fixture.catalog.create('digest', definition);
    expect(fixture.catalog.list()[0]).toMatchObject({ id: 'digest', hash: created.hash });
    const updated = await fixture.catalog.update(
      'digest',
      { ...definition, description: 'Daily.' },
      { expectedHash: created.hash },
    );
    expect(fixture.catalog.list()[0]).toMatchObject({ description: 'Daily.', hash: updated.hash });
    const paused = await fixture.catalog.setPaused('digest', true, { expectedHash: updated.hash });
    expect(fixture.catalog.list()[0]).toMatchObject({ paused: true });
    await fixture.catalog.delete('digest', { expectedHash: paused.hash });
    expect(fixture.catalog.list()).toEqual([]);
    expect(await harness.text('digest')).toBeUndefined();
  });

  it('refuses stale and duplicate writes with the typed conflict and writes nothing', async () => {
    const { harness, fixture } = await start();
    await harness.put('digest', workflowFileText('digest'));
    await fixture.catalog.refresh();
    const stale = hashOf('stale');
    const changed = await fixture.catalog
      .update('digest', definition, { expectedHash: stale })
      .catch((thrown: unknown) => thrown);
    expect(changed).toBeInstanceOf(WorkflowFileConflictError);
    expect(changed).toMatchObject({
      code: 'workflow-file-changed',
      currentHash: hashOf(workflowFileText('digest')),
    });
    const exists = await fixture.catalog
      .create('digest', definition)
      .catch((thrown: unknown) => thrown);
    expect(exists).toMatchObject({ code: 'workflow-file-exists' });
    const gone = await fixture.catalog
      .delete('absent', { expectedHash: stale })
      .catch((thrown: unknown) => thrown);
    expect(gone).toMatchObject({ code: 'workflow-file-not-found' });
    expect(await harness.text('digest')).toBe(workflowFileText('digest'));
  });

  it('picks up a change made outside Bureau on refresh, and on a watch report', async () => {
    const { harness, fixture } = await start();
    await fixture.catalog.refresh();
    await harness.put('digest', workflowFileText('digest'));
    await fixture.catalog.refresh();
    expect(fixture.catalog.find('digest')).toBeDefined();
    const changed = fixture.nextChange((change) => change.changed.includes('digest'));
    await harness.put('digest', workflowFileText('digest', { description: 'Edited.' }));
    await harness.reportChange('digest');
    await changed;
    expect(fixture.catalog.list()[0]).toMatchObject({ description: 'Edited.' });
  });
});

describe('the directory source with watch: false', () => {
  it('opens no fs.watch and starts no poll', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bureau-source-no-watch-'));
    disposers.push(() => rm(root, { recursive: true, force: true }));
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    let opened = 0;
    let listings = 0;
    const source = agentFileDirectory(root, {
      watch: false,
      runtime,
      watchFactory: () => {
        opened += 1;
        return { on: () => undefined, close: () => undefined } as unknown as FSWatcher;
      },
      operations: {
        ...nodeAgentFileOperations,
        listDirectory: (directory) => {
          listings += 1;
          return nodeAgentFileOperations.listDirectory(directory);
        },
      },
    });
    const stop = source.watch(() => undefined);
    await source.load();
    const afterLoad = listings;
    await runtime.advance(10_000);
    await source.load();
    expect(opened).toBe(0);
    // Only the second load scanned: no timer rescanned on its own.
    expect(listings - afterLoad).toBe(1);
    stop();
  });
});

describe('a write whose reload fails', () => {
  it('rejects saying the write is durable, and the catalog converges on its own', async () => {
    const memory = createMemoryDefinitionSource('workflow');
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = await createWorkflowFileFixture({
      source: memory.source,
      runtime,
      diagnose: () => undefined,
    });
    disposers.push(fixture.dispose);
    const definition = { agent: 'writer', trigger: FAST_SCHEDULE, steps: [AGENT_STEP] };
    const { hash } = await fixture.catalog.create('digest', definition);
    expect(fixture.catalog.list()[0]).toMatchObject({ paused: false });

    // The first load is the write's own read of the file; the second is the reload after it.
    memory.failNextLoad(new Error('store unavailable'), { skip: 1 });
    const failure = await fixture.catalog
      .setPaused('digest', true, { expectedHash: hash })
      .catch((thrown: unknown) => thrown);

    // The pause is in the source, and the caller is told so rather than shown a success.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('durable');
    expect(memory.text('digest')).toContain('"paused": true');
    expect(fixture.catalog.list()[0]).toMatchObject({ paused: false });

    const converged = fixture.nextChange((change) => change.changed.includes('digest'));
    await runtime.advance(60_000);
    await converged;
    expect(fixture.catalog.list()[0]).toMatchObject({ paused: true });
  });
});
