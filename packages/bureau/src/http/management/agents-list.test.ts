/**
 * COR-1489 — what `bureau.agents.list` returns: every entry's `kind` (`code` or `file`) and its
 * `a2a` opt-in. Every ready agent is listed to a caller holding `bureau.agents:read`, whether or not
 * it opts into A2A, and only the agents that opt in to any other caller (COR-1904).
 */
import { createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { KNOWN_MODEL } from '../../testing/agent-file-fixtures.test-support.ts';

import {
  callAs,
  disposeServed,
  listOf,
  seed,
  serve,
} from './agent-definitions-fixtures.test-support.ts';
import { rpc } from './management-fixtures.test-support.ts';

afterEach(disposeServed);

type Entry = Record<string, unknown>;
const summary = (entries: Entry[]) =>
  entries.map((entry) => [entry['name'], entry['kind'], entry['a2a']]);

describe('bureau.agents.list kinds', () => {
  it('says whether each agent is defined in code or in a file, and whether it opts into A2A', async () => {
    const served = await serve();
    await seed(served);
    await callAs(served.local, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
      definition: {
        model: KNOWN_MODEL,
        name: 'Researcher',
        instructions: 'Original.\n',
        a2a: true,
      },
    });

    const listed = await callAs(served.local, 'bureau.agents.list', {});

    expect(summary(listOf(listed, 'agents'))).toEqual([
      ['alpha', 'code', true],
      ['researcher', 'file', true],
    ]);
  });

  it('lists a file agent that has not opted in as a file with a2a false', async () => {
    const served = await serve();
    await seed(served);

    const listed = await callAs(served.local, 'bureau.agents.list', {});

    expect(summary(listOf(listed, 'agents'))).toContainEqual(['researcher', 'file', false]);
  });
});

describe('bureau.agents.list code-defined agents outside the A2A allowlist', () => {
  /** A deployment whose allowlist names `alpha` only, with a second code-defined agent. */
  function withInternalAgent() {
    return serve({
      agents: {
        alpha: createAgent({
          name: 'alpha',
          generate: async () => ({ content: 'a', toolCalls: [] }),
        }),
        internal: createAgent({
          name: 'internal',
          description: 'Never offered over A2A',
          generate: async () => ({ content: 'i', toolCalls: [] }),
        }),
      },
    });
  }

  it('are listed with a2a false to a caller holding bureau.agents:read', async () => {
    const served = await withInternalAgent();

    const listed = await rpc(served.keyed, 'bureau.agents.list', {}, 'operator-key');

    expect(summary(listOf(listed, 'agents'))).toEqual([
      ['alpha', 'code', true],
      ['internal', 'code', false],
    ]);
  });

  // COR-1904: a caller with no scope used to see them too. Now only `bureau.agents:read` does, so a
  // credential handed to A2A clients learns nothing of an agent it is not offered.
  it('are not listed to a caller who holds no scope and owns nothing', async () => {
    const served = await withInternalAgent();

    const listed = await rpc(served.keyed, 'bureau.agents.list', {}, 'alice-key');

    expect(summary(listOf(listed, 'agents'))).toEqual([['alpha', 'code', true]]);
    expect(JSON.stringify(listed)).not.toContain('Never offered over A2A');
  });

  it('are named by the deployment, which lists every ready agent', async () => {
    const served = await withInternalAgent();

    const deployment = await callAs(served.local, 'bureau.deployment.get', {});

    expect(deployment.result?.['agents']).toEqual(['alpha', 'internal']);
  });
});
