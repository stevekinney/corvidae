/**
 * COR-1489 — what `bureau.agents.list` returns: every entry's `kind` (`code` or `file`), and the
 * code-defined agents the `publish` allowlist does not name, as `unpublished`, to a caller who may
 * read definitions (`mayDiscloseUnpublishedAgents`) and to nobody else.
 */
import { createAgent } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

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
  entries.map((entry) => [entry['name'], entry['kind'], entry['publishState']]);

describe('bureau.agents.list kinds', () => {
  it('says whether each agent is defined in code or in a file', async () => {
    const served = await serve();
    await seed(served);
    await callAs(served.local, 'bureau.agents.definitions.publish', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
    });

    const listed = await callAs(served.local, 'bureau.agents.list', {});

    expect(summary(listOf(listed, 'agents'))).toEqual([
      ['alpha', 'code', 'published'],
      ['researcher', 'file', 'published'],
    ]);
  });

  it('keeps a withdrawn file agent a file, for a caller that may read definitions', async () => {
    const served = await serve();
    await seed(served);

    const listed = await callAs(served.local, 'bureau.agents.list', {});

    expect(summary(listOf(listed, 'agents'))).toContainEqual(['researcher', 'file', 'withdrawn']);
  });
});

describe('bureau.agents.list unpublished code-defined agents', () => {
  /** A deployment whose allowlist names `alpha` only, with a second code-defined agent. */
  function withHiddenAgent() {
    return serve({
      agents: {
        alpha: createAgent({
          name: 'alpha',
          generate: async () => ({ content: 'a', toolCalls: [] }),
        }),
        internal: createAgent({
          name: 'internal',
          description: 'Never offered',
          generate: async () => ({ content: 'i', toolCalls: [] }),
        }),
      },
    });
  }

  it('are listed as unpublished to a caller holding bureau.agents:read', async () => {
    const served = await withHiddenAgent();

    const listed = await rpc(served.keyed, 'bureau.agents.list', {}, 'operator-key');

    expect(summary(listOf(listed, 'agents'))).toEqual([
      ['alpha', 'code', 'published'],
      ['internal', 'code', 'unpublished'],
    ]);
  });

  it('are listed to the owner of the deployment’s agents, who holds no scope', async () => {
    const served = await withHiddenAgent();

    const listed = await callAs(served.owner, 'bureau.agents.list', {});

    expect(summary(listOf(listed, 'agents'))).toContainEqual(['internal', 'code', 'unpublished']);
  });

  it('do not exist for any other caller, by name, label or description', async () => {
    const served = await withHiddenAgent();

    const listed = await rpc(served.keyed, 'bureau.agents.list', {}, 'alice-key');

    expect(summary(listOf(listed, 'agents'))).toEqual([['alpha', 'code', 'published']]);
    expect(JSON.stringify(listed)).not.toContain('internal');
    expect(JSON.stringify(listed)).not.toContain('Never offered');
  });

  it('are not offered: the deployment names only what the allowlist publishes', async () => {
    const served = await withHiddenAgent();

    const deployment = await callAs(served.local, 'bureau.deployment.get', {});

    expect(deployment.result?.['publishedAgents']).toEqual(['alpha']);
  });
});
