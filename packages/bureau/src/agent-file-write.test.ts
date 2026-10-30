/**
 * COR-1524 — the definition API writes through the same files: a temporary file in the same
 * directory renamed into place, unknown frontmatter keys and the body kept, a typed conflict
 * when the file exists or has changed since it was read.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  AgentFileConflictError,
  AgentFileError,
  hashAgentFileBytes,
  parseAgentFile,
} from './agent-file';
import { type AgentFileOperations, nodeAgentFileOperations } from './sources/agent-file-operations';
import {
  type AgentFileFixture,
  createAgentFileFixture,
  KNOWN_MODEL,
  OTHER_MODEL,
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to reject.');
}

describe('create', () => {
  it('writes through a temporary file in the same directory, renamed into place', async () => {
    const calls: string[] = [];
    const operations: AgentFileOperations = {
      ...nodeAgentFileOperations,
      writeTemporary: (path, bytes) => {
        calls.push(`write ${path}`);
        return nodeAgentFileOperations.writeTemporary(path, bytes);
      },
      rename: (from, to) => {
        calls.push(`rename ${from} -> ${to}`);
        return nodeAgentFileOperations.rename(from, to);
      },
    };
    const fixture = await start({ operations, watch: false });
    const { hash } = await fixture.catalog.create('researcher', {
      model: KNOWN_MODEL,
      instructions: 'Be careful.\n',
    });
    expect(calls).toHaveLength(2);
    const temporary = calls[0]?.slice('write '.length) ?? '';
    expect(temporary.startsWith(join(fixture.directory, '.researcher.md.'))).toBe(true);
    expect(temporary.endsWith('.tmp')).toBe(true);
    expect(calls[1]).toBe(`rename ${temporary} -> ${join(fixture.directory, 'researcher.md')}`);
    const bytes = new Uint8Array(await readFile(join(fixture.directory, 'researcher.md')));
    expect(hashAgentFileBytes(bytes)).toBe(hash);
    expect(await readdir(fixture.directory)).toEqual(['researcher.md']);
  });

  it('makes the agent visible without a restart', async () => {
    const fixture = await start({ watch: false });
    await fixture.catalog.create('researcher', {
      model: KNOWN_MODEL,
      description: 'Finds sources',
      tools: ['lookup-order'],
      instructions: 'Be careful.\n',
    });
    expect(fixture.catalog.list()[0]).toMatchObject({
      id: 'researcher',
      state: 'ready',
      description: 'Finds sources',
    });
  });

  it('creates the directory when it does not exist yet', async () => {
    const fixture = await start({ subdirectory: 'agents', watch: false });
    await fixture.catalog.create('first', { model: KNOWN_MODEL, instructions: '' });
    expect(fixture.catalog.find('first')).toBeDefined();
  });

  it('fails with a typed conflict when the file exists, and leaves it alone', async () => {
    const fixture = await start({ watch: false });
    await fixture.put('taken.md', validAgentFile('Original.\n'));
    const error = await rejection(
      fixture.catalog.create('taken', { model: KNOWN_MODEL, instructions: 'Other.\n' }),
    );
    expect(error).toBeInstanceOf(AgentFileConflictError);
    expect(error).toMatchObject({ code: 'agent-file-exists' });
    expect(await readFile(join(fixture.directory, 'taken.md'), 'utf8')).toContain('Original.');
    const left = await readdir(fixture.directory);
    expect(left.filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });

  it('writes nothing for a definition that would not load', async () => {
    const fixture = await start({ watch: false });
    const cases: Array<[string, Parameters<typeof fixture.catalog.create>, string]> = [
      ['Bad_Name', ['Bad_Name', { model: KNOWN_MODEL, instructions: '' }], 'invalid-identifier'],
      ['no-model', ['no-model', { model: 'anthropic/none', instructions: '' }], 'unknown-model'],
      [
        'no-tool',
        ['no-tool', { model: KNOWN_MODEL, tools: ['refund'], instructions: '' }],
        'unknown-tool',
      ],
      ['alpha', ['alpha', { model: KNOWN_MODEL, instructions: '' }], 'shadows-code-agent'],
      [
        'dup-tools',
        [
          'dup-tools',
          { model: KNOWN_MODEL, tools: ['lookup-order', 'lookup-order'], instructions: '' },
        ],
        'invalid-frontmatter',
      ],
    ];
    for (const [label, args, code] of cases) {
      const error = await rejection(fixture.catalog.create(...args));
      expect(error, label).toBeInstanceOf(AgentFileError);
      expect(error, label).toMatchObject({ code });
    }
    expect(await readdir(fixture.directory)).toEqual([]);
  });
});

describe('update', () => {
  const ORIGINAL = [
    '---',
    '# a comment the rewrite drops',
    'color: blue',
    'name: Researcher',
    `model: ${KNOWN_MODEL}`,
    'metadata:',
    '  owner: someone',
    '---',
    'Body with trailing spaces   ',
    '',
    'and a second paragraph.',
    '',
  ].join('\n');

  it('keeps unknown frontmatter keys and the body byte for byte', async () => {
    const fixture = await start({ watch: false });
    await fixture.put('researcher.md', ORIGINAL);
    await fixture.catalog.refresh();
    const read = await fixture.catalog.read('researcher');
    const body = ORIGINAL.slice(ORIGINAL.indexOf('Body'));
    const { hash } = await fixture.catalog.update(
      'researcher',
      { name: 'Researcher', model: OTHER_MODEL, instructions: body },
      { expectedHash: read?.hash ?? '' },
    );
    const text = await readFile(join(fixture.directory, 'researcher.md'), 'utf8');
    expect(text.endsWith(`---\n${body}`)).toBe(true);
    const parsed = parseAgentFile('researcher', text);
    expect(parsed.ok && parsed.file.raw).toMatchObject({
      color: 'blue',
      metadata: { owner: 'someone' },
      model: OTHER_MODEL,
    });
    const afterwards = await fixture.catalog.read('researcher');
    expect(afterwards?.hash).toBe(hash);
    expect(fixture.catalog.list()[0]?.definitionHash).toBe(hash);
  });

  it('keeps comments and the types of unknown keys when a known key holds a block-style list', async () => {
    const fixture = await start({ watch: false });
    const block = [
      '---',
      '# a comment the line edit keeps',
      'created: 2026-10-18',
      `model: ${KNOWN_MODEL}`,
      'tools:',
      '  - lookup-order',
      '---',
      'Body.',
      '',
    ].join('\n');
    await fixture.put('researcher.md', block);
    await fixture.catalog.refresh();
    const read = await fixture.catalog.read('researcher');
    // A key whose list starts on the next line is a block of its own: it is replaced in place,
    // not appended a second time, and the line edit is not abandoned for a re-emit.
    await fixture.catalog.update(
      'researcher',
      { model: KNOWN_MODEL, tools: [], a2a: true, instructions: 'Body.\n' },
      { expectedHash: read?.hash ?? '' },
    );
    expect(await readFile(join(fixture.directory, 'researcher.md'), 'utf8')).toBe(
      [
        '---',
        '# a comment the line edit keeps',
        'created: 2026-10-18',
        `model: ${KNOWN_MODEL}`,
        'a2a: true',
        '---',
        'Body.',
        '',
      ].join('\n'),
    );
  });

  it('keeps the file’s a2a when an update leaves it out, and adds no a2a key to a file without one', async () => {
    const fixture = await start({ watch: false });
    await fixture.put(
      'on.md',
      `---\nmodel: ${KNOWN_MODEL}\na2a: true\ncreated: 2026-10-18\n---\nBody.\n`,
    );
    await fixture.put('bare.md', `---\nmodel: ${KNOWN_MODEL}\n---\nBody.\n`);
    await fixture.catalog.refresh();
    const on = await fixture.catalog.read('on');
    const bare = await fixture.catalog.read('bare');
    // The body changes and `a2a` is not mentioned: the opt-in stays, and so does everything else.
    await fixture.catalog.update(
      'on',
      { model: KNOWN_MODEL, instructions: 'Changed.\n' },
      { expectedHash: on?.hash ?? '' },
    );
    await fixture.catalog.update(
      'bare',
      { model: KNOWN_MODEL, name: 'Bare', instructions: 'Body.\n' },
      { expectedHash: bare?.hash ?? '' },
    );
    expect(await readFile(join(fixture.directory, 'on.md'), 'utf8')).toBe(
      `---\nmodel: ${KNOWN_MODEL}\na2a: true\ncreated: 2026-10-18\n---\nChanged.\n`,
    );
    expect(await readFile(join(fixture.directory, 'bare.md'), 'utf8')).not.toContain('a2a');
    expect(fixture.catalog.list().map((listing) => [listing.id, listing.a2a])).toEqual([
      ['bare', false],
      ['on', true],
    ]);
    // Saying it turns it off.
    const changed = await fixture.catalog.read('on');
    await fixture.catalog.update(
      'on',
      { model: KNOWN_MODEL, instructions: 'Changed.\n', a2a: false },
      { expectedHash: changed?.hash ?? '' },
    );
    expect(await readFile(join(fixture.directory, 'on.md'), 'utf8')).toContain('a2a: false');
  });

  it('rewrites nothing when nothing changes', async () => {
    const fixture = await start({ watch: false });
    await fixture.put('researcher.md', ORIGINAL);
    await fixture.catalog.refresh();
    const read = await fixture.catalog.read('researcher');
    const body = ORIGINAL.slice(ORIGINAL.indexOf('Body'));
    const result = await fixture.catalog.update(
      'researcher',
      { name: 'Researcher', model: KNOWN_MODEL, instructions: body },
      { expectedHash: read?.hash ?? '' },
    );
    expect(result.hash).toBe(read?.hash ?? '');
    expect(await readFile(join(fixture.directory, 'researcher.md'), 'utf8')).toBe(ORIGINAL);
  });

  it('conflicts when the file changed since it was read', async () => {
    const fixture = await start({ watch: false });
    await fixture.put('researcher.md', ORIGINAL);
    const read = await fixture.catalog.read('researcher');
    await writeFile(join(fixture.directory, 'researcher.md'), `${ORIGINAL}\nedited by hand\n`);
    const error = await rejection(
      fixture.catalog.update(
        'researcher',
        { model: OTHER_MODEL, instructions: '' },
        { expectedHash: read?.hash ?? '' },
      ),
    );
    expect(error).toBeInstanceOf(AgentFileConflictError);
    expect(error).toMatchObject({ code: 'agent-file-changed' });
    const current = await fixture.catalog.read('researcher');
    expect((error as AgentFileConflictError).currentHash).toBe(current?.hash);
    expect(await readFile(join(fixture.directory, 'researcher.md'), 'utf8')).toContain(
      'edited by hand',
    );
  });

  it('conflicts when the file changes after it was read and before it is renamed into place', async () => {
    let reads = 0;
    const operations: AgentFileOperations = {
      ...nodeAgentFileOperations,
      read: async (path) => {
        // The first read of the target is the update's own; the second is its last check before
        // the rename. A hand edit landing between them is what that check exists to catch.
        if (path.endsWith('researcher.md') && (reads += 1) === 2) {
          await writeFile(path, `${ORIGINAL}\nedited between\n`);
        }
        return nodeAgentFileOperations.read(path);
      },
    };
    const fixture = await start({ operations, watch: false });
    await fixture.put('researcher.md', ORIGINAL);
    const read = await fixture.catalog.read('researcher');
    reads = 0;
    const error = await rejection(
      fixture.catalog.update(
        'researcher',
        { model: OTHER_MODEL, instructions: '' },
        { expectedHash: read?.hash ?? '' },
      ),
    );
    expect(error).toMatchObject({ code: 'agent-file-changed' });
    // The losing write cleans up its temporary file and leaves the hand edit in place.
    expect(await readdir(fixture.directory)).toEqual(['researcher.md']);
    expect(await readFile(join(fixture.directory, 'researcher.md'), 'utf8')).toContain(
      'edited between',
    );
  });

  it('refuses a file it cannot read as an agent file, and one that is not there', async () => {
    const fixture = await start({ watch: false });
    await fixture.put('broken.md', 'No frontmatter.\n');
    const broken = await fixture.catalog.read('broken');
    expect(
      await rejection(
        fixture.catalog.update(
          'broken',
          { model: KNOWN_MODEL, instructions: '' },
          { expectedHash: broken?.hash ?? '' },
        ),
      ),
    ).toMatchObject({ code: 'agent-file-unreadable' });
    expect(
      await rejection(
        fixture.catalog.update(
          'missing',
          { model: KNOWN_MODEL, instructions: '' },
          { expectedHash: 'a'.repeat(64) },
        ),
      ),
    ).toMatchObject({ code: 'agent-file-not-found' });
  });

  it('writes nothing for a definition that would not load', async () => {
    const fixture = await start({ watch: false });
    await fixture.put('researcher.md', ORIGINAL);
    const read = await fixture.catalog.read('researcher');
    expect(
      await rejection(
        fixture.catalog.update(
          'researcher',
          { model: 'anthropic/none', instructions: '' },
          { expectedHash: read?.hash ?? '' },
        ),
      ),
    ).toMatchObject({ code: 'unknown-model' });
    expect(await readFile(join(fixture.directory, 'researcher.md'), 'utf8')).toBe(ORIGINAL);
  });
});

describe('delete', () => {
  it('removes the file when the hash matches', async () => {
    const fixture = await start({ watch: false });
    await fixture.put('one.md', validAgentFile());
    const read = await fixture.catalog.read('one');
    await fixture.catalog.delete('one', { expectedHash: read?.hash ?? '' });
    expect(await readdir(fixture.directory)).toEqual([]);
    expect(fixture.catalog.list()).toEqual([]);
  });

  it('conflicts when the file changed since it was read, and when it is not there', async () => {
    const fixture = await start({ watch: false });
    await fixture.put('one.md', validAgentFile());
    const read = await fixture.catalog.read('one');
    await fixture.put('one.md', validAgentFile('Changed.\n'));
    expect(
      await rejection(fixture.catalog.delete('one', { expectedHash: read?.hash ?? '' })),
    ).toBeInstanceOf(AgentFileConflictError);
    expect(await readdir(fixture.directory)).toEqual(['one.md']);
    expect(
      await rejection(fixture.catalog.delete('gone', { expectedHash: 'a'.repeat(64) })),
    ).toMatchObject({ code: 'agent-file-not-found' });
  });
});

describe('read', () => {
  it('returns the text and hash, or nothing', async () => {
    const fixture = await start({ watch: false });
    await fixture.put('one.md', validAgentFile());
    const read = await fixture.catalog.read('one');
    expect(read?.text).toBe(validAgentFile());
    expect(await fixture.catalog.read('two')).toBeUndefined();
  });
});
