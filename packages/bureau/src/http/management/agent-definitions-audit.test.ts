/**
 * COR-2009 — PageAuditLog "Detail with a long change": an agent edit's audit record names the saved
 * version it made and the one before it ("Tool runner · version 3 → 4"), the definition keys that
 * changed, and the tools added or removed by identifier, which the page lists by their human names
 * ("Tools · added Issue refund"). It carries none of the definition's text: only the instructions
 * are diffed, from `bureau.agents.versions.list`.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  callAs,
  DEFINITION,
  disposeServed,
  seed,
  serve,
} from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

describe('an agent edit’s audit record', () => {
  it('names the versions, the changed keys and the tools added or removed, and no text', async () => {
    const served = await serve();
    const first = await seed(served);

    const removed = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: first,
      definition: {
        ...DEFINITION,
        tools: [],
        instructions: 'Answer in as many sentences as needed.\n',
      },
    });
    expect(removed.error).toBeUndefined();
    const added = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: (removed.result as { hash: string }).hash,
      definition: {
        ...DEFINITION,
        tools: ['lookup-order'],
        instructions: 'Answer in as many sentences as needed.\n',
      },
    });
    expect(added.error).toBeUndefined();

    const page = await served.bureau.audit.query({
      runId: 'agent:researcher',
      type: 'agent.updated',
    });
    expect(page.records.map((record) => [record.principal, record.detail])).toEqual([
      [
        'anonymous:local',
        {
          agentName: 'researcher',
          revision: 2,
          previousRevision: 1,
          changedKeys: expect.stringContaining('instructions'),
          toolsRemoved: 'lookup-order',
        },
      ],
      [
        'anonymous:local',
        {
          agentName: 'researcher',
          revision: 3,
          previousRevision: 2,
          changedKeys: 'tools',
          toolsAdded: 'lookup-order',
        },
      ],
    ]);
    expect(String(page.records[0]!.detail!['changedKeys']).split(',')).toEqual(
      expect.arrayContaining(['tools', 'instructions']),
    );
    expect(JSON.stringify(page)).not.toContain('Answer in as many sentences');

    // The before and after the page diffs are the two versions the record names.
    const versions = await served.bureau.agents.versions.list('researcher');
    expect(versions.map((version) => version.revision)).toEqual([3, 2, 1]);
  });
});
