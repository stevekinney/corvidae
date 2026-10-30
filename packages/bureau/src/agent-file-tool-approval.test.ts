/**
 * COR-1913 — an agent file's `toolApproval`: what it accepts, how a write keeps it, that a name
 * outside `tools` makes the file unusable (`unknown-approval-tool`) on a scan and on a write, and
 * that a stored definition from before the key loads.
 */
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  AgentFileError,
  agentFileDefinitionSchema,
  parseAgentFile,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
  type ParsedAgentFile,
} from './agent-file';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
} from './testing/agent-file-fixtures.test-support';

const decoder = new TextDecoder();

function parsed(text: string): ParsedAgentFile {
  const result = parseAgentFile('helper', text);
  if (!result.ok) throw new Error(`Expected the file to parse: ${result.problem.message}`);
  return result.file;
}

/** The field paths a file's `invalid-frontmatter` problem names, or `undefined` if it parses. */
function issuePaths(frontmatter: string): string[] | undefined {
  const result = parseAgentFile('helper', `---\nmodel: a/b\n${frontmatter}\n---\n`);
  if (result.ok) return undefined;
  expect(result.problem.code).toBe('invalid-frontmatter');
  return result.problem.issues?.map((issue) => issue.path);
}

describe('toolApproval in the frontmatter', () => {
  it('parses each value, and a file without the key has none', () => {
    const file = parsed(
      '---\nmodel: a/b\ntools: [a, b, c, d]\ntoolApproval:\n  a: never\n  b: on-changes\n  c: always\n  d: blocked\n---\n',
    );
    expect(file.definition.toolApproval).toEqual({
      a: 'never',
      b: 'on-changes',
      c: 'always',
      d: 'blocked',
    });
    expect(Object.hasOwn(parsed('---\nmodel: a/b\n---\n').definition, 'toolApproval')).toBe(false);
    expect(
      Object.hasOwn(parsed('---\nmodel: a/b\ntoolApproval:\n---\n').definition, 'toolApproval'),
    ).toBe(false);
    expect(
      Object.hasOwn(parsed('---\nmodel: a/b\ntoolApproval: {}\n---\n').definition, 'toolApproval'),
    ).toBe(false);
  });

  it('holds the names in alphabetical order whatever order the file wrote', () => {
    const file = parsed(
      '---\nmodel: a/b\ntools: [b, a]\ntoolApproval: { b: always, a: never }\n---\n',
    );
    expect(Object.keys(file.definition.toolApproval ?? {})).toEqual(['a', 'b']);
  });

  it('names the field of a value it refuses', () => {
    expect(issuePaths('toolApproval: { a: sometimes }')).toEqual(['toolApproval.a']);
    expect(issuePaths('toolApproval: { a: deny }')).toEqual(['toolApproval.a']);
    expect(issuePaths('toolApproval: { a: true }')).toEqual(['toolApproval.a']);
    expect(issuePaths('toolApproval: { a: never, b: nope }')).toEqual(['toolApproval.b']);
    expect(issuePaths('toolApproval: 5')).toEqual(['toolApproval']);
    expect(issuePaths('toolApproval: [never]')).toEqual(['toolApproval']);
  });

  it('does not take a name that is also an Object.prototype member for a name with a value', () => {
    // `constructor` is a name like any other: no inherited value stands for it.
    const file = parsed(
      '---\nmodel: a/b\ntools: [constructor]\ntoolApproval: { constructor: always }\n---\n',
    );
    expect(Object.entries(file.definition.toolApproval ?? {})).toEqual([['constructor', 'always']]);
  });
});

describe('writing toolApproval', () => {
  it('writes a new file that parses back to the same map, in alphabetical order', () => {
    const text = decoder.decode(
      serializeNewAgentFile({
        model: 'a/b',
        tools: ['b', 'a'],
        toolApproval: { b: 'blocked', a: 'never' },
        instructions: 'Body.\n',
      }),
    );
    expect(text).toContain('toolApproval:');
    expect(text.indexOf('a: never')).toBeLessThan(text.indexOf('b: blocked'));
    expect(parsed(text).definition.toolApproval).toEqual({ a: 'never', b: 'blocked' });
  });

  it('writes no key when the definition sets none, or an empty map', () => {
    expect(
      decoder.decode(serializeNewAgentFile({ model: 'a/b', instructions: 'Body.\n' })),
    ).not.toContain('toolApproval');
    expect(
      decoder.decode(
        serializeNewAgentFile({ model: 'a/b', toolApproval: {}, instructions: 'Body.\n' }),
      ),
    ).not.toContain('toolApproval');
  });

  it('keeps the map when an update leaves it out, and adds none to a file without one', () => {
    const file = parsed(
      '---\nmodel: a/b\ntools: [a]\ntoolApproval: { a: always }\ncolor: blue\n---\nBody.\n',
    );
    const kept = decoder.decode(
      serializeUpdatedAgentFile('helper', file, {
        model: 'a/b',
        tools: ['a'],
        name: 'Named',
        instructions: 'Body.\n',
      }),
    );
    expect(parsed(kept).definition).toMatchObject({ name: 'Named', toolApproval: { a: 'always' } });
    expect(kept).toContain('color: blue');

    const bare = parsed('---\nmodel: a/b\n---\nBody.\n');
    const renamed = decoder.decode(
      serializeUpdatedAgentFile('helper', bare, {
        model: 'a/b',
        name: 'Named',
        instructions: 'Body.\n',
      }),
    );
    expect(renamed).not.toContain('toolApproval');
  });

  it('changes a map the update states, and removes one the update sets to null or empty', () => {
    const file = parsed('---\nmodel: a/b\ntools: [a]\ntoolApproval: { a: never }\n---\nBody.\n');
    const changed = parsed(
      decoder.decode(
        serializeUpdatedAgentFile('helper', file, {
          model: 'a/b',
          tools: ['a'],
          toolApproval: { a: 'blocked' },
          instructions: 'Body.\n',
        }),
      ),
    );
    expect(changed.definition.toolApproval).toEqual({ a: 'blocked' });

    for (const toolApproval of [null, {}]) {
      const removed = decoder.decode(
        serializeUpdatedAgentFile('helper', changed, {
          model: 'a/b',
          tools: ['a'],
          toolApproval,
          instructions: 'Body.\n',
        }),
      );
      expect(removed).not.toContain('toolApproval');
      expect(parsed(removed).definition).not.toHaveProperty('toolApproval');
    }
  });

  it('rewrites nothing when the update states the map the file has, in any order', () => {
    const file = parsed(
      '---\nmodel: a/b\ntools: [a, b]\ntoolApproval: { b: always, a: never }\n---\nBody.\n',
    );
    expect(
      serializeUpdatedAgentFile('helper', file, {
        model: 'a/b',
        tools: ['a', 'b'],
        toolApproval: { a: 'never', b: 'always' },
        instructions: 'Body.\n',
      }),
    ).toBeUndefined();
  });
});

describe('a stored definition', () => {
  const OLD_SNAPSHOT = {
    name: 'Helper',
    description: null,
    model: KNOWN_MODEL,
    tools: [],
    skillDescriptors: [],
    a2a: false,
    instructions: 'Recorded.\n',
  };

  it('loads when it was written before the field existed', () => {
    expect(agentFileDefinitionSchema.parse(OLD_SNAPSHOT).toolApproval).toBeUndefined();
  });

  it('keeps a map when it has one, and refuses a value that is not a mode', () => {
    expect(
      agentFileDefinitionSchema.parse({ ...OLD_SNAPSHOT, toolApproval: { a: 'always' } }),
    ).toMatchObject({ toolApproval: { a: 'always' } });
    expect(
      agentFileDefinitionSchema.safeParse({ ...OLD_SNAPSHOT, toolApproval: { a: 'sometimes' } })
        .success,
    ).toBe(false);
  });
});

describe('a name that tools does not list', () => {
  const fixtures: AgentFileFixture[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
  });

  async function start() {
    const fixture = await createAgentFileFixture({ watch: false });
    fixtures.push(fixture);
    return fixture;
  }

  it('is usable when every name is one of tools', async () => {
    const fixture = await start();
    await fixture.put(
      'helper.md',
      agentFileText({
        model: KNOWN_MODEL,
        tools: '[lookup-order]',
        toolApproval: '{ lookup-order: never }',
      }),
    );
    await fixture.catalog.refresh();
    expect(fixture.catalog.list().find((listing) => listing.id === 'helper')?.state).toBe('ready');
  });

  it('makes the file invalid with unknown-approval-tool, naming each tool, and still shows its definition', async () => {
    const fixture = await start();
    await fixture.put(
      'helper.md',
      agentFileText({
        model: KNOWN_MODEL,
        tools: '[lookup-order]',
        toolApproval: '{ lookup-order: never, refund: always, ghost: blocked }',
      }),
    );
    await fixture.catalog.refresh();

    const listing = fixture.catalog.list().find((entry) => entry.id === 'helper');
    expect(listing?.state).toBe('invalid');
    expect(listing?.problem?.code).toBe('unknown-approval-tool');
    expect(listing?.problem?.message).toContain('"refund"');
    expect(listing?.problem?.message).toContain('"ghost"');
    expect(listing?.problem?.issues?.map((issue) => issue.path)).toEqual([
      'toolApproval.ghost',
      'toolApproval.refund',
    ]);
    // An editor can read the file it has to fix.
    const detail = await fixture.catalog.detail('helper');
    expect(detail?.definition?.toolApproval).toMatchObject({ ghost: 'blocked' });
  });

  it('is not the same problem as a tool the deployment lacks', async () => {
    const fixture = await start();
    await fixture.put(
      'helper.md',
      agentFileText({
        model: KNOWN_MODEL,
        tools: '[nowhere]',
        toolApproval: '{ nowhere: never }',
      }),
    );
    await fixture.catalog.refresh();
    expect(fixture.catalog.list().find((entry) => entry.id === 'helper')?.problem?.code).toBe(
      'unknown-tool',
    );
  });

  it('refuses a write that names one, and writes nothing', async () => {
    const fixture = await start();
    const error = await rejectionOf(
      fixture.catalog.create('helper', {
        model: KNOWN_MODEL,
        tools: ['lookup-order'],
        toolApproval: { refund: 'always' },
        instructions: 'Hi.\n',
      }),
    );
    expect(error).toBeInstanceOf(AgentFileError);
    expect((error as AgentFileError).code).toBe('unknown-approval-tool');
    expect(fixture.catalog.list().find((listing) => listing.id === 'helper')).toBeUndefined();
  });

  it('refuses an update that drops the tool an entry still names', async () => {
    const fixture = await start();
    await fixture.put(
      'helper.md',
      agentFileText({
        model: KNOWN_MODEL,
        tools: '[lookup-order]',
        toolApproval: '{ lookup-order: always }',
      }),
    );
    await fixture.catalog.refresh();
    const hash =
      fixture.catalog.list().find((listing) => listing.id === 'helper')?.definitionHash ?? '';

    const error = await rejectionOf(
      fixture.catalog.update(
        'helper',
        { model: KNOWN_MODEL, tools: [], instructions: 'You are helpful.\n' },
        { expectedHash: hash },
      ),
    );
    // The update omits `toolApproval`, so the file's entry is kept, and the tool is gone.
    expect((error as AgentFileError).code).toBe('unknown-approval-tool');
  });
});

describe('restoring a version', () => {
  const fixtures: AgentFileFixture[] = [];
  afterEach(async () => {
    for (const fixture of fixtures.splice(0)) await fixture.dispose();
  });

  it('removes the map a version that never had one lacks, and lists the key a save changed', async () => {
    const fixture = await createAgentFileFixture({ watch: false });
    fixtures.push(fixture);
    await fixture.put('helper.md', agentFileText({ name: 'Helper', model: KNOWN_MODEL }));
    await fixture.catalog.refresh();
    const hash = () =>
      fixture.catalog.list().find((listing) => listing.id === 'helper')?.definitionHash ?? '';
    await fixture.catalog.update(
      'helper',
      {
        name: 'Helper',
        model: KNOWN_MODEL,
        tools: ['lookup-order'],
        toolApproval: { 'lookup-order': 'always' },
        instructions: 'You are helpful.\n',
      },
      { expectedHash: hash() },
    );
    const [latest] = await fixture.catalog.versions.list('helper');
    expect(latest?.changedKeys).toContain('toolApproval');
    const updated = await fixture.catalog.detail('helper');
    expect(updated?.definition?.toolApproval).toEqual({ 'lookup-order': 'always' });

    await fixture.catalog.versions.restore('helper', 1, { expectedHash: hash() });

    const restored = await fixture.catalog.detail('helper');
    expect(restored?.definition).not.toHaveProperty('toolApproval');
  });
});
