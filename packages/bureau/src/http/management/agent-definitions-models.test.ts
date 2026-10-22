/**
 * COR-1559 — the `models` list of an agent file over `bureau.agents.definitions.*`: `get` returns
 * it, `create` and `update` carry it and check it as a file's frontmatter is checked, and an
 * `update` that omits it removes it, exactly as omitting `tools` removes the tools (a client that
 * read the list sends it back to keep it).
 */
import { readFile } from 'node:fs/promises';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  agentFileText,
  KNOWN_MODEL,
  OTHER_MODEL,
} from '../../testing/agent-file-fixtures.test-support.ts';
import {
  callAs,
  DEFINITION,
  disposeServed,
  ownerPath,
  serve,
} from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

const LISTED = agentFileText(
  { name: 'Researcher', model: KNOWN_MODEL, models: `[${KNOWN_MODEL}, ${OTHER_MODEL}]` },
  'You are careful.\n',
);

async function withListedAgent() {
  const served = await serve();
  await served.put('researcher.md', LISTED);
  await served.bureau.agents.refresh();
  return served;
}

const definitionOf = (extra: Record<string, unknown> = {}) => ({
  name: 'Researcher',
  model: KNOWN_MODEL,
  instructions: 'You are careful.\n',
  ...extra,
});

describe('bureau.agents.definitions.get', () => {
  it('returns the models a file lists, and null for a file that lists none', async () => {
    const served = await withListedAgent();
    await served.put('plain.md', agentFileText({ model: KNOWN_MODEL }));
    await served.bureau.agents.refresh();

    const listed = await callAs(served.local, 'bureau.agents.definitions.get', {
      id: 'researcher',
    });
    const plain = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'plain' });

    expect(listed.result?.['definition']).toMatchObject({ models: [KNOWN_MODEL, OTHER_MODEL] });
    expect(plain.result?.['definition']).toMatchObject({ models: null });
  });
});

describe('bureau.agents.definitions.update', () => {
  it('writes the models it is sent', async () => {
    const served = await withListedAgent();

    const body = await callAs(served.local, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
      definition: definitionOf({ models: [KNOWN_MODEL] }),
    });

    expect(body.error).toBeUndefined();
    const read = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'researcher' });
    expect(read.result?.['definition']).toMatchObject({ models: [KNOWN_MODEL] });
    expect(await readFile(ownerPath(served), 'utf8')).toContain('models:');
  });

  it('removes the list when the definition omits models, exactly as it removes tools', async () => {
    const served = await withListedAgent();

    const body = await callAs(served.local, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
      definition: definitionOf({ instructions: 'Now longer.\n' }),
    });

    expect(body.error).toBeUndefined();
    const read = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'researcher' });
    expect(read.result?.['definition']).toMatchObject({
      models: null,
      tools: [],
      instructions: 'Now longer.\n',
    });
    expect(await readFile(ownerPath(served), 'utf8')).not.toContain('models:');
  });

  it('removes the list when the definition sends null, as it does for a description', async () => {
    const served = await withListedAgent();

    const body = await callAs(served.local, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
      definition: definitionOf({ models: null }),
    });

    expect(body.error).toBeUndefined();
    const read = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'researcher' });
    expect(read.result?.['definition']).toMatchObject({ models: null });
  });

  it('keeps the list when the definition sends it back, as a client that read it does', async () => {
    const served = await withListedAgent();
    const got = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'researcher' });
    const definition = got.result?.['definition'] as Record<string, unknown>;
    const { published: _published, ...sent } = definition;

    const body = await callAs(served.local, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
      definition: { ...sent, description: 'Described.' },
    });

    expect(body.error).toBeUndefined();
    const read = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'researcher' });
    expect(read.result?.['definition']).toMatchObject({
      models: [KNOWN_MODEL, OTHER_MODEL],
      description: 'Described.',
    });
  });

  it.each([
    ['an empty list', { models: [] }],
    ['a list that omits the model', { models: [OTHER_MODEL] }],
    ['a repeated entry', { models: [KNOWN_MODEL, OTHER_MODEL, KNOWN_MODEL] }],
    ['an entry that is not <provider>/<name>', { models: [KNOWN_MODEL, 'claude-opus-5'] }],
  ])('refuses %s as InvalidParams, and writes nothing', async (_name, extra) => {
    const served = await withListedAgent();
    const before = await readFile(ownerPath(served), 'utf8');

    const body = await callAs(served.local, 'bureau.agents.definitions.update', {
      id: 'researcher',
      expectedHash: served.hashOf('researcher'),
      definition: definitionOf(extra),
    });

    expect(body.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
    expect(await readFile(ownerPath(served), 'utf8')).toBe(before);
  });
});

describe('bureau.agents.definitions.create', () => {
  it('writes a new agent with its models, and refuses a list that omits the model', async () => {
    const served = await serve();

    const created = await callAs(served.local, 'bureau.agents.definitions.create', {
      id: 'writer',
      definition: { ...DEFINITION, models: [KNOWN_MODEL, OTHER_MODEL] },
    });
    const refused = await callAs(served.local, 'bureau.agents.definitions.create', {
      id: 'editor',
      definition: { ...DEFINITION, models: [OTHER_MODEL] },
    });

    expect(created.error).toBeUndefined();
    const read = await callAs(served.local, 'bureau.agents.definitions.get', { id: 'writer' });
    expect(read.result?.['definition']).toMatchObject({ models: [KNOWN_MODEL, OTHER_MODEL] });
    expect(refused.error?.data).toMatchObject({ weftCode: 'InvalidParams' });
  });
});
