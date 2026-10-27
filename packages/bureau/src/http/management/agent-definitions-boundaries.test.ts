/**
 * COR-1526 correction — the boundaries of the agent definition operations: who is told an
 * unpublished agent exists, how a code-defined key is refused, what withdrawing or deleting an
 * agent does to the runs that are already parked, what `published` means for a code-defined
 * agent, how publishing rewrites a file, and how long an identifier may be.
 */
import { EventType } from '@ag-ui/core';
import { createAgent, createScriptedGenerate } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { AGENT_IDENTIFIER_MAX_LENGTH, parseAgentFile } from '../../agent-file.ts';
import { agentFileText, KNOWN_MODEL } from '../../testing/agent-file-fixtures.test-support.ts';
import { startFileBureau } from '../../testing/agent-file-bureau.test-support.ts';
import { createBureau } from '../../create-bureau.ts';
import { bureauMetadata, readAgUiStream, typesOf } from '../ag-ui-stream.test-support.ts';
import { runAgentInput, startRequest } from '../ag-ui-fixtures.test-support.ts';
import { createBureauHandler } from '../create-bureau-handler.ts';
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
import { readFile } from 'node:fs/promises';
import { createMemoryAssetStorage } from '../../assets/storage';

afterEach(disposeServed);

const names = (response: Awaited<ReturnType<typeof callAs>>): string[] =>
  listOf(response, 'agents').map((entry) => String(entry['name'] ?? entry['id']));

const sorted = (values: string[]): string[] =>
  values.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));

describe('who is told an unpublished agent exists', () => {
  it('shows a draft or withdrawn persisted agent in bureau.agents.list only to a caller who may read definitions', async () => {
    const served = await serve();
    // A draft (never published) and a withdrawn agent, and one that is published.
    const draft = await callAs(served.local, 'bureau.agents.definitions.create', {
      id: 'secret-launch',
      definition: { ...DEFINITION, name: 'Secret launch planner' },
    });
    const withdrawnHash = await callAs(served.local, 'bureau.agents.definitions.create', {
      id: 'once-public',
      definition: DEFINITION,
    });
    const published = await callAs(served.local, 'bureau.agents.definitions.publish', {
      id: 'once-public',
      expectedHash: withdrawnHash.result?.['hash'],
    });
    await callAs(served.local, 'bureau.agents.definitions.withdraw', {
      id: 'once-public',
      expectedHash: published.result?.['hash'],
    });
    const open = await callAs(served.local, 'bureau.agents.definitions.create', {
      id: 'open-agent',
      definition: DEFINITION,
    });
    await callAs(served.local, 'bureau.agents.definitions.publish', {
      id: 'open-agent',
      expectedHash: open.result?.['hash'],
    });
    expect(draft.error).toBeUndefined();

    const asKey = async (key: string) =>
      names(await rpc(served.keyed, 'bureau.agents.list', {}, key));
    // No scope, no ownership: only what is published, and nothing about the rest.
    expect(await asKey('alice-key')).toEqual(['alpha', 'open-agent']);
    // The scope that reads definitions, the owner, and an operator also see the unpublished ones.
    const all = ['alpha', 'once-public', 'open-agent', 'secret-launch'];
    expect(sorted(await asKey('agents-reader-key'))).toEqual(all);
    expect(sorted(await asKey('operator-key'))).toEqual(all);
    expect(sorted(names(await callAs(served.owner, 'bureau.agents.list', {})))).toEqual(all);
    // The write scope alone does not read.
    expect(await asKey('agents-writer-key')).toEqual(['alpha', 'open-agent']);
    // Nothing in the unpublished agent's own words reaches a caller who may not see it.
    const alice = JSON.stringify(await rpc(served.keyed, 'bureau.agents.list', {}, 'alice-key'));
    expect(alice).not.toContain('Secret launch planner');
    expect(alice).not.toContain('secret-launch');
  });
});

describe('a code-defined key', () => {
  const guarded = [
    ['update', { definition: DEFINITION }],
    ['publish', {}],
    ['withdraw', {}],
    ['delete', {}],
  ] as const;

  it('answers NotFound to every write before a same-named file is touched', async () => {
    const served = await serve();
    await served.put('alpha.md', agentFileText({ model: KNOWN_MODEL }, 'A shadow.\n'));
    await served.bureau.agents.refresh();
    const shadowHash = served.bureau.agents
      .list()
      .find((listing) => listing.id === 'alpha' && listing.source === 'file')?.definitionHash;
    expect(shadowHash).toBeDefined();
    const before = await readFile(ownerPath(served, 'alpha'), 'utf8');
    for (const [method, extra] of guarded) {
      const response = await rpc(
        served.keyed,
        `bureau.agents.definitions.${method}`,
        { id: 'alpha', expectedHash: shadowHash, ...extra },
        'operator-key',
      );
      expect([method, response.error?.data?.httpStatus]).toEqual([method, 404]);
    }
    expect(await readFile(ownerPath(served, 'alpha'), 'utf8')).toBe(before);
    expect(await served.bureau.internals.auditTrail?.query({ runId: 'agent:alpha' })).toEqual([]);
  });

  it('answers NotFound to every write on a Bureau with no agent directory', async () => {
    const bureau = await createBureau({
      assets: { storage: createMemoryAssetStorage() },
      id: 'no-directory',
      agents: {
        alpha: createAgent({
          name: 'alpha',
          generate: async () => ({ content: 'a', toolCalls: [] }),
        }),
      },
      storage: { type: 'memory' },
    });
    try {
      const handler = createBureauHandler(bureau, { unauthenticatedAccess: 'allow' });
      for (const [method, extra] of guarded) {
        const response = await callAs(handler, `bureau.agents.definitions.${method}`, {
          id: 'alpha',
          expectedHash: 'x',
          ...extra,
        });
        expect([method, response.error?.data?.httpStatus]).toEqual([method, 404]);
      }
    } finally {
      await bureau.dispose();
    }
  });
});

describe('publication gates new runs only', () => {
  /** A Bureau whose file agents ask a human, and then answer. */
  async function parkingServed() {
    const served = await serve({
      overrides: {
        models: {
          generate: () =>
            createScriptedGenerate([
              {
                kind: 'respond',
                response: {
                  content: 'Asking.',
                  toolCalls: [
                    {
                      id: 'call-1',
                      name: 'requestHumanInput',
                      arguments: { signalName: 'human-response', prompt: 'Go ahead?' },
                    },
                  ],
                },
              },
              { kind: 'respond', response: { content: 'Done.', toolCalls: [] } },
            ]),
        },
      },
    });
    await served.put('researcher.md', agentFileText({ model: KNOWN_MODEL }, 'Ask first.\n'));
    await served.bureau.agents.refresh();
    const handler = createBureauHandler(served.bureau, {
      unauthenticatedAccess: 'allow',
      agUi: {},
    });
    const published = await callAs(handler, 'bureau.agents.definitions.publish', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
    });
    const frames = await readAgUiStream(
      await handler(startRequest(runAgentInput({ threadId: 'parked' }), {}, 'researcher')),
    );
    const finished = frames.at(-1)?.event as {
      outcome: { type: string; interrupts: Array<{ id: string }> };
    };
    expect(finished.outcome.type).toBe('interrupt');
    const interruptId = finished.outcome.interrupts[0]?.id ?? '';
    const resume = () =>
      handler(
        startRequest(
          runAgentInput({
            threadId: 'parked',
            runId: 'client-run-2',
            messages: [],
            resume: [{ interruptId, status: 'resolved', payload: { decision: 'approve' } }],
          }),
          {},
          'researcher',
        ),
      );
    return { served, handler, published, resume, hash: published.result?.['hash'] as string };
  }

  it('resumes a parked run while its agent is published, so the two cases below are not vacuous', async () => {
    const { resume } = await parkingServed();
    const frames = await readAgUiStream(await resume());
    expect(typesOf(frames)).toContain(EventType.RUN_FINISHED);
  });

  it('lets a parked run be resumed after its agent is withdrawn, and still refuses a new run', async () => {
    const { handler, resume, hash } = await parkingServed();
    const withdrawn = await callAs(handler, 'bureau.agents.definitions.withdraw', {
      id: 'researcher',
      expectedHash: hash,
    });
    expect(withdrawn.error).toBeUndefined();
    const frames = await readAgUiStream(await resume());
    expect(typesOf(frames)).toContain(EventType.RUN_FINISHED);
    expect(typesOf(frames)).not.toContain(EventType.RUN_ERROR);
    expect(String(bureauMetadata(frames[0]!.event)['runId'])).not.toBe('');
    const fresh = await readAgUiStream(
      await handler(startRequest(runAgentInput({ threadId: 'fresh' }), {}, 'researcher')),
    );
    expect(typesOf(fresh)).toEqual([EventType.RUN_ERROR]);
  });

  it('lets a parked run be resumed after its agent is deleted', async () => {
    const { handler, resume, hash } = await parkingServed();
    const deleted = await callAs(handler, 'bureau.agents.definitions.delete', {
      id: 'researcher',
      expectedHash: hash,
    });
    expect(deleted.error).toBeUndefined();
    const frames = await readAgUiStream(await resume());
    expect(typesOf(frames)).toContain(EventType.RUN_FINISHED);
    expect(typesOf(frames)).not.toContain(EventType.RUN_ERROR);
  });
});

describe('published, for a code-defined agent', () => {
  it('is true when the allowlist publishes it, in get and list, as bureau.agents.list says', async () => {
    const served = await serve({
      agents: {
        alpha: createAgent({
          name: 'alpha',
          generate: async () => ({ content: 'a', toolCalls: [] }),
        }),
        beta: createAgent({
          name: 'beta',
          generate: async () => ({ content: 'b', toolCalls: [] }),
        }),
      },
    });
    const listed = await callAs(served.local, 'bureau.agents.definitions.list', {});
    const byId = Object.fromEntries(listOf(listed, 'agents').map((entry) => [entry['id'], entry]));
    expect(byId['alpha']).toMatchObject({ source: 'code', published: true });
    expect(byId['beta']).toMatchObject({ source: 'code', published: false });
    for (const [id, published] of [
      ['alpha', true],
      ['beta', false],
    ] as const) {
      const got = await callAs(served.local, 'bureau.agents.definitions.get', { id });
      expect([id, got.result?.['published']]).toEqual([id, published]);
    }
    // The caller that holds every scope also sees the agent the allowlist does not name, as unpublished.
    const published = await callAs(served.local, 'bureau.agents.list', {});
    expect(
      listOf(published, 'agents').map((entry) => [entry['name'], entry['publishState']]),
    ).toEqual([
      ['alpha', 'published'],
      ['beta', 'unpublished'],
    ]);
  });
});

describe('publish and withdraw keep the shape of the file', () => {
  const shapes: Array<[string, string]> = [
    ['an empty tools list', `name: Named\nmodel: ${KNOWN_MODEL}\ntools: []\n`],
    ['a null description', `name: Named\ndescription: ~\nmodel: ${KNOWN_MODEL}\n`],
    ['a padded name', `name: "  Padded  "\nmodel: ${KNOWN_MODEL}\n`],
    ['a null name', `name:\nmodel: ${KNOWN_MODEL}\n`],
    ['a null skills list', `model: ${KNOWN_MODEL}\nskills: ~\n`],
  ];

  for (const [label, frontmatter] of shapes) {
    it(`for ${label}`, async () => {
      const served = await serve();
      const original = `---\n${frontmatter}---\nBody.\n`;
      await served.put('shape.md', original);
      await served.bureau.agents.refresh();
      const published = await callAs(served.owner, 'bureau.agents.definitions.publish', {
        id: 'shape',
        expectedHash: served.hashOf('shape'),
      });
      expect(await readFile(ownerPath(served, 'shape'), 'utf8')).toBe(
        original.replace('\n---\nBody', '\npublished: true\n---\nBody'),
      );
      await callAs(served.owner, 'bureau.agents.definitions.withdraw', {
        id: 'shape',
        expectedHash: published.result?.['hash'],
      });
      expect(await readFile(ownerPath(served, 'shape'), 'utf8')).toBe(
        original.replace('\n---\nBody', '\npublished: false\n---\nBody'),
      );
    });
  }

  it('for a comment on the published line itself', async () => {
    const served = await serve();
    const original = `---\nmodel: ${KNOWN_MODEL}\npublished: false # off until launch\n---\nBody.\n`;
    await served.put('shape.md', original);
    await served.bureau.agents.refresh();
    await callAs(served.owner, 'bureau.agents.definitions.publish', {
      id: 'shape',
      expectedHash: served.hashOf('shape'),
    });
    const text = await readFile(ownerPath(served, 'shape'), 'utf8');
    expect(text).toContain('# off until launch');
    expect(text).toContain('published: true');
  });
});

describe('the identifier cap', () => {
  const longest = 'a'.repeat(AGENT_IDENTIFIER_MAX_LENGTH);
  const tooLong = `${longest}b`;

  it('is 64 characters, in the file format', async () => {
    expect(AGENT_IDENTIFIER_MAX_LENGTH).toBe(64);
    const served = await serve();
    await served.put(`${longest}.md`, agentFileText({ model: KNOWN_MODEL }));
    await served.put(`${tooLong}.md`, agentFileText({ model: KNOWN_MODEL }));
    await served.bureau.agents.refresh();
    const listings = served.bureau.agents.list();
    expect(listings.find((listing) => listing.id === longest)?.state).toBe('ready');
    expect(listings.find((listing) => listing.id === tooLong)).toMatchObject({
      state: 'invalid',
      problem: { code: 'invalid-identifier' },
    });
    expect(parseAgentFile(longest, agentFileText({ model: KNOWN_MODEL })).ok).toBe(true);
  });

  it('is 64 characters on the wire, for every operation that takes an identifier', async () => {
    const served = await serve();
    for (const [method, params] of [
      ['create', { id: tooLong, definition: DEFINITION }],
      ['get', { id: tooLong }],
      ['revisions', { id: tooLong }],
      ['update', { id: tooLong, expectedHash: 'x', definition: DEFINITION }],
      ['publish', { id: tooLong, expectedHash: 'x' }],
      ['withdraw', { id: tooLong, expectedHash: 'x' }],
      ['delete', { id: tooLong, expectedHash: 'x' }],
    ] as const) {
      const response = await callAs(served.owner, `bureau.agents.definitions.${method}`, params);
      expect([method, response.error?.data?.httpStatus]).toEqual([method, 400]);
    }
    const created = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: longest,
      definition: DEFINITION,
    });
    expect(created.error).toBeUndefined();
  });
});
void seed;
void startFileBureau;
