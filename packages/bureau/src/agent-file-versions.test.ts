/**
 * COR-1815 — a file agent's saved versions, through the catalog: every writer save and every
 * edit the watcher finds is exactly one version, a restore is itself a save, and a version
 * outlives the runs that used it. These tests drive the scan directly (`watch: false`).
 */
import {
  type ConditionalTextValueStore,
  MemoryStorage,
  textValueStore,
} from '@lostgradient/storage';
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import { AgentFileConflictError, AgentFileError } from './agent-file';
import { AGENT_REVISION_KEY_PREFIX } from './agent-revision-store';
import { AGENT_VERSION_KEY_PREFIX } from './agent-version-store';
import {
  type AgentFileFixture,
  createAgentFileFixture,
  agentFileText,
  KNOWN_MODEL,
  OTHER_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];
const directories: string[] = [];

async function start(options: Parameters<typeof createAgentFileFixture>[0] = {}) {
  const fixture = await createAgentFileFixture({ watch: false, ...options });
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
  for (const directory of directories.splice(0)) removeTemporaryPath(directory);
});

const ALICE = 'api-key:alice';

function hashOf(fixture: AgentFileFixture): string {
  return fixture.catalog.list().find((listing) => listing.id === 'helper')?.definitionHash ?? '';
}

/** A definition a caller writes: the fixture's agent with `instructions` and any other changes. */
function definition(instructions: string, more: Record<string, unknown> = {}) {
  return { name: 'Helper', model: KNOWN_MODEL, instructions, ...more };
}

/** Put the first version of `helper` into the directory and let the catalog see it. */
async function seeded(options: Parameters<typeof createAgentFileFixture>[0] = {}) {
  const fixture = await start(options);
  await fixture.put('helper.md', validAgentFile('Version one.\n'));
  await fixture.catalog.refresh();
  return fixture;
}

const revisionsOf = async (fixture: AgentFileFixture) => {
  const versions = await fixture.catalog.versions.list('helper');
  return versions.map((entry) => entry.revision);
};

describe('an edit the watcher finds', () => {
  it('is exactly one version with no saver, however many scans see it', async () => {
    const fixture = await seeded();
    await fixture.put('helper.md', validAgentFile('Version two.\n'));
    await fixture.catalog.refresh();
    await fixture.catalog.refresh();

    const versions = await fixture.catalog.versions.list('helper');
    expect(versions.map((entry) => [entry.revision, entry.savedBy])).toEqual([
      [2, null],
      [1, null],
    ]);
    expect(versions[0]).toMatchObject({
      hash: hashOf(fixture),
      owner: 'anonymous:local',
      changedKeys: ['instructions'],
    });
    expect(versions[0]?.definition.instructions).toBe('Version two.\n');
  });

  it('is one version across two catalogs on one store that both see the change', async () => {
    const directory = createTemporaryDirectory('bureau-agent-versions');
    directories.push(directory);
    const revisionStore = textValueStore(new MemoryStorage());
    const first = await start({ directory, revisionStore });
    const second = await start({ directory, revisionStore });
    await first.put('helper.md', validAgentFile('Version one.\n'));

    await Promise.all([first.catalog.refresh(), second.catalog.refresh()]);

    expect(await revisionsOf(first)).toEqual([1]);
    expect(await revisionsOf(second)).toEqual([1]);
  });
});

describe('a save through the writer', () => {
  it('is exactly one version, saved by the caller', async () => {
    const fixture = await seeded();

    await fixture.catalog.update('helper', definition('Version two.\n'), {
      expectedHash: hashOf(fixture),
      savedBy: ALICE,
    });
    await fixture.catalog.refresh();

    const versions = await fixture.catalog.versions.list('helper');
    expect(versions.map((entry) => [entry.revision, entry.savedBy])).toEqual([
      [2, ALICE],
      [1, null],
    ]);
    expect(versions[0]?.owner).toBe('anonymous:local');
    expect(versions[0]?.hash).toBe(hashOf(fixture));
  });

  it('records a save with no stated caller as the anonymous local owner, never as an outside edit', async () => {
    const fixture = await seeded();
    await fixture.catalog.update('helper', definition('Version two.\n'), {
      expectedHash: hashOf(fixture),
    });

    const [latest] = await fixture.catalog.versions.list('helper');
    expect(latest?.savedBy).toBe('anonymous:local');
  });

  it('records a created agent as version 1, saved by the caller', async () => {
    const fixture = await start();

    await fixture.catalog.create('helper', definition('Version one.\n'), { savedBy: ALICE });

    const [only] = await fixture.catalog.versions.list('helper');
    expect(only).toMatchObject({ revision: 1, savedBy: ALICE });
    expect(only?.changedKeys).toContain('instructions');
  });

  it('is a version when the file is opted into A2A, because that rewrites the file', async () => {
    const fixture = await seeded();
    await fixture.catalog.update('helper', definition('Version one.\n', { a2a: true }), {
      expectedHash: hashOf(fixture),
      savedBy: ALICE,
    });

    const [latest] = await fixture.catalog.versions.list('helper');
    expect(latest).toMatchObject({
      revision: 2,
      changedKeys: ['a2a'],
    });
  });

  it('adds no version when it fails because the file moved', async () => {
    const fixture = await seeded();
    const stale = hashOf(fixture);
    await fixture.put('helper.md', validAgentFile('Version two.\n'));
    await fixture.catalog.refresh();

    const failure = await rejectionOf(
      fixture.catalog.update('helper', definition('Mine.\n'), {
        expectedHash: stale,
        savedBy: ALICE,
      }),
    );

    expect(failure).toBeInstanceOf(AgentFileConflictError);

    expect(await revisionsOf(fixture)).toEqual([2, 1]);
  });

  it('adds no version for a definition that changes nothing', async () => {
    const fixture = await seeded();
    await fixture.catalog.update('helper', definition('Version one.\n'), {
      expectedHash: hashOf(fixture),
      savedBy: ALICE,
    });

    expect(await revisionsOf(fixture)).toEqual([1]);
  });

  it('adds no version for a definition that would not load', async () => {
    const fixture = await seeded();
    const failure = await rejectionOf(
      fixture.catalog.update('helper', definition('Version two.\n', { model: 'anthropic/none' }), {
        expectedHash: hashOf(fixture),
        savedBy: ALICE,
      }),
    );

    expect(failure).toBeInstanceOf(AgentFileError);

    expect(await revisionsOf(fixture)).toEqual([1]);
  });
});

describe('a save while the directory is being watched', () => {
  it('is still exactly one version, saved by the caller and not by the watcher that may see the file first', async () => {
    const fixture = await seeded({ watch: true });

    await fixture.catalog.update('helper', definition('Version two.\n'), {
      expectedHash: hashOf(fixture),
      savedBy: ALICE,
    });
    await fixture.catalog.refresh();

    const versions = await fixture.catalog.versions.list('helper');
    expect(versions.map((entry) => [entry.revision, entry.savedBy])).toEqual([
      [2, ALICE],
      [1, null],
    ]);
  });
});

describe('a crash between the revision and the version', () => {
  it('cannot happen: a batch that does not commit leaves neither', async () => {
    const base: ConditionalTextValueStore = textValueStore(new MemoryStorage());
    const failures: string[] = [];
    let failing = false;
    const revisionStore: ConditionalTextValueStore = {
      ...base,
      conditionalBatch: async (conditions, operations) => {
        if (failing) throw new Error('the process stopped');
        return base.conditionalBatch(conditions, operations);
      },
    };
    const fixture = await seeded({
      revisionStore,
      diagnose: (message) => {
        failures.push(message);
      },
    });
    const before = [
      ...(await base.list(AGENT_REVISION_KEY_PREFIX)),
      ...(await base.list(AGENT_VERSION_KEY_PREFIX)),
    ];

    failing = true;
    await fixture.put('helper.md', validAgentFile('Version two.\n'));
    await fixture.catalog.refresh();

    expect(failures).toHaveLength(1);
    expect([
      ...(await base.list(AGENT_REVISION_KEY_PREFIX)),
      ...(await base.list(AGENT_VERSION_KEY_PREFIX)),
    ]).toEqual(before);
    expect(await revisionsOf(fixture)).toEqual([1]);
  });
});

describe('restore', () => {
  it('writes version N back as a new version equal to it, saved by the caller, and leaves the older ones', async () => {
    const fixture = await seeded();
    await fixture.catalog.update('helper', definition('Version two.\n'), {
      expectedHash: hashOf(fixture),
      savedBy: ALICE,
    });

    const result = await fixture.catalog.versions.restore('helper', 1, {
      expectedHash: hashOf(fixture),
      savedBy: 'api-key:bob',
    });

    expect(result.hash).toBe(hashOf(fixture));
    const versions = await fixture.catalog.versions.list('helper');
    expect(versions.map((entry) => entry.revision)).toEqual([3, 2, 1]);
    expect(versions[0]).toMatchObject({ savedBy: 'api-key:bob', changedKeys: ['instructions'] });
    expect(versions[0]?.definition).toEqual(versions[2]?.definition);
    expect(versions[1]?.definition.instructions).toBe('Version two.\n');
    expect(fixture.catalog.list().find((listing) => listing.id === 'helper')).toMatchObject({
      definitionRevision: 3,
    });
  });

  it('restores a version that never ran, because versions do not depend on runs', async () => {
    const fixture = await seeded();
    await fixture.catalog.update('helper', definition('Version two.\n'), {
      expectedHash: hashOf(fixture),
    });

    await fixture.catalog.versions.restore('helper', 1, {
      expectedHash: hashOf(fixture),
      savedBy: ALICE,
    });

    const [latest] = await fixture.catalog.versions.list('helper');
    expect(latest?.definition.instructions).toBe('Version one.\n');
  });

  it('leaves the file’s examples as they are, because a caller never supplies them', async () => {
    const fixture = await start();
    await fixture.put(
      'helper.md',
      agentFileText(
        { name: 'Helper', model: KNOWN_MODEL, examples: '[Say hello]' },
        'Version one.\n',
      ),
    );
    await fixture.catalog.refresh();
    await fixture.catalog.update('helper', definition('Version two.\n'), {
      expectedHash: hashOf(fixture),
    });

    await fixture.catalog.versions.restore('helper', 1, { expectedHash: hashOf(fixture) });

    const detail = await fixture.catalog.detail('helper');
    expect(detail?.definition?.examples).toEqual(['Say hello']);
    expect(detail?.definition?.instructions).toBe('Version one.\n');
  });

  it('restores stepLimit and retry to the earlier version’s values, and names them in changedKeys', async () => {
    const fixture = await seeded();
    const firstRetry = { attempts: 2, delayMilliseconds: 100 };
    await fixture.catalog.update(
      'helper',
      definition('Version one.\n', { stepLimit: 10, retry: firstRetry }),
      { expectedHash: hashOf(fixture), savedBy: ALICE },
    );
    await fixture.catalog.update(
      'helper',
      definition('Version one.\n', { stepLimit: 40, retry: { attempts: 5, jitter: true } }),
      { expectedHash: hashOf(fixture), savedBy: ALICE },
    );

    await fixture.catalog.versions.restore('helper', 2, {
      expectedHash: hashOf(fixture),
      savedBy: 'api-key:bob',
    });

    const versions = await fixture.catalog.versions.list('helper');
    expect(versions.map((entry) => entry.revision)).toEqual([4, 3, 2, 1]);
    expect(versions[0]?.definition).toMatchObject({ stepLimit: 10, retry: firstRetry });
    expect(versions[0]?.definition).toEqual(versions[2]?.definition);
    expect(versions[0]?.changedKeys).toEqual(['stepLimit', 'retry']);
    expect(versions[1]?.changedKeys).toEqual(['stepLimit', 'retry']);
    const detail = await fixture.catalog.detail('helper');
    expect(detail?.definition).toMatchObject({ stepLimit: 10, retry: firstRetry });
  });

  it('removes a stepLimit and retry the restored version does not have', async () => {
    const fixture = await seeded();
    await fixture.catalog.update(
      'helper',
      definition('Version one.\n', { stepLimit: 40, retry: { attempts: 3 } }),
      { expectedHash: hashOf(fixture), savedBy: ALICE },
    );

    await fixture.catalog.versions.restore('helper', 1, { expectedHash: hashOf(fixture) });

    const [latest] = await fixture.catalog.versions.list('helper');
    expect(Object.hasOwn(latest?.definition ?? {}, 'stepLimit')).toBe(false);
    expect(Object.hasOwn(latest?.definition ?? {}, 'retry')).toBe(false);
    expect(latest?.changedKeys).toEqual(['stepLimit', 'retry']);
  });

  it('fails with a conflict and adds no version when the file has moved', async () => {
    const fixture = await seeded();
    const stale = hashOf(fixture);
    await fixture.put('helper.md', validAgentFile('Version two.\n'));
    await fixture.catalog.refresh();

    const failure = await fixture.catalog.versions
      .restore('helper', 1, { expectedHash: stale, savedBy: ALICE })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentFileConflictError);
    expect(failure).toMatchObject({ code: 'agent-file-changed', currentHash: hashOf(fixture) });
    expect(await revisionsOf(fixture)).toEqual([2, 1]);
  });

  it('fails as unprocessable when the version’s model is gone from the catalog', async () => {
    const fixture = await seeded();
    await fixture.catalog.update('helper', definition('Version two.\n', { model: OTHER_MODEL }), {
      expectedHash: hashOf(fixture),
    });
    await fixture.catalog.update('helper', definition('Version three.\n'), {
      expectedHash: hashOf(fixture),
    });
    fixture.models.replace(
      fixture.descriptors.filter((row) => `${row.provider}/${row.model}` !== OTHER_MODEL),
    );

    const failure = await fixture.catalog.versions
      .restore('helper', 2, { expectedHash: hashOf(fixture), savedBy: ALICE })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(AgentFileError);
    expect(failure).toMatchObject({ code: 'unknown-model' });
    expect(await revisionsOf(fixture)).toEqual([3, 2, 1]);
  });

  it('fails as unprocessable when a tool the version names is gone', async () => {
    const directory = createTemporaryDirectory('bureau-agent-versions');
    directories.push(directory);
    const revisionStore = textValueStore(new MemoryStorage());
    const first = await start({ directory, revisionStore });
    await first.put('helper.md', validAgentFile('Version one.\n'));
    await first.catalog.refresh();
    await first.catalog.update(
      'helper',
      definition('Version two.\n', { tools: ['lookup-order'] }),
      {
        expectedHash: hashOf(first),
      },
    );
    await first.catalog.update('helper', definition('Version three.\n', { tools: [] }), {
      expectedHash: hashOf(first),
    });
    await first.dispose();
    fixtures.splice(fixtures.indexOf(first), 1);

    const second = await start({ directory, revisionStore, tools: {} });
    await second.catalog.refresh();
    const failure = await second.catalog.versions
      .restore('helper', 2, { expectedHash: hashOf(second), savedBy: ALICE })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'unknown-tool' });
    expect(await revisionsOf(second)).toEqual([3, 2, 1]);
  });

  it('fails with a typed error for a version that is not stored', async () => {
    const fixture = await seeded();

    const failure = await fixture.catalog.versions
      .restore('helper', 9, { expectedHash: hashOf(fixture), savedBy: ALICE })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'agent-version-not-found' });
    expect(await revisionsOf(fixture)).toEqual([1]);
  });

  it('writes nothing when the version is what the file already holds', async () => {
    const fixture = await seeded();
    const before = hashOf(fixture);

    const result = await fixture.catalog.versions.restore('helper', 1, {
      expectedHash: before,
      savedBy: ALICE,
    });

    expect(result.hash).toBe(before);
    expect(await revisionsOf(fixture)).toEqual([1]);
  });
});

describe('retention', () => {
  it('keeps a version a retained run references past the limit, and prunes the oldest unreferenced one', async () => {
    const fixture = await seeded({ retainedRevisions: async () => new Set([1]) });
    for (let n = 2; n <= 51; n += 1) {
      await fixture.catalog.update('helper', definition(`Version ${n}.\n`), {
        expectedHash: hashOf(fixture),
      });
    }

    const kept = await revisionsOf(fixture);
    expect(kept).toHaveLength(50);
    expect(kept.at(-1)).toBe(1);
    expect(kept).not.toContain(2);
    expect(kept.at(0)).toBe(51);
  });
});
