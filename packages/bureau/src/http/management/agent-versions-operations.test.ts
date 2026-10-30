/**
 * COR-1815 — `bureau.agents.versions.list` and `bureau.agents.versions.restore` over a real Bureau
 * and its handler. The owner predicate and the operator scopes are covered with the other agent
 * operations in `agent-definitions-operations.test.ts`; this file covers what the two operations
 * return and how they fail.
 */
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'bun:test';

import { agentFileText, OTHER_MODEL } from '../../testing/agent-file-fixtures.test-support.ts';
import {
  callAs,
  DEFINITION,
  disposeServed,
  listOf,
  ownerPath,
  seed,
  serve,
} from './agent-definitions-fixtures.test-support.ts';
import { rpc } from './management-fixtures.test-support.ts';

afterEach(disposeServed);

describe('bureau.agents.versions.list', () => {
  it('lists the version a hand edit made and the one a save made, newest first, with who saved each', async () => {
    const served = await serve();
    const first = await seed(served);
    const saved = await rpc(
      served.keyed,
      'bureau.agents.definitions.update',
      { id: 'researcher', expectedHash: first, definition: { ...DEFINITION, name: 'Researcher' } },
      'operator-key',
    );
    expect(saved.error).toBeUndefined();

    const response = await callAs(served.owner, 'bureau.agents.versions.list', {
      id: 'researcher',
    });

    const versions = listOf(response, 'versions');
    expect(versions.map((entry) => [entry['revision'], entry['savedBy']])).toEqual([
      [2, 'api-key:operator'],
      [1, null],
    ]);
    expect(versions[0]).toMatchObject({
      hash: served.hashOf('researcher'),
      owner: 'anonymous:local',
      definition: { name: 'Researcher', instructions: 'Write well.\n' },
    });
    expect(versions[0]?.['changedKeys']).toEqual(
      expect.arrayContaining(['description', 'instructions']),
    );
    expect(typeof versions[0]?.['savedAt']).toBe('string');
  });

  it('lists a version that never ran, apart from the runs’ own history', async () => {
    const served = await serve();
    const first = await seed(served);
    await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: first,
      definition: { ...DEFINITION, name: 'Researcher' },
    });

    const versions = await callAs(served.owner, 'bureau.agents.versions.list', {
      id: 'researcher',
    });
    const runs = await callAs(served.owner, 'bureau.agents.definitions.revisions', {
      id: 'researcher',
    });

    expect(listOf(versions, 'versions')).toHaveLength(2);
    expect(listOf(runs, 'revisions')).toHaveLength(1);
  });

  it('answers a code-defined agent with none and an unknown agent with NotFound', async () => {
    const served = await serve();
    const code = await callAs(served.owner, 'bureau.agents.versions.list', { id: 'alpha' });
    expect(code.error).toBeUndefined();
    expect(listOf(code, 'versions')).toEqual([]);

    const unknown = await callAs(served.owner, 'bureau.agents.versions.list', { id: 'nobody' });
    expect(unknown.error?.data?.httpStatus).toBe(404);
  });
});

describe('bureau.agents.versions.restore', () => {
  it('writes version 1 back as a new revision saved by the caller, and the file parses to its definition', async () => {
    const served = await serve();
    const first = await seed(served);
    const edited = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: first,
      definition: { ...DEFINITION, name: 'Researcher', instructions: 'Changed.\n' },
    });
    const editedHash = (edited.result as { hash: string }).hash;

    const restored = await rpc(
      served.keyed,
      'bureau.agents.versions.restore',
      { id: 'researcher', revision: 1, expectedHash: editedHash },
      'operator-key',
    );

    expect(restored.error).toBeUndefined();
    expect(restored.result).toMatchObject({ id: 'researcher', revision: 3 });
    expect(restored.result?.['hash']).toBe(served.hashOf('researcher'));
    const versions = listOf(
      await callAs(served.owner, 'bureau.agents.versions.list', { id: 'researcher' }),
      'versions',
    );
    expect(versions.map((entry) => [entry['revision'], entry['savedBy']])).toEqual([
      [3, 'api-key:operator'],
      [2, 'anonymous:local'],
      [1, null],
    ]);
    expect(versions[0]?.['definition']).toEqual(versions[2]?.['definition']);
    const detail = await served.bureau.agents.detail('researcher');
    const stored = await served.bureau.agents.versions.list('researcher');
    expect(detail?.definition).toEqual(stored.at(-1)?.definition ?? null);
    const trail = await served.bureau.internals.auditTrail?.query({ runId: 'agent:researcher' });
    expect(trail?.map((entry) => entry.type)).toEqual(['agent.updated', 'agent.updated']);
  });

  it('is a StaleRevision carrying the hash on disk when the file moved, and adds no version', async () => {
    const served = await serve();
    const first = await seed(served);
    const edited = agentFileText({ model: OTHER_MODEL }, 'Edited by hand.\n');
    await served.put('researcher.md', edited);

    const response = await callAs(served.owner, 'bureau.agents.versions.restore', {
      id: 'researcher',
      revision: 1,
      expectedHash: first,
    });

    expect(response.error?.data?.httpStatus).toBe(409);
    expect(response.error?.data?.['expectedRevision']).toBe(first);
    expect(await readFile(ownerPath(served), 'utf8')).toBe(edited);
    await served.bureau.agents.refresh();
    const versions = listOf(
      await callAs(served.owner, 'bureau.agents.versions.list', { id: 'researcher' }),
      'versions',
    );
    expect(versions.map((entry) => entry['revision'])).toEqual([2, 1]);
  });

  it('is NotFound for a version that is not stored, and for a code-defined agent', async () => {
    const served = await serve();
    const hash = await seed(served);

    const missing = await callAs(served.owner, 'bureau.agents.versions.restore', {
      id: 'researcher',
      revision: 9,
      expectedHash: hash,
    });
    const code = await callAs(served.owner, 'bureau.agents.versions.restore', {
      id: 'alpha',
      revision: 1,
      expectedHash: hash,
    });

    expect(missing.error?.data?.httpStatus).toBe(404);
    expect(code.error?.data?.httpStatus).toBe(404);
  });

  it('is InvalidParams for a revision that is not a positive integer', async () => {
    const served = await serve();
    const hash = await seed(served);
    for (const revision of [0, 1.5, '1']) {
      const response = await callAs(served.owner, 'bureau.agents.versions.restore', {
        id: 'researcher',
        revision,
        expectedHash: hash,
      });
      expect(response.error?.data?.httpStatus, String(revision)).toBe(400);
    }
  });
});
