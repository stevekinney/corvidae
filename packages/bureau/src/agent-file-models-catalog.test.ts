/**
 * COR-1559 — a file agent is selectable: its profile offers the models its `models` list names,
 * or the deployment's catalog when it lists none; an entry the catalog lacks is left out rather
 * than failing the file; a change to the list is a change to the file, so the revision rises; and
 * an agent rebuilt from a snapshot keeps the list its run began with.
 */
import { readGenerationProfile } from '@lostgradient/operative';
import { afterEach, describe, expect, it } from 'bun:test';

import { readFileAgentBinding } from './agent-file-catalog';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];

async function start() {
  const fixture = await createAgentFileFixture({ watch: false });
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

function picker(models: string[] | undefined, extra = '') {
  return [
    '---',
    `model: ${KNOWN_MODEL}`,
    ...(models === undefined ? [] : ['models:', ...models.map((entry) => `  - ${entry}`)]),
    '---',
    `You pick.${extra}`,
    '',
  ].join('\n');
}

function profileOf(fixture: AgentFileFixture, id = 'picker') {
  const agent = fixture.catalog.find(id);
  if (agent === undefined) throw new Error(`Expected "${id}" to be ready.`);
  return readGenerationProfile(agent);
}

describe('a file agent’s generation profile', () => {
  it('offers the listed models the catalog holds, and is selectable', async () => {
    const fixture = await start();
    await fixture.put('picker.md', picker([KNOWN_MODEL, 'openai/gpt-4.1']));
    await fixture.catalog.refresh();

    const profile = profileOf(fixture);

    expect(profile.mode).toBe('selectable');
    expect(profile.allowedCandidates).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5-5' },
      { provider: 'openai', model: 'gpt-4.1' },
    ]);
  });

  it('offers the whole catalog when the file lists none, and is selectable', async () => {
    const fixture = await start();
    await fixture.put('picker.md', picker(undefined));
    await fixture.catalog.refresh();

    const profile = profileOf(fixture);

    expect(profile.mode).toBe('selectable');
    expect(profile.allowedCandidates).toEqual(
      fixture.descriptors
        .filter((row) => row.lifecycle !== 'retired')
        .map((row) => ({ provider: row.provider, model: row.model })),
    );
  });

  it('leaves out a listed entry the catalog does not hold, and the file stays ready', async () => {
    const fixture = await start();
    await fixture.put('picker.md', picker([KNOWN_MODEL, 'openai/not-in-the-catalog']));
    await fixture.catalog.refresh();

    expect(fixture.catalog.list().find((listing) => listing.id === 'picker')?.state).toBe('ready');
    expect(profileOf(fixture).allowedCandidates).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5-5' },
    ]);
  });

  it('resolves only its default model when it is built', async () => {
    const fixture = await start();
    await fixture.put('picker.md', picker([KNOWN_MODEL, 'openai/gpt-4.1']));
    await fixture.catalog.refresh();

    expect(fixture.generated.map((row) => row.model)).toEqual(['claude-opus-5-5']);
  });
});

describe('the revision of a file that lists models', () => {
  it('rises when the list changes, as it does for any other change to the file', async () => {
    const fixture = await start();
    await fixture.put('picker.md', picker([KNOWN_MODEL]));
    await fixture.catalog.refresh();
    const before = fixture.catalog.list().find((listing) => listing.id === 'picker');

    await fixture.put('picker.md', picker([KNOWN_MODEL, 'openai/gpt-4.1']));
    await fixture.catalog.refresh();
    const after = fixture.catalog.list().find((listing) => listing.id === 'picker');

    expect(after?.definitionRevision).toBe((before?.definitionRevision ?? 0) + 1);
    expect(profileOf(fixture).revision).toBe(after?.definitionRevision as number);
  });
});

describe('an agent rebuilt from a snapshot', () => {
  it('keeps the list its run began with, not the file’s current one', async () => {
    const fixture = await start();
    await fixture.put('picker.md', picker([KNOWN_MODEL, 'openai/gpt-4.1']));
    await fixture.catalog.refresh();
    const binding = readFileAgentBinding(fixture.catalog.find('picker')!)!;

    // The file is then edited to drop the second model.
    await fixture.put('picker.md', picker([KNOWN_MODEL]));
    await fixture.catalog.refresh();
    const rebuilt = fixture.catalog.agentFromSnapshot(
      { id: 'picker', hash: binding.hash, definition: binding.definition } as never,
      binding.definitionRevision,
    );

    expect(readFileAgentBinding(rebuilt)?.definition.models).toEqual([
      KNOWN_MODEL,
      'openai/gpt-4.1',
    ]);
    expect(readGenerationProfile(rebuilt).allowedCandidates).toEqual([
      { provider: 'anthropic', model: 'claude-opus-5-5' },
      { provider: 'openai', model: 'gpt-4.1' },
    ]);
  });
});

describe('a file whose models make it invalid', () => {
  it('is listed invalid with the entry named, and never runs', async () => {
    const fixture = await start();
    await fixture.put(
      'picker.md',
      agentFileText({ model: KNOWN_MODEL, models: '[openai/gpt-4.1]' }),
    );
    await fixture.catalog.refresh();

    const listing = fixture.catalog.list().find((row) => row.id === 'picker');

    expect(listing?.state).toBe('invalid');
    expect(listing?.problem?.code).toBe('invalid-frontmatter');
    expect(listing?.problem?.issues?.map((issue) => issue.path)).toEqual(['models']);
    expect(fixture.catalog.find('picker')).toBeUndefined();
  });
});
