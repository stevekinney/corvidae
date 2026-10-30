/**
 * COR-1526 correction — the boundaries of the agent definition operations: who is told an agent
 * exists, how a code-defined key is refused, what deleting an agent does to the runs that are
 * already parked, what `a2a` means for a code-defined agent, how turning the A2A opt-in on or off
 * rewrites a file, and how long an identifier may be.
 */
import { EventType } from '@ag-ui/core';
import { createAgent, createScriptedGenerate } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { AGENT_IDENTIFIER_MAX_LENGTH, parseAgentFile } from '../../agent-file.ts';
import { agentFileText, KNOWN_MODEL } from '../../testing/agent-file-fixtures.test-support.ts';
import { startFileBureau } from '../../testing/agent-file-bureau.test-support.ts';
import { createBureau } from '../../create-bureau.ts';
import { readAgUiStream, typesOf } from '../ag-ui-stream.test-support.ts';
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
import { MemoryStorage } from '@lostgradient/storage';

afterEach(disposeServed);

const names = (response: Awaited<ReturnType<typeof callAs>>): string[] =>
  listOf(response, 'agents').map((entry) => String(entry['name'] ?? entry['id']));

const sorted = (values: string[]): string[] =>
  values.toSorted((left, right) => (left < right ? -1 : left > right ? 1 : 0));

describe('who is told an agent exists', () => {
  // COR-1904: every authenticated caller used to see every ready agent. Now `bureau.agents:read`
  // shows them all, and a caller without it sees only the ones that opt into A2A.
  it('shows every ready persisted agent in bureau.agents.list to a caller holding bureau.agents:read, the A2A ones to any other, and an invalid file to none', async () => {
    const served = await serve();
    const draft = await callAs(served.local, 'bureau.agents.definitions.create', {
      id: 'secret-launch',
      definition: { ...DEFINITION, name: 'Secret launch planner' },
    });
    const open = await callAs(served.local, 'bureau.agents.definitions.create', {
      id: 'open-agent',
      definition: { ...DEFINITION, a2a: true },
    });
    expect(draft.error).toBeUndefined();
    expect(open.error).toBeUndefined();
    await served.put('broken.md', agentFileText({ model: 'anthropic/none' }));
    await served.bureau.agents.refresh();

    const asKey = async (key: string) =>
      names(await rpc(served.keyed, 'bureau.agents.list', {}, key));
    const all = ['alpha', 'open-agent', 'secret-launch'];
    for (const key of ['agents-reader-key', 'operator-key']) {
      expect([key, sorted(await asKey(key))]).toEqual([key, all]);
    }
    const offeredOverA2A = ['alpha', 'open-agent'];
    for (const key of ['alice-key', 'agents-writer-key']) {
      expect([key, sorted(await asKey(key))]).toEqual([key, offeredOverA2A]);
    }
    expect(sorted(names(await callAs(served.owner, 'bureau.agents.list', {})))).toEqual(
      offeredOverA2A,
    );
    expect(sorted(names(await callAs(served.local, 'bureau.agents.list', {})))).toEqual(all);
    // What the definition operations disclose is still gated by the read scope.
    const denied = await rpc(
      served.keyed,
      'bureau.agents.definitions.get',
      { id: 'secret-launch' },
      'alice-key',
    );
    expect(denied.error?.data?.httpStatus).toBe(404);
  });
});

describe('a code-defined key', () => {
  const guarded = [
    ['update', { definition: DEFINITION }],
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
      storage: new MemoryStorage(),
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

describe('deleting an agent gates new runs only', () => {
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
    return { served, handler, resume, hash: served.hashOf('researcher') };
  }

  it('resumes a parked run while its agent exists, so the case below is not vacuous', async () => {
    const { resume } = await parkingServed();
    const frames = await readAgUiStream(await resume());
    expect(typesOf(frames)).toContain(EventType.RUN_FINISHED);
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
    const fresh = await readAgUiStream(
      await handler(startRequest(runAgentInput({ threadId: 'fresh' }), {}, 'researcher')),
    );
    expect(typesOf(fresh)).toEqual([EventType.RUN_ERROR]);
  });
});

describe('a2a, for a code-defined agent', () => {
  it('is true when the allowlist names it, in get and list, as bureau.agents.list says', async () => {
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
    expect(byId['alpha']).toMatchObject({ source: 'code', a2a: true });
    expect(byId['beta']).toMatchObject({ source: 'code', a2a: false });
    for (const [id, a2a] of [
      ['alpha', true],
      ['beta', false],
    ] as const) {
      const got = await callAs(served.local, 'bureau.agents.definitions.get', { id });
      expect([id, got.result?.['a2a']]).toEqual([id, a2a]);
    }
    // Both are listed; the allowlist only decides which opt into A2A.
    const listedAgents = await callAs(served.local, 'bureau.agents.list', {});
    expect(listOf(listedAgents, 'agents').map((entry) => [entry['name'], entry['a2a']])).toEqual([
      ['alpha', true],
      ['beta', false],
    ]);
  });
});

describe('turning the A2A opt-in on or off keeps the shape of the file', () => {
  const shapes: Array<[string, string]> = [
    ['a comment above the model', `# kept\nname: Named\nmodel: ${KNOWN_MODEL}\n`],
    ['a key Bureau does not know', `name: Named\nmodel: ${KNOWN_MODEL}\ncreated: 2026-10-18\n`],
  ];

  for (const [label, frontmatter] of shapes) {
    it(`for ${label}`, async () => {
      const served = await serve();
      const original = `---\n${frontmatter}---\nBody.\n`;
      await served.put('shape.md', original);
      await served.bureau.agents.refresh();
      const parsed = parseAgentFile('shape', original);
      if (!parsed.ok) throw new Error('expected the fixture to parse');
      const { name, model, instructions } = parsed.file.definition;
      const optedIn = await callAs(served.owner, 'bureau.agents.definitions.update', {
        id: 'shape',
        expectedHash: served.hashOf('shape'),
        definition: { name, model, instructions, a2a: true },
      });
      expect(await readFile(ownerPath(served, 'shape'), 'utf8')).toBe(
        original.replace('\n---\nBody', '\na2a: true\n---\nBody'),
      );
      await callAs(served.owner, 'bureau.agents.definitions.update', {
        id: 'shape',
        expectedHash: optedIn.result?.['hash'],
        definition: { name, model, instructions, a2a: false },
      });
      expect(await readFile(ownerPath(served, 'shape'), 'utf8')).toBe(
        original.replace('\n---\nBody', '\na2a: false\n---\nBody'),
      );
    });
  }

  it('for an a2a line that is replaced in place', async () => {
    const served = await serve();
    const original = `---\n# kept\nmodel: ${KNOWN_MODEL}\na2a: false\ncreated: 2026-10-18\n---\nBody.\n`;
    await served.put('shape.md', original);
    await served.bureau.agents.refresh();
    await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'shape',
      expectedHash: served.hashOf('shape'),
      definition: { model: KNOWN_MODEL, instructions: 'Body.\n', a2a: true },
    });
    expect(await readFile(ownerPath(served, 'shape'), 'utf8')).toBe(
      original.replace('a2a: false', 'a2a: true'),
    );
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
