/**
 * COR-1524 — which files in the agent directory are agents, how they are identified, and what the
 * catalog reports about them.
 */
import { mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import { readFileAgentBinding } from './agent-file-catalog';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];

async function start(options?: Parameters<typeof createAgentFileFixture>[0]) {
  const fixture = await createAgentFileFixture(options);
  fixtures.push(fixture);
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

describe('loading the agent directory', () => {
  it('loads every .md file and ignores dotfiles, other extensions, and directories', async () => {
    const { catalog, put, directory } = await start({ watch: false });
    await put('researcher.md', validAgentFile());
    await put('writer.md', validAgentFile());
    await put('.hidden.md', validAgentFile());
    await put('notes.txt', validAgentFile());
    await put('upper.MD', validAgentFile());
    await put('readme.markdown', validAgentFile());
    await mkdir(join(directory, 'folder.md'));
    await catalog.refresh();
    expect(catalog.list().map((listing) => listing.id)).toEqual(['researcher', 'writer']);
  });

  it('follows a symbolic link to a file', async () => {
    const { catalog, put, directory } = await start({ watch: false });
    await put('real.md', validAgentFile());
    await symlink(join(directory, 'real.md'), join(directory, 'linked.md'));
    await catalog.refresh();
    expect(catalog.list().map((listing) => listing.id)).toEqual(['linked', 'real']);
  });

  it('takes the identifier from the filename and the display label from the frontmatter', async () => {
    const { catalog, put } = await start({ watch: false });
    await put('researcher.md', agentFileText({ name: 'Dr. Researcher', model: KNOWN_MODEL }));
    await put('plain.md', agentFileText({ model: KNOWN_MODEL }));
    await catalog.refresh();
    const [plain, researcher] = catalog.list();
    expect(researcher).toMatchObject({ id: 'researcher', name: 'Dr. Researcher', state: 'ready' });
    expect(plain).toMatchObject({ id: 'plain', name: 'plain', state: 'ready' });
  });

  it('lists the description, the published flag, the hash, and the owner of record', async () => {
    const { catalog, put } = await start({ watch: false });
    const text = agentFileText({
      model: KNOWN_MODEL,
      description: 'Finds sources',
      published: 'true',
    });
    await put('researcher.md', text);
    await catalog.refresh();
    const [listing] = catalog.list();
    expect(listing).toMatchObject({
      id: 'researcher',
      source: 'file',
      state: 'ready',
      description: 'Finds sources',
      published: true,
      owner: 'anonymous:local',
    });
    expect(listing?.definitionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(listing && 'problem' in listing).toBe(false);
  });

  it('gives a file no owner field: an owner key is just an unknown key', async () => {
    const { catalog, put } = await start({ watch: false });
    await put('mine.md', agentFileText({ model: KNOWN_MODEL, owner: 'someone-else' }));
    await catalog.refresh();
    expect(catalog.list()[0]).toMatchObject({ state: 'ready', owner: 'anonymous:local' });
  });

  it('builds a runnable agent from the file, with its tools, skills, and instructions', async () => {
    const { catalog, put } = await start({ watch: false });
    await put(
      'researcher.md',
      [
        '---',
        `model: ${KNOWN_MODEL}`,
        'description: Finds sources',
        'tools: [lookup-order]',
        'skills:',
        '  - {id: cite, name: Cite, description: Cites, tags: [research]}',
        '---',
        'Be careful.',
        '',
      ].join('\n'),
    );
    await catalog.refresh();
    const agent = catalog.find('researcher');
    expect(agent).toBeDefined();
    expect(agent?.name).toBe('researcher');
    expect(agent?.description).toBe('Finds sources');
    expect(agent?.skillDescriptors?.map((skill) => skill.id)).toEqual(['cite']);
    expect(readFileAgentBinding(agent as object)).toMatchObject({
      id: 'researcher',
      definition: { instructions: 'Be careful.\n', tools: ['lookup-order'] },
    });
  });

  it('resolves the model through the host, by provider and model', async () => {
    const { catalog, put, generated } = await start({ watch: false });
    await put('one.md', validAgentFile());
    await catalog.refresh();
    expect(generated.map((descriptor) => `${descriptor.provider}/${descriptor.model}`)).toEqual([
      KNOWN_MODEL,
    ]);
  });

  it('is an empty catalog when the directory does not exist', async () => {
    const { catalog } = await start({ subdirectory: 'agents', watch: false });
    await catalog.refresh();
    expect(catalog.list()).toEqual([]);
  });

  it('keeps the object of an agent whose file did not change across a rescan', async () => {
    const { catalog, put } = await start({ watch: false });
    await put('one.md', validAgentFile());
    await catalog.refresh();
    const first = catalog.find('one');
    await catalog.refresh();
    expect(catalog.find('one')).toBe(first);
  });
});
