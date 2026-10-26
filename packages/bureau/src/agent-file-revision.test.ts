/**
 * COR-1584 — a file agent's `definitionRevision` rises every time its file's content changes. It is
 * kept in one conditional record per identifier (`bureau-agent-revision:v1:<identifier>`), read
 * and raised by a pass that runs after each scan, before `refresh()` resolves and `onChange`
 * fires. These tests drive the catalog's scan directly (`watch: false`), so none waits on a clock.
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { readGenerationProfile } from '@lostgradient/operative';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import {
  type ConditionalTextValueStore,
  decode,
  MemoryStorage,
  resolveStorage,
  type Storage,
  textValueStore,
} from '@lostgradient/weft';
import { afterEach, describe, expect, it } from 'bun:test';

import { hashAgentFileBytes } from './agent-file';
import { AGENT_REVISION_KEY_PREFIX } from './agent-revision-store';
import { DIRECTORY_POLL_INTERVAL_MILLISECONDS } from './sources/watched-directory';
import { CATALOG_RUN_RECOVERY_KEY_PREFIX } from './runtime-composition';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';
import { startFileBureau } from './testing/agent-file-bureau.test-support';

const fixtures: AgentFileFixture[] = [];
const directories: string[] = [];

function newStore(): ConditionalTextValueStore {
  return textValueStore(new MemoryStorage());
}

async function start(options: Parameters<typeof createAgentFileFixture>[0] = {}) {
  const fixture = await createAgentFileFixture({ watch: false, ...options });
  fixtures.push(fixture);
  return fixture;
}

/** A directory several fixtures share, as a restart or a second process would. */
function sharedDirectory(): string {
  const directory = createTemporaryDirectory('bureau-agent-revision');
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const directory of directories.splice(0)) removeTemporaryPath(directory);
});

const versionOne = validAgentFile('Version one.\n');
const versionTwo = validAgentFile('Version two.\n');

/** The revision the listing reports for `id`. */
function revisionOf(fixture: AgentFileFixture, id = 'helper'): number | undefined {
  return fixture.catalog.list().find((listing) => listing.id === id)?.definitionRevision;
}

/** The revision the agent object reports through the generation profile every reader uses. */
function profileRevisionOf(fixture: AgentFileFixture, id = 'helper'): number | undefined {
  const agent = fixture.catalog.find(id);
  return agent === undefined ? undefined : readGenerationProfile(agent).revision;
}

async function recordOf(store: ConditionalTextValueStore, id = 'helper') {
  const text = await store.get(`${AGENT_REVISION_KEY_PREFIX}${id}`);
  return text === null ? undefined : (JSON.parse(text) as { revision: number; hash: string });
}

/** The revision the record holds for `id`, or `undefined` when it holds none. */
async function recordedRevisionOf(store: ConditionalTextValueStore, id = 'helper') {
  const record = await recordOf(store, id);
  return record?.revision;
}

describe('the revision of a file agent', () => {
  it('is 1 on first sighting, raised by every edit, raised again when the content returns, and kept across a restart', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const first = await start({ directory, revisionStore });
    const seen: Array<number | undefined> = [];

    await first.put('helper.md', versionOne);
    await first.catalog.refresh();
    seen.push(revisionOf(first));
    await first.put('helper.md', versionTwo);
    await first.catalog.refresh();
    seen.push(revisionOf(first));
    await first.put('helper.md', versionOne);
    await first.catalog.refresh();
    seen.push(revisionOf(first));
    await first.dispose();
    fixtures.splice(fixtures.indexOf(first), 1);

    const restarted = await start({ directory, revisionStore });
    await restarted.catalog.refresh();
    seen.push(revisionOf(restarted));

    expect(seen).toEqual([1, 2, 3, 3]);
  });

  it('reads a store with no revision record as a first sighting, and writes revision 1 with the file’s hash', async () => {
    const revisionStore = newStore();
    const fixture = await start({ revisionStore });
    await fixture.put('helper.md', versionOne);
    expect(await recordOf(revisionStore)).toBeUndefined();

    await fixture.catalog.refresh();

    const hash = fixture.catalog.list()[0]?.definitionHash ?? '';
    expect(revisionOf(fixture)).toBe(1);
    expect(await recordOf(revisionStore)).toEqual({ revision: 1, hash });
  });

  it('is on the agent every reader reads: the generation profile reports the listing’s revision', async () => {
    const fixture = await start();
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    await fixture.put('helper.md', versionTwo);
    await fixture.catalog.refresh();

    expect(profileRevisionOf(fixture)).toBe(2);
    expect(revisionOf(fixture)).toBe(2);
  });

  it('is not reported for an invalid file', async () => {
    const fixture = await start();
    await fixture.put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await fixture.catalog.refresh();

    const [listing] = fixture.catalog.list();
    expect(listing).toMatchObject({ id: 'broken', state: 'invalid' });
    expect(listing && 'definitionRevision' in listing).toBe(false);
  });

  it('does not write a record for an invalid file', async () => {
    const revisionStore = newStore();
    const fixture = await start({ revisionStore });
    await fixture.put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await fixture.catalog.refresh();

    expect(await revisionStore.list(AGENT_REVISION_KEY_PREFIX)).toEqual([]);
  });

  it('rises when a file that was invalid becomes valid with new content', async () => {
    const fixture = await start();
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    await fixture.put('helper.md', agentFileText({ model: 'anthropic/none' }));
    await fixture.catalog.refresh();
    expect(revisionOf(fixture)).toBeUndefined();
    await fixture.put('helper.md', versionTwo);
    await fixture.catalog.refresh();

    expect(revisionOf(fixture)).toBe(2);
  });

  it('does not rise when only the model catalog changes', async () => {
    const revisionStore = newStore();
    const fixture = await start({ revisionStore });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    const before = await recordOf(revisionStore);

    fixture.models.replace(fixture.descriptors);
    await fixture.catalog.refresh();

    expect(revisionOf(fixture)).toBe(1);
    expect(profileRevisionOf(fixture)).toBe(1);
    expect(await recordOf(revisionStore)).toEqual(before);
  });

  it('rises when the file is published or withdrawn, because that rewrites the file', async () => {
    const fixture = await start();
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    const hash = fixture.catalog.list()[0]?.definitionHash ?? '';

    await fixture.catalog.publish('helper', { expectedHash: hash });
    expect(revisionOf(fixture)).toBe(2);
    const published = fixture.catalog.list()[0]?.definitionHash ?? '';
    await fixture.catalog.withdraw('helper', { expectedHash: published });
    expect(revisionOf(fixture)).toBe(3);
  });

  it('rises when an update through the catalog rewrites the file', async () => {
    const fixture = await start();
    await fixture.catalog.create('helper', {
      name: 'Helper',
      model: KNOWN_MODEL,
      instructions: 'First.\n',
    });
    expect(revisionOf(fixture)).toBe(1);
    const hash = fixture.catalog.list()[0]?.definitionHash ?? '';
    await fixture.catalog.update(
      'helper',
      { name: 'Helper', model: KNOWN_MODEL, instructions: 'Second.\n' },
      { expectedHash: hash },
    );

    expect(revisionOf(fixture)).toBe(2);
  });

  it('is settled before onChange fires: a listener already sees the raised revision', async () => {
    const revisionStore = newStore();
    const fixture = await start({ revisionStore });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    await fixture.put('helper.md', versionTwo);
    const observed: Array<number | undefined> = [];
    const settled = new Promise<void>((resolve) => {
      fixture.catalog.onChange(() => {
        observed.push(revisionOf(fixture));
        resolve();
      });
    });

    await fixture.catalog.refresh();
    await settled;

    expect(observed).toEqual([2]);
    expect(await recordedRevisionOf(revisionStore)).toBe(2);
  });

  it('is settled before refresh resolves: the record is written by then', async () => {
    const revisionStore = newStore();
    const fixture = await start({ revisionStore });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    await fixture.put('helper.md', versionTwo);
    await fixture.catalog.refresh();

    expect(await recordedRevisionOf(revisionStore)).toBe(2);
  });

  it('is served by detail for a file edited since the last scan as one settled entry: the new hash, text and revision', async () => {
    const revisionStore = newStore();
    const fixture = await start({ revisionStore });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    await fixture.put('helper.md', versionTwo);

    // No scan in between: `detail` itself settles the edit.
    const detail = await fixture.catalog.detail('helper');

    expect(detail).toMatchObject({
      id: 'helper',
      state: 'ready',
      definitionRevision: 2,
      definitionHash: hashAgentFileBytes(new TextEncoder().encode(versionTwo)),
      text: versionTwo,
    });
    expect(await recordedRevisionOf(revisionStore)).toBe(2);
    expect(revisionOf(fixture)).toBe(2);
  });

  it('is served by detail for an unchanged file without reading the record', async () => {
    const inner = newStore();
    let reads = 0;
    const store: ConditionalTextValueStore = {
      ...inner,
      async get(key) {
        if (key.startsWith(AGENT_REVISION_KEY_PREFIX)) reads += 1;
        return inner.get(key);
      },
    };
    const fixture = await start({ revisionStore: store });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    const before = reads;

    const detail = await fixture.catalog.detail('helper');

    expect(detail).toMatchObject({ definitionRevision: 1, text: versionOne });
    expect(reads).toBe(before);
  });

  it('is served by detail for a file edited into an invalid one with no revision', async () => {
    const fixture = await start();
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    await fixture.put('helper.md', agentFileText({ model: 'anthropic/none' }));

    const detail = await fixture.catalog.detail('helper');

    expect(detail).toMatchObject({ id: 'helper', state: 'invalid' });
    expect(detail && 'definitionRevision' in detail).toBe(false);
  });
});

describe('a deleted file', () => {
  it('leaves its revision record, so recreating the identifier continues from the last revision', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const fixture = await start({ directory, revisionStore });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    await fixture.put('helper.md', versionTwo);
    await fixture.catalog.refresh();
    const before = await recordOf(revisionStore);

    await rm(join(directory, 'helper.md'));
    await fixture.catalog.refresh();
    expect(fixture.catalog.list()).toEqual([]);
    expect(await recordOf(revisionStore)).toEqual(before);

    await fixture.put('helper.md', validAgentFile('Version three.\n'));
    await fixture.catalog.refresh();
    expect(revisionOf(fixture)).toBe(3);
  });

  it('continues from the last revision after a restart as well', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const first = await start({ directory, revisionStore });
    await first.put('helper.md', versionOne);
    await first.catalog.refresh();
    await first.put('helper.md', versionTwo);
    await first.catalog.refresh();
    await rm(join(directory, 'helper.md'));
    await first.catalog.refresh();
    await first.dispose();
    fixtures.splice(fixtures.indexOf(first), 1);

    const restarted = await start({ directory, revisionStore });
    await restarted.put('helper.md', validAgentFile('Version three.\n'));
    await restarted.catalog.refresh();

    expect(revisionOf(restarted)).toBe(3);
  });
});

describe('two catalogs on one store', () => {
  it('raise the record by exactly one when both see the same change, and both report it', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const left = await start({ directory, revisionStore });
    const right = await start({ directory, revisionStore });
    await left.put('helper.md', versionOne);
    await Promise.all([left.catalog.refresh(), right.catalog.refresh()]);
    expect([revisionOf(left), revisionOf(right)]).toEqual([1, 1]);

    await left.put('helper.md', versionTwo);
    await Promise.all([left.catalog.refresh(), right.catalog.refresh()]);

    expect([revisionOf(left), revisionOf(right)]).toEqual([2, 2]);
    expect([profileRevisionOf(left), profileRevisionOf(right)]).toEqual([2, 2]);
    expect(await recordedRevisionOf(revisionStore)).toBe(2);
  });

  it('agree on a first sighting of the same file', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const left = await start({ directory, revisionStore });
    const right = await start({ directory, revisionStore });
    await left.put('helper.md', versionOne);

    await Promise.all([left.catalog.refresh(), right.catalog.refresh()]);

    expect([revisionOf(left), revisionOf(right)]).toEqual([1, 1]);
    expect(await recordedRevisionOf(revisionStore)).toBe(1);
  });

  it('report the revision a second catalog finds already recorded, without raising it', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const left = await start({ directory, revisionStore });
    await left.put('helper.md', versionOne);
    await left.catalog.refresh();
    await left.put('helper.md', versionTwo);
    await left.catalog.refresh();

    const right = await start({ directory, revisionStore });
    await right.catalog.refresh();

    expect(revisionOf(right)).toBe(2);
    expect(await recordedRevisionOf(revisionStore)).toBe(2);
  });
});

describe('a catalog that missed an intermediate edit', () => {
  /**
   * Two catalogs on one store and one directory. `behind` has scanned version one; `ahead` then
   * sees version two and version one again, so the record holds revision 3 for the very content
   * `behind` already has.
   */
  async function missedAnEdit() {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const diagnostics: string[] = [];
    const diagnose = (message: string) => diagnostics.push(message);
    const behind = await start({ directory, revisionStore, diagnose });
    const ahead = await start({ directory, revisionStore, diagnose });
    await behind.put('helper.md', versionOne);
    await behind.catalog.refresh();
    await ahead.catalog.refresh();
    await ahead.put('helper.md', versionTwo);
    await ahead.catalog.refresh();
    await ahead.put('helper.md', versionOne);
    await ahead.catalog.refresh();
    expect(revisionOf(ahead)).toBe(3);
    expect(revisionOf(behind)).toBe(1);
    return { behind, ahead, revisionStore, diagnostics };
  }

  it('reports the record’s revision on its next scan, though the content is the one it already has', async () => {
    const { behind, revisionStore, diagnostics } = await missedAnEdit();

    await behind.catalog.refresh();

    expect(revisionOf(behind)).toBe(3);
    expect(profileRevisionOf(behind)).toBe(3);
    expect(await recordedRevisionOf(revisionStore)).toBe(3);
    expect(diagnostics).toEqual([]);
  });

  it('settles the record’s revision on a safety rescan, though no byte changed and no refresh() was asked for', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    // Polling is the only trigger: the watcher opens and never reports.
    const behind = await start({
      directory,
      revisionStore,
      runtime,
      watch: true,
      openWatcher: () => ({ on: () => undefined, close: () => undefined }) as never,
    });
    const ahead = await start({ directory, revisionStore });
    await behind.put('helper.md', versionOne);
    await behind.catalog.refresh();
    await ahead.catalog.refresh();
    await ahead.put('helper.md', versionTwo);
    await ahead.catalog.refresh();
    await ahead.put('helper.md', versionOne);
    await ahead.catalog.refresh();
    expect(revisionOf(behind)).toBe(1);
    const settled = behind.nextChange((change) => change.changed.includes('helper'));

    await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await settled;

    expect(revisionOf(behind)).toBe(3);
  });

  it('tells its listeners, because a revision-only change is a change', async () => {
    const { behind } = await missedAnEdit();
    const changes: string[][] = [];
    behind.catalog.onChange((change) => changes.push([...change.changed]));

    await behind.catalog.refresh();

    expect(changes).toEqual([['helper']]);
  });

  it('does not tell its listeners when a scan finds the revision where it was', async () => {
    const { ahead } = await missedAnEdit();
    const changes: string[][] = [];
    ahead.catalog.onChange((change) => changes.push([...change.changed]));

    await ahead.catalog.refresh();

    expect(changes).toEqual([]);
  });
});

describe('a scan that read the file just before a peer’s edit', () => {
  /**
   * `left` reads the file at version one, and its settle reaches the store only after `right`
   * recorded version two. `left` must not write a revert that never happened.
   */
  async function staleScan() {
    const directory = sharedDirectory();
    const shared = newStore();
    let gate: { reached: () => void; release: Promise<void> } | undefined;
    const leftStore: ConditionalTextValueStore = {
      ...shared,
      async get(key) {
        if (gate !== undefined && key.startsWith(AGENT_REVISION_KEY_PREFIX)) {
          const held = gate;
          gate = undefined;
          held.reached();
          await held.release;
        }
        return shared.get(key);
      },
    };
    const left = await start({ directory, revisionStore: leftStore });
    const right = await start({ directory, revisionStore: shared });
    await left.put('helper.md', versionOne);
    await Promise.all([left.catalog.refresh(), right.catalog.refresh()]);

    const release = Promise.withResolvers<void>();
    const reached = Promise.withResolvers<void>();
    gate = { reached: reached.resolve, release: release.promise };
    const leftScan = left.catalog.refresh();
    await reached.promise;
    await left.put('helper.md', versionTwo);
    await right.catalog.refresh();
    release.resolve();
    await leftScan;
    return { left, right, shared };
  }

  it('does not write a revert: one edit raises the record by one', async () => {
    const { left, right, shared } = await staleScan();

    expect(await recordedRevisionOf(shared)).toBe(2);
    await left.catalog.refresh();
    await right.catalog.refresh();

    expect(await recordedRevisionOf(shared)).toBe(2);
    expect([revisionOf(left), revisionOf(right)]).toEqual([2, 2]);
    expect([profileRevisionOf(left), profileRevisionOf(right)]).toEqual([2, 2]);
  });

  it('keeps its revision for that scan rather than listing one raised by the revert it did not write', async () => {
    const { left } = await staleScan();

    expect(revisionOf(left)).toBe(1);
  });

  it('still raises the revision for a revert both catalogs saw', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const left = await start({ directory, revisionStore });
    const right = await start({ directory, revisionStore });
    const seen: Array<[number | undefined, number | undefined]> = [];

    for (const text of [versionOne, versionTwo, versionOne]) {
      await left.put('helper.md', text);
      await Promise.all([left.catalog.refresh(), right.catalog.refresh()]);
      seen.push([revisionOf(left), revisionOf(right)]);
    }

    expect(seen).toEqual([
      [1, 1],
      [2, 2],
      [3, 3],
    ]);
    expect(await recordedRevisionOf(revisionStore)).toBe(3);
  });

  it('writes a revert a peer never saw one scan later, when the record still holds the other content', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const left = await start({ directory, revisionStore });
    const right = await start({ directory, revisionStore });
    await left.put('helper.md', versionOne);
    await Promise.all([left.catalog.refresh(), right.catalog.refresh()]);
    await left.put('helper.md', versionTwo);
    await right.catalog.refresh();
    expect(await recordedRevisionOf(revisionStore)).toBe(2);
    // The file goes back to version one before the left catalog scans, and the right one is gone.
    await left.put('helper.md', versionOne);

    await left.catalog.refresh();
    expect(revisionOf(left)).toBe(1);
    expect(await recordedRevisionOf(revisionStore)).toBe(2);
    await left.catalog.refresh();

    expect(revisionOf(left)).toBe(3);
    expect(await recordedRevisionOf(revisionStore)).toBe(3);
  });
});

describe('a catalog that has recorded nothing yet', () => {
  const hashOf = (text: string) => hashAgentFileBytes(new TextEncoder().encode(text));

  it('writes a change made while the Bureau was down on its first scan, so the revision names the new content', async () => {
    const directory = sharedDirectory();
    const revisionStore = newStore();
    const before = await start({ directory, revisionStore });
    await before.put('helper.md', versionOne);
    await before.catalog.refresh();
    await before.dispose();
    fixtures.splice(fixtures.indexOf(before), 1);
    const restarted = await start({ directory, revisionStore });
    await restarted.put('helper.md', versionTwo);

    await restarted.catalog.refresh();

    expect(revisionOf(restarted)).toBe(2);
    expect(await recordedRevisionOf(revisionStore)).toBe(2);
  });

  it('may count a peer’s edit twice when its first read of the file was stale, and never lowers the revision', async () => {
    const inner = newStore();
    const key = `${AGENT_REVISION_KEY_PREFIX}helper`;
    let peerWrote = false;
    // The peer saw version two and recorded it after this catalog read the file (version one) and
    // before this catalog's settle read the record.
    const store: ConditionalTextValueStore = {
      ...inner,
      async get(requested) {
        if (requested === key && !peerWrote) {
          peerWrote = true;
          await inner.set(key, JSON.stringify({ revision: 2, hash: hashOf(versionTwo) }));
        }
        return inner.get(requested);
      },
    };
    const fixture = await start({ revisionStore: store });
    await fixture.put('helper.md', versionOne);
    const listed: Array<number | undefined> = [];

    await fixture.catalog.refresh();
    listed.push(revisionOf(fixture));
    await fixture.put('helper.md', versionTwo);
    await fixture.catalog.refresh();
    listed.push(revisionOf(fixture));

    // Each revision names the content it was listed with, and none is lower than the record's 2.
    expect(listed).toEqual([3, 4]);
  });
});

describe('a Bureau restarted after an offline edit', () => {
  it('lists the new content at a new revision on its first refresh, and a run started then records it', async () => {
    const directory = createTemporaryDirectory('bureau-revision-offline-edit');
    directories.push(directory);
    const agents = createTemporaryDirectory('bureau-revision-offline-agents');
    directories.push(agents);
    const storagePath = join(directory, 'bureau.sqlite');
    const overrides = {
      durableExecution: true,
      durableOwnership: { ownership: 'none' as const },
      durableBackgroundTasks: 'manual' as const,
      onDiagnostic: () => undefined,
    };
    const recordOf = async (storage: Storage, runId: string) => {
      const bytes = await storage.get(`${CATALOG_RUN_RECOVERY_KEY_PREFIX}${runId}`);
      return bytes === null
        ? undefined
        : (decode(bytes) as { definitionRevision: number; agentDefinitionHash?: string });
    };
    const text = (instructions: string) => agentFileText({ model: KNOWN_MODEL }, instructions);

    const firstStorage = await resolveStorage({ type: 'sqlite', path: storagePath });
    const first = await startFileBureau({
      directory: agents,
      overrides: { ...overrides, storage: firstStorage },
    });
    await first.put('researcher.md', text('Before the restart.\n'));
    await first.bureau.agents.refresh();
    const before = first.bureau.run('researcher', 'hello');
    await before.result();
    const beforeRecord = await recordOf(firstStorage, before.id);
    await first.dispose();

    // Edited while the Bureau is down.
    await first.put('researcher.md', text('Edited while down.\n'));

    const secondStorage = await resolveStorage({ type: 'sqlite', path: storagePath });
    const second = await startFileBureau({
      directory: agents,
      overrides: { ...overrides, storage: secondStorage },
    });
    try {
      const listed = second.bureau.agents.list().find((entry) => entry.id === 'researcher');
      const after = second.bureau.run('researcher', 'hello again');
      await after.result();
      const afterRecord = await recordOf(secondStorage, after.id);

      expect(beforeRecord?.definitionRevision).toBe(1);
      expect(listed?.definitionRevision).toBe(2);
      expect(afterRecord?.definitionRevision).toBe(2);
      expect(afterRecord?.agentDefinitionHash).toBe(listed?.definitionHash);
      expect(afterRecord?.agentDefinitionHash).not.toBe(beforeRecord?.agentDefinitionHash);
    } finally {
      await second.dispose();
    }
  });
});

describe('a record that a third writer alternates between two hashes', () => {
  it('is deferred against once per hash, then written, not deferred on every alternation', async () => {
    const revisionStore = newStore();
    const fixture = await start({ revisionStore });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    const key = `${AGENT_REVISION_KEY_PREFIX}helper`;
    const hexOf = (character: string) => character.repeat(64);
    const listed: Array<number | undefined> = [];

    for (const [revision, hash] of [
      [5, hexOf('c')],
      [6, hexOf('d')],
      [7, hexOf('c')],
    ] as const) {
      await revisionStore.set(key, JSON.stringify({ revision, hash }));
      await fixture.catalog.refresh();
      listed.push(revisionOf(fixture));
    }

    // The first two records each buy one deferral, and the catalog keeps its revision. The third
    // is a record it has already deferred against, so it writes the file's own content over it.
    expect(listed).toEqual([1, 1, 8]);
    expect(await recordedRevisionOf(revisionStore)).toBe(8);
  });
});

describe('a revision record that cannot be read or written', () => {
  /** A store that fails the way `mode` says while `failing.value` is true. */
  function failingStore(mode: 'read' | 'write' | 'malformed') {
    const inner = newStore();
    const failing = { value: false };
    const store: ConditionalTextValueStore = {
      ...inner,
      async get(key) {
        if (failing.value && key.startsWith(AGENT_REVISION_KEY_PREFIX)) {
          if (mode === 'read') throw new Error('revision store unreadable');
          if (mode === 'malformed') return 'not a record';
        }
        return inner.get(key);
      },
      conditionalBatch(conditions, operations) {
        if (failing.value && mode === 'write') {
          return Promise.reject(new Error('revision store unwritable'));
        }
        return inner.conditionalBatch(conditions, operations);
      },
    };
    return { store, inner, failing };
  }

  it.each(['read', 'write', 'malformed'] as const)(
    'keeps the agent listed with revision 1 when none is known, and names it in a diagnostic (%s)',
    async (mode) => {
      const { store, failing } = failingStore(mode);
      failing.value = true;
      const diagnostics: Array<{ message: string; cause: unknown }> = [];
      const fixture = await start({
        revisionStore: store,
        diagnose: (message, cause) => diagnostics.push({ message, cause }),
      });
      await fixture.put('helper.md', versionOne);

      await fixture.catalog.refresh();

      expect(fixture.catalog.list()[0]).toMatchObject({ id: 'helper', state: 'ready' });
      expect(revisionOf(fixture)).toBe(1);
      expect(profileRevisionOf(fixture)).toBe(1);
      expect(diagnostics.map((entry) => entry.message)).toEqual([
        expect.stringContaining('"helper"'),
      ]);
      expect(diagnostics[0]?.cause).toBeInstanceOf(Error);
    },
  );

  it.each(['read', 'write', 'malformed'] as const)(
    'keeps the last known revision while it fails, and raises it once it recovers (%s)',
    async (mode) => {
      const { store, inner, failing } = failingStore(mode);
      const diagnostics: string[] = [];
      const fixture = await start({
        revisionStore: store,
        diagnose: (message) => diagnostics.push(message),
      });
      await fixture.put('helper.md', versionOne);
      await fixture.catalog.refresh();
      await fixture.put('helper.md', versionTwo);
      await fixture.catalog.refresh();
      expect(revisionOf(fixture)).toBe(2);

      failing.value = true;
      await fixture.put('helper.md', validAgentFile('Version three.\n'));
      await fixture.catalog.refresh();
      expect(fixture.catalog.list()[0]).toMatchObject({ id: 'helper', state: 'ready' });
      expect(revisionOf(fixture)).toBe(2);
      expect(profileRevisionOf(fixture)).toBe(2);
      expect(diagnostics).toHaveLength(1);

      failing.value = false;
      await fixture.catalog.refresh();
      expect(revisionOf(fixture)).toBe(3);
      expect(profileRevisionOf(fixture)).toBe(3);
      expect(await recordedRevisionOf(inner)).toBe(3);
      expect(diagnostics).toHaveLength(1);
    },
  );

  it.each(['read', 'write', 'malformed'] as const)(
    'reports a store that stays down once per file, not once per scan (%s)',
    async (mode) => {
      const { store, failing } = failingStore(mode);
      failing.value = true;
      const diagnostics: string[] = [];
      const fixture = await start({
        revisionStore: store,
        diagnose: (message) => diagnostics.push(message),
      });
      await fixture.put('helper.md', versionOne);
      await fixture.put('other.md', versionTwo);

      await fixture.catalog.refresh();
      await fixture.catalog.refresh();
      await fixture.catalog.refresh();

      expect(diagnostics).toHaveLength(2);
      expect(diagnostics.some((message) => message.includes('"helper"'))).toBe(true);
      expect(diagnostics.some((message) => message.includes('"other"'))).toBe(true);
    },
  );

  it('reports again when the file changes while the store is still down', async () => {
    const { store, failing } = failingStore('read');
    failing.value = true;
    const diagnostics: string[] = [];
    const fixture = await start({
      revisionStore: store,
      diagnose: (message) => diagnostics.push(message),
    });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    await fixture.put('helper.md', versionTwo);
    await fixture.catalog.refresh();
    await fixture.catalog.refresh();

    expect(diagnostics).toHaveLength(2);
  });

  it('reports a new failure after the store recovered in between', async () => {
    const { store, failing } = failingStore('read');
    failing.value = true;
    const diagnostics: string[] = [];
    const fixture = await start({
      revisionStore: store,
      diagnose: (message) => diagnostics.push(message),
    });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();
    failing.value = false;
    await fixture.catalog.refresh();
    failing.value = true;
    await fixture.catalog.refresh();

    expect(diagnostics).toHaveLength(2);
  });

  it('never makes the agent invalid', async () => {
    const { store, failing } = failingStore('read');
    failing.value = true;
    const fixture = await start({ revisionStore: store, diagnose: () => undefined });
    await fixture.put('helper.md', versionOne);
    await fixture.catalog.refresh();

    expect(fixture.catalog.find('helper')).toBeDefined();
    expect(fixture.catalog.list()[0]?.state).toBe('ready');
    expect(fixture.catalog.list()[0]?.problem).toBeUndefined();
  });
});
