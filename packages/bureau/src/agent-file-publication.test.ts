/**
 * COR-1526 — the catalog reads the operations are built on (`detail`, `tools`) and publication:
 * `publish` and `withdraw` set `published` in the frontmatter and nothing else, and fail as every
 * other guarded write does.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { AGENT_FILE_SIZE_LIMIT, AgentFileConflictError, hashAgentFileBytes } from './agent-file';
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject.');
}

const TOLERANT = [
  '---',
  '# a comment that stays',
  'created: 2026-10-18',
  `model: ${KNOWN_MODEL}`,
  'tools:',
  '  - lookup-order',
  '---',
  '  Body kept   ',
  '',
  'second paragraph.',
  '',
].join('\n');

describe('detail', () => {
  it('describes a file with the hash and exact text it was read from, and what they parse to', async () => {
    const fixture = await start();
    await fixture.put('researcher.md', TOLERANT);
    await fixture.catalog.refresh();
    const detail = await fixture.catalog.detail('researcher');
    expect(detail).toMatchObject({
      id: 'researcher',
      source: 'file',
      state: 'ready',
      name: 'researcher',
      published: false,
      text: TOLERANT,
      definitionHash: hashAgentFileBytes(new TextEncoder().encode(TOLERANT)),
      definition: {
        name: 'researcher',
        model: KNOWN_MODEL,
        tools: ['lookup-order'],
        instructions: '  Body kept   \n\nsecond paragraph.\n',
      },
    });
  });

  it('describes the file as it is on disk now, so a hash it returns is one a write can be made against', async () => {
    const fixture = await start();
    await fixture.put('researcher.md', validAgentFile('First.\n'));
    await fixture.catalog.refresh();
    const stale = fixture.catalog.list()[0]?.definitionHash;
    await fixture.put('researcher.md', validAgentFile('Second.\n'));
    const detail = await fixture.catalog.detail('researcher');
    expect(detail?.definitionHash).not.toBe(stale);
    expect(detail?.text).toContain('Second.');
    expect(detail?.definition?.instructions).toBe('Second.\n');
    const written = await fixture.catalog.update(
      'researcher',
      { model: KNOWN_MODEL, name: 'Helper', instructions: 'Third.\n' },
      { expectedHash: detail?.definitionHash ?? '' },
    );
    expect(written.hash).not.toBe(detail?.definitionHash);
  });

  it('keeps the state of a file that cannot run beside its text and, when it parses, its definition', async () => {
    const fixture = await start();
    const wrongModel = agentFileText({ model: 'anthropic/none' }, 'Body.\n');
    await fixture.put('wrong-model.md', wrongModel);
    await fixture.put('no-frontmatter.md', 'Just text.\n');
    await fixture.catalog.refresh();
    expect(await fixture.catalog.detail('wrong-model')).toMatchObject({
      state: 'invalid',
      problem: { code: 'unknown-model' },
      text: wrongModel,
      definition: { model: 'anthropic/none' },
    });
    expect(await fixture.catalog.detail('no-frontmatter')).toMatchObject({
      state: 'invalid',
      problem: { code: 'missing-frontmatter' },
      text: 'Just text.\n',
      definition: null,
    });
  });

  it('has no text for a file that is too large, and no detail for an identifier no file has', async () => {
    const fixture = await start();
    await fixture.put('large.md', `${validAgentFile()}${'x'.repeat(AGENT_FILE_SIZE_LIMIT)}`);
    await fixture.catalog.refresh();
    expect(await fixture.catalog.detail('large')).toMatchObject({
      state: 'invalid',
      problem: { code: 'file-too-large' },
      text: null,
      definition: null,
    });
    expect(await fixture.catalog.detail('never-existed')).toBeUndefined();
    expect(await fixture.catalog.detail('Bad_Name')).toBeUndefined();
  });
});

describe('tools', () => {
  it('lists the tool catalog by the name an agent file uses, with each description', async () => {
    const fixture = await start();
    expect(fixture.catalog.tools()).toEqual([
      { name: 'lookup-order', description: 'Looks an order up' },
    ]);
  });
});

describe('publish and withdraw', () => {
  it('set published and keep every other key, the comments, and the body byte for byte', async () => {
    const fixture = await start();
    await fixture.put('researcher.md', TOLERANT);
    await fixture.catalog.refresh();
    const hash = fixture.catalog.list()[0]?.definitionHash ?? '';
    const published = await fixture.catalog.publish('researcher', { expectedHash: hash });
    const text = await readFile(join(fixture.directory, 'researcher.md'), 'utf8');
    expect(text).toBe(TOLERANT.replace('\n---\n  Body', '\npublished: true\n---\n  Body'));
    expect(text).not.toContain('name:');
    expect(fixture.catalog.list()[0]).toMatchObject({ published: true });

    const withdrawn = await fixture.catalog.withdraw('researcher', {
      expectedHash: published.hash,
    });
    expect(await readFile(join(fixture.directory, 'researcher.md'), 'utf8')).toBe(
      TOLERANT.replace('\n---\n  Body', '\npublished: false\n---\n  Body'),
    );
    expect(withdrawn.hash).toBe(fixture.catalog.list()[0]?.definitionHash ?? '');
    expect(fixture.catalog.list()[0]).toMatchObject({ published: false });
  });

  it('keep a name, a description, tools, and skills the file has, exactly', async () => {
    const fixture = await start();
    const original = [
      '---',
      'name: Researcher',
      'description: Finds sources',
      `model: ${KNOWN_MODEL}`,
      'tools: [lookup-order]',
      'skills:',
      '  - id: cite',
      '    name: Cite',
      '    description: Cites',
      '    tags: [research]',
      '    examples: [one]',
      '---',
      'Body.',
      '',
    ].join('\n');
    await fixture.put('researcher.md', original);
    await fixture.catalog.refresh();
    await fixture.catalog.publish('researcher', {
      expectedHash: fixture.catalog.list()[0]?.definitionHash ?? '',
    });
    expect(await readFile(join(fixture.directory, 'researcher.md'), 'utf8')).toBe(
      original.replace('---\nBody', 'published: true\n---\nBody'),
    );
  });

  it('write nothing, and return the file’s own hash, when the file already has the state', async () => {
    const fixture = await start();
    await fixture.put('on.md', agentFileText({ model: KNOWN_MODEL, published: 'true' }, 'Body.\n'));
    await fixture.put('off.md', validAgentFile());
    await fixture.catalog.refresh();
    const [off, on] = fixture.catalog.list();
    const before = new Map<string, string>();
    for (const name of ['on.md', 'off.md']) {
      before.set(name, await readFile(join(fixture.directory, name), 'utf8'));
    }
    const publishedAgain = await fixture.catalog.publish('on', {
      expectedHash: on?.definitionHash ?? '',
    });
    const withdrawnAgain = await fixture.catalog.withdraw('off', {
      expectedHash: off?.definitionHash ?? '',
    });
    expect(publishedAgain.hash).toBe(on?.definitionHash ?? '');
    expect(withdrawnAgain.hash).toBe(off?.definitionHash ?? '');
    for (const [name, text] of before) {
      expect(await readFile(join(fixture.directory, name), 'utf8')).toBe(text);
    }
    expect((await readdir(fixture.directory)).toSorted()).toEqual(['off.md', 'on.md']);
  });

  it('conflict, with the hash on disk, when the file changed since it was read, and write nothing', async () => {
    const fixture = await start();
    await fixture.put('researcher.md', validAgentFile('First.\n'));
    await fixture.catalog.refresh();
    const stale = fixture.catalog.list()[0]?.definitionHash ?? '';
    const edited = validAgentFile('Edited by hand.\n');
    await fixture.put('researcher.md', edited);
    for (const act of [fixture.catalog.publish, fixture.catalog.withdraw]) {
      const error = await rejection(act('researcher', { expectedHash: stale }));
      expect(error).toBeInstanceOf(AgentFileConflictError);
      expect(error).toMatchObject({
        code: 'agent-file-changed',
        currentHash: hashAgentFileBytes(new TextEncoder().encode(edited)),
      });
    }
    expect(await readFile(join(fixture.directory, 'researcher.md'), 'utf8')).toBe(edited);
  });

  it('are refused for a file that is not there, one that cannot be read, and one that would not load', async () => {
    const fixture = await start();
    await fixture.put('no-frontmatter.md', 'Just text.\n');
    await fixture.put('wrong-model.md', agentFileText({ model: 'anthropic/none' }));
    await fixture.catalog.refresh();
    const hashOf = (id: string) =>
      fixture.catalog.list().find((listing) => listing.id === id)?.definitionHash ?? '';
    expect(
      await rejection(fixture.catalog.publish('missing', { expectedHash: 'a'.repeat(64) })),
    ).toMatchObject({ code: 'agent-file-not-found' });
    expect(
      await rejection(
        fixture.catalog.publish('no-frontmatter', { expectedHash: hashOf('no-frontmatter') }),
      ),
    ).toMatchObject({ code: 'agent-file-unreadable' });
    expect(
      await rejection(
        fixture.catalog.publish('wrong-model', { expectedHash: hashOf('wrong-model') }),
      ),
    ).toMatchObject({ code: 'unknown-model' });
    expect(await readFile(join(fixture.directory, 'wrong-model.md'), 'utf8')).toBe(
      agentFileText({ model: 'anthropic/none' }),
    );
  });
});
