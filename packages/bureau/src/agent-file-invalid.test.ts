/**
 * COR-1524 — a file that cannot be used is listed as `invalid` with a typed problem, never runs,
 * and leaves every other agent working. One test per way a file can be unusable that the
 * criterion names, then the rest.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];

async function start(options?: Parameters<typeof createAgentFileFixture>[0]) {
  const fixture = await createAgentFileFixture({ watch: false, ...options });
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

/** The listing for `id` after a rescan, with a healthy sibling that must keep working. */
async function listingWithSibling(
  fixture: AgentFileFixture,
  name: string,
  text: string | Uint8Array,
) {
  await fixture.put('healthy.md', validAgentFile());
  await fixture.put(name, text);
  await fixture.catalog.refresh();
  const id = name.slice(0, -'.md'.length);
  const listing = fixture.catalog.list().find((entry) => entry.id === id);
  expect(fixture.catalog.find(id)).toBeUndefined();
  expect(fixture.catalog.find('healthy')).toBeDefined();
  expect(fixture.catalog.list().find((entry) => entry.id === 'healthy')?.state).toBe('ready');
  return listing;
}

describe('an agent file that cannot be used', () => {
  it('is invalid for a bad filename', async () => {
    const listing = await listingWithSibling(await start(), 'Bad_Name.md', validAgentFile());
    expect(listing).toMatchObject({ state: 'invalid', problem: { code: 'invalid-identifier' } });
  });

  it('is invalid for invalid frontmatter', async () => {
    const listing = await listingWithSibling(
      await start(),
      'broken.md',
      agentFileText({ model: KNOWN_MODEL, published: '"yes"', tools: '[a, a]' }),
    );
    expect(listing).toMatchObject({ state: 'invalid', problem: { code: 'invalid-frontmatter' } });
    expect(listing?.problem?.issues?.map((issue) => issue.path)).toEqual(
      expect.arrayContaining(['published', 'tools']),
    );
  });

  it('is invalid for a model missing from the model catalog', async () => {
    const fixture = await start();
    const listing = await listingWithSibling(
      fixture,
      'lost.md',
      agentFileText({ model: 'anthropic/no-such-model' }),
    );
    expect(listing).toMatchObject({ state: 'invalid', problem: { code: 'unknown-model' } });
    // A model that is written without its provider is not a catalog model either.
    await fixture.put('bare.md', agentFileText({ model: 'claude-opus-5-5' }));
    await fixture.catalog.refresh();
    expect(fixture.catalog.list().find((entry) => entry.id === 'bare')?.problem?.code).toBe(
      'unknown-model',
    );
  });

  it('is invalid for a tool missing from the tool catalog', async () => {
    const listing = await listingWithSibling(
      await start(),
      'toolless.md',
      agentFileText({ model: KNOWN_MODEL, tools: '[lookup-order, refund-order]' }),
    );
    expect(listing).toMatchObject({ state: 'invalid', problem: { code: 'unknown-tool' } });
    expect(listing?.problem?.message).toContain('refund-order');
    expect(listing?.problem?.message).not.toContain('"lookup-order"');
  });

  it('is invalid for a stem that matches a code-defined key', async () => {
    const listing = await listingWithSibling(await start(), 'alpha.md', validAgentFile());
    expect(listing).toMatchObject({ state: 'invalid', problem: { code: 'shadows-code-agent' } });
  });

  it('cannot take the name of the default agent', async () => {
    const listing = await listingWithSibling(await start(), 'bureau.md', validAgentFile());
    expect(listing?.problem?.code).toBe('shadows-code-agent');
  });

  it('is invalid without frontmatter, with YAML that does not parse, and with bytes that are not text', async () => {
    const fixture = await start();
    await fixture.put('healthy.md', validAgentFile());
    await fixture.put('plain.md', 'No frontmatter here.\n');
    await fixture.put('yaml.md', '---\nmodel: [a\n---\n');
    await fixture.put('binary.md', new Uint8Array([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0xfe]));
    await fixture.catalog.refresh();
    const byId = Object.fromEntries(fixture.catalog.list().map((entry) => [entry.id, entry]));
    expect(byId['plain']?.problem?.code).toBe('missing-frontmatter');
    expect(byId['yaml']?.problem?.code).toBe('invalid-yaml');
    expect(byId['binary']?.problem?.code).toBe('not-utf8');
    expect(byId['healthy']?.state).toBe('ready');
  });

  it('is invalid when it is larger than an agent file may be', async () => {
    const fixture = await start();
    await fixture.put('huge.md', `${validAgentFile()}${'x'.repeat(300 * 1024)}`);
    await fixture.catalog.refresh();
    expect(fixture.catalog.list()[0]?.problem?.code).toBe('file-too-large');
  });

  it('never gets an agent built, so it can never run', async () => {
    const fixture = await start();
    await fixture.put('lost.md', agentFileText({ model: 'anthropic/no-such-model' }));
    await fixture.catalog.refresh();
    expect(fixture.generated).toEqual([]);
    expect(fixture.catalog.find('lost')).toBeUndefined();
  });
});
