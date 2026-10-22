/**
 * COR-1584 — `definitionRevision` on the wire. `bureau.agents.definitions.get` and `.list` report
 * it nullable: the persisted revision for a valid file agent, the profile's revision for a
 * code-defined agent, and `null` for an invalid file. `bureau.agents.list` reports the same value
 * for the agents it lists. An edit raises it on all three.
 */
import { createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { agentFileText, KNOWN_MODEL } from '../../testing/agent-file-fixtures.test-support.ts';
import {
  callAs,
  DEFINITION,
  disposeServed,
  listOf,
  RESEARCHER,
  seed,
  serve,
  type Served,
} from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

type Entry = Record<string, unknown>;

/** The revision each of the three operations reports for `id`, in the order get, definitions list, agents list. */
async function reported(served: Served, id: string): Promise<unknown[]> {
  const got = await callAs(served.local, 'bureau.agents.definitions.get', { id });
  const defined = await callAs(served.local, 'bureau.agents.definitions.list', { limit: 100 });
  const listed = await callAs(served.local, 'bureau.agents.list', {});
  const revision = (entries: Entry[], key: 'id' | 'name') =>
    entries.find((entry) => entry[key] === id)?.['definitionRevision'];
  return [
    got.result?.['definitionRevision'],
    revision(listOf(defined, 'agents'), 'id'),
    revision(listOf(listed, 'agents'), 'name'),
  ];
}

describe('definitionRevision on the wire', () => {
  it('is 1 for a file agent that has not changed, on all three operations', async () => {
    const served = await serve();
    await seed(served);

    expect(await reported(served, 'researcher')).toEqual([1, 1, 1]);
  });

  it('rises on all three operations when the file is edited', async () => {
    const served = await serve();
    await seed(served);
    const before = await reported(served, 'researcher');
    expect(before.slice(0, 2)).toEqual([1, 1]);

    const updated = await callAs(served.local, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
      definition: { ...DEFINITION, name: 'Renamed' },
    });
    expect(updated.error).toBeUndefined();

    expect(await reported(served, 'researcher')).toEqual([2, 2, 2]);
  });

  it('rises when the file is edited by hand and the catalog rescans', async () => {
    const served = await serve();
    await served.put('researcher.md', RESEARCHER);
    await served.bureau.agents.refresh();
    const [before] = await reported(served, 'researcher');
    expect(before).toBe(1);

    await served.put('researcher.md', agentFileText({ model: KNOWN_MODEL }, 'Rewritten.\n'));
    await served.bureau.agents.refresh();

    const afterEdit = await callAs(served.local, 'bureau.agents.definitions.get', {
      id: 'researcher',
    });
    expect(afterEdit.result?.['definitionRevision']).toBe(2);
  });

  it('is the profile’s revision for a code-defined agent', async () => {
    const served = await serve({
      agents: {
        alpha: createAgent({
          name: 'alpha',
          revision: 4,
          generate: async () => ({ content: 'a', toolCalls: [] }),
        }),
      },
    });

    expect(await reported(served, 'alpha')).toEqual([4, 4, 4]);
  });

  it('is 1 for a code-defined agent that names no revision', async () => {
    const served = await serve();

    expect(await reported(served, 'alpha')).toEqual([1, 1, 1]);
  });

  it('is null for an invalid file, which bureau.agents.list does not list', async () => {
    const served = await serve();
    await served.put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await served.bureau.agents.refresh();

    const got = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'broken' });
    const defined = await callAs(served.local, 'bureau.agents.definitions.list', { limit: 100 });
    const listed = await callAs(served.local, 'bureau.agents.list', {});

    expect(got.result).toMatchObject({ id: 'broken', state: 'invalid', definitionRevision: null });
    expect(
      listOf(defined, 'agents').find((entry) => entry['id'] === 'broken')?.['definitionRevision'],
    ).toBeNull();
    expect(listOf(listed, 'agents').some((entry) => entry['name'] === 'broken')).toBe(false);
  });
});
