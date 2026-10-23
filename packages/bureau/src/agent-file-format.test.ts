/**
 * COR-1524 — the agent file format: what a file parses to, how a file that cannot be used is
 * described, and how a write keeps what it does not own.
 */
import { load as loadYaml } from 'js-yaml';
import { describe, expect, it } from 'bun:test';

import {
  agentFileFrontmatterSchema,
  checkAgentIdentifier,
  decodeAgentFile,
  hashAgentFileBytes,
  parseAgentFile,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
  type ParsedAgentFile,
} from './agent-file';

const decoder = new TextDecoder();

function parsed(id: string, text: string): ParsedAgentFile {
  const result = parseAgentFile(id, text);
  if (!result.ok) throw new Error(`Expected "${id}" to parse: ${result.problem.message}`);
  return result.file;
}

const FULL = [
  '---',
  'name: Researcher',
  'description: Finds sources',
  'model: anthropic/claude-sonnet-4-5',
  'tools:',
  '  - lookup-order',
  'skills:',
  '  - id: cite',
  '    name: Cite',
  '    description: Cites sources',
  '    tags: [research]',
  'published: true',
  '---',
  'You are a careful researcher.',
  '',
].join('\n');

describe('parseAgentFile', () => {
  it('parses every frontmatter field and the body', () => {
    const { definition } = parsed('researcher', FULL);
    expect(definition).toEqual({
      name: 'Researcher',
      description: 'Finds sources',
      model: 'anthropic/claude-sonnet-4-5',
      tools: ['lookup-order'],
      skills: [{ id: 'cite', name: 'Cite', description: 'Cites sources', tags: ['research'] }],
      published: true,
      instructions: 'You are a careful researcher.\n',
    });
  });

  it('defaults the name to the identifier, and the rest to nothing', () => {
    const { definition } = parsed('writer', '---\nmodel: openai/gpt-4.1\n---\n');
    expect(definition).toEqual({
      name: 'writer',
      description: null,
      model: 'openai/gpt-4.1',
      tools: [],
      skills: [],
      published: false,
      instructions: '',
    });
  });

  it('keeps a body that holds fences, and Windows line endings', () => {
    const file = parsed('crlf', '---\r\nmodel: a/b\r\n---\r\nline one\r\n---\r\nline two');
    expect(file.definition.instructions).toBe('line one\r\n---\r\nline two');
    expect(file.lineEnding).toBe('\r\n');
  });

  it('reads a date-looking scalar as text, and a tag as an error, not code', () => {
    expect(
      parsed('dated', '---\nmodel: a/b\ndescription: 2026-09-19\n---\n').definition.description,
    ).toBe('2026-09-19');
    const tagged = parseAgentFile('tagged', '---\nmodel: !!js/function "() => 1"\n---\n');
    expect(tagged.ok).toBe(false);
  });

  it('describes a file without frontmatter', () => {
    const result = parseAgentFile('plain', 'Just some text.\n');
    expect(result).toMatchObject({ ok: false, problem: { code: 'missing-frontmatter' } });
    expect(parseAgentFile('open', '---\nmodel: a/b\n')).toMatchObject({
      ok: false,
      problem: { code: 'missing-frontmatter' },
    });
  });

  it('describes YAML that does not parse, with its position', () => {
    const result = parseAgentFile('broken', '---\nmodel: [a\n---\n');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.code).toBe('invalid-yaml');
      expect(result.problem.message).toMatch(/line \d+/);
    }
  });

  it('lists every schema failure', () => {
    const result = parseAgentFile(
      'bad',
      '---\nmodel: 7\ntools: [a, a]\npublished: "yes"\nskills: [{id: x}]\n---\n',
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problem.code).toBe('invalid-frontmatter');
      const paths = result.problem.issues?.map((issue) => issue.path) ?? [];
      expect(paths).toContain('model');
      expect(paths).toContain('tools');
      expect(paths).toContain('published');
      expect(paths.some((path) => path.startsWith('skills'))).toBe(true);
    }
  });

  it('requires a mapping', () => {
    expect(parseAgentFile('list', '---\n- a\n---\n')).toMatchObject({
      ok: false,
      problem: { code: 'invalid-frontmatter' },
    });
  });
});

describe('agentFileFrontmatterSchema', () => {
  it('is exported and allows unknown keys', () => {
    const result = agentFileFrontmatterSchema.safeParse({ model: 'a/b', color: 'blue' });
    expect(result.success).toBe(true);
    expect(agentFileFrontmatterSchema.safeParse({}).success).toBe(false);
  });
});

describe('checkAgentIdentifier', () => {
  it('accepts lowercase words and digits, and refuses the rest', () => {
    for (const good of ['a', 'researcher', 'a-b', 'a1', '0']) {
      expect(checkAgentIdentifier(good), good).toBeUndefined();
    }
    for (const bad of ['', 'Researcher', 'a_b', '-a', 'a-', 'a.b', 'a b', 'é']) {
      expect(checkAgentIdentifier(bad)?.code, bad).toBe('invalid-identifier');
    }
  });
});

describe('hashAgentFileBytes and decodeAgentFile', () => {
  it('hashes exact bytes as lowercase hex', () => {
    expect(hashAgentFileBytes(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('refuses bytes that are not UTF-8', () => {
    expect(decodeAgentFile(new Uint8Array([0xff, 0xfe, 0x00]))).toBeUndefined();
    expect(decodeAgentFile(new TextEncoder().encode('é'))).toBe('é');
  });
});

describe('serializeNewAgentFile', () => {
  it('writes a file that parses back to the same definition', () => {
    const bytes = serializeNewAgentFile({
      name: 'Researcher',
      description: 'Finds: sources',
      model: 'anthropic/claude-sonnet-4-5',
      tools: ['lookup-order'],
      skills: [{ id: 'cite', name: 'Cite', description: 'd', tags: ['t'] }],
      published: true,
      instructions: 'Be careful.\n',
    });
    const file = parsed('researcher', decoder.decode(bytes));
    expect(file.definition).toMatchObject({
      name: 'Researcher',
      description: 'Finds: sources',
      tools: ['lookup-order'],
      published: true,
      instructions: 'Be careful.\n',
    });
  });
});

describe('serializeUpdatedAgentFile', () => {
  const ORIGINAL = [
    '---',
    '# a comment',
    'color: blue',
    'name: Researcher',
    'model: anthropic/claude-sonnet-4-5',
    'metadata:',
    '  owner: someone',
    '---',
    'Body with trailing spaces   ',
    '',
    'and a second paragraph.',
    '',
  ].join('\n');

  it('keeps unknown keys in place and the body byte for byte', () => {
    const existing = parsed('researcher', ORIGINAL);
    const bytes = serializeUpdatedAgentFile('researcher', existing, {
      name: 'Researcher',
      model: 'openai/gpt-4.1',
      instructions: existing.body,
    });
    const next = decoder.decode(bytes);
    const reread = parsed('researcher', next);
    expect(reread.definition.model).toBe('openai/gpt-4.1');
    expect(reread.raw['color']).toBe('blue');
    expect(reread.raw['metadata']).toEqual({ owner: 'someone' });
    expect(Object.keys(reread.raw).indexOf('color')).toBeLessThan(
      Object.keys(reread.raw).indexOf('name'),
    );
    expect(next.endsWith(`---\n${existing.body}`)).toBe(true);
  });

  it('rewrites nothing when nothing changes, and keeps the frontmatter text when only the body does', () => {
    const existing = parsed('researcher', ORIGINAL);
    const same = {
      name: 'Researcher',
      model: 'anthropic/claude-sonnet-4-5',
      instructions: existing.body,
    };
    expect(serializeUpdatedAgentFile('researcher', existing, same)).toBeUndefined();
    const bodyOnly = decoder.decode(
      serializeUpdatedAgentFile('researcher', existing, { ...same, instructions: 'New.\n' }),
    );
    expect(bodyOnly).toBe(ORIGINAL.replace(existing.body, 'New.\n'));
  });

  it('reads the examples a file lists and keeps them through a rewrite and an unchanged write', () => {
    const original = [
      '---',
      'name: Researcher',
      'model: anthropic/claude-sonnet-4-5',
      'examples:',
      '  - Find the latest filing',
      '  - Summarise it',
      '---',
      'Body.',
      '',
    ].join('\n');
    const existing = parsed('researcher', original);
    expect(existing.definition.examples).toEqual(['Find the latest filing', 'Summarise it']);

    // An input never carries them, so a write that changes nothing else writes nothing.
    const same = {
      name: 'Researcher',
      model: 'anthropic/claude-sonnet-4-5',
      instructions: existing.body,
    };
    expect(serializeUpdatedAgentFile('researcher', existing, same)).toBeUndefined();
    // A write that changes the model keeps the list in the file.
    const rewritten = parsed(
      'researcher',
      decoder.decode(serializeUpdatedAgentFile('researcher', existing, { ...same, model: 'a/b' })),
    );
    expect(rewritten.definition.model).toBe('a/b');
    expect(rewritten.definition.examples).toEqual(['Find the latest filing', 'Summarise it']);
  });

  it('has no examples for a file that lists none, and refuses a list that is not text', () => {
    expect('examples' in parsed('a', '---\nmodel: a/b\n---\n').definition).toBe(false);
    for (const value of ['3', '[1]', '[""]', '{ a: b }']) {
      const result = parseAgentFile('a', `---\nmodel: a/b\nexamples: ${value}\n---\n`);
      expect(result.ok, value).toBe(false);
    }
  });

  it('keeps a byte order mark and the line ending', () => {
    const original = '﻿---\r\nmodel: a/b\r\n---\r\nbody';
    const existing = parsed('bom', original);
    const bytes = serializeUpdatedAgentFile('bom', existing, {
      model: 'a/c',
      instructions: 'body',
    });
    const next = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    expect(bytes?.[0]).toBe(0xef);
    expect(next).toBe('\uFEFF---\r\nmodel: a/c\r\n---\r\nbody');
  });
});

describe('an update keeps what other tools read from the keys it does not own', () => {
  const rewrite = (id: string, text: string, model = 'a/changed'): string => {
    const existing = parsed(id, text);
    return decoder.decode(
      serializeUpdatedAgentFile(id, existing, { model, instructions: existing.body }),
    );
  };
  /** What a reader using js-yaml's default schema, as gray-matter does, sees. */
  const defaultRead = (text: string): Record<string, unknown> => {
    const fence = text.indexOf('\n---', 4);
    return loadYaml(text.slice(4, fence)) as Record<string, unknown>;
  };

  it('keeps a quoted date, a quoted number, and a quoted boolean as strings', () => {
    const original = [
      '---',
      'model: a/b',
      "created: '2024-01-01'",
      "version: '1.10'",
      "flag: 'true'",
      "octal: '0o17'",
      '---',
      'Body.',
      '',
    ].join('\n');
    const next = rewrite('quoted', original);
    expect(defaultRead(next)).toMatchObject({
      model: 'a/changed',
      created: '2024-01-01',
      version: '1.10',
      flag: 'true',
      octal: '0o17',
    });
    expect(typeof defaultRead(next)['created']).toBe('string');
  });

  it('keeps an unquoted date a date, and numbers and booleans what they were', () => {
    const original = [
      '---',
      'model: a/b',
      'created: 2024-01-01',
      'count: 3',
      'ratio: 0.5',
      'enabled: true',
      'nothing: null',
      '---',
      'Body.',
      '',
    ].join('\n');
    const read = defaultRead(rewrite('plain', original));
    expect(read['created']).toBeInstanceOf(Date);
    expect(read).toMatchObject({ count: 3, ratio: 0.5, enabled: true, nothing: null });
  });

  it('keeps comments and the formatting of every line it does not own', () => {
    const original = [
      '---',
      '# who made this',
      'author:   Someone   # trailing',
      'model: a/b',
      'tags: [x,   y]',
      'notes: |',
      '  keep',
      '    this',
      '---',
      'Body.',
      '',
    ].join('\n');
    const next = rewrite('formatted', original);
    for (const line of [
      '# who made this',
      'author:   Someone   # trailing',
      'tags: [x,   y]',
      'notes: |',
      '  keep',
      '    this',
    ]) {
      expect(next.split('\n')).toContain(line);
    }
    expect(next).toContain('model: a/changed');
    expect(next).not.toContain('model: a/b');
  });

  it('adds and removes known keys without touching the others', () => {
    const original = [
      '---',
      'model: a/b',
      'extra: 1',
      'tools:',
      '  - one',
      '---',
      'Body.',
      '',
    ].join('\n');
    const existing = parsed('keys', original);
    const next = decoder.decode(
      serializeUpdatedAgentFile('keys', existing, {
        model: 'a/b',
        description: 'Now described',
        instructions: existing.body,
      }),
    );
    const reread = parsed('keys', next);
    expect(reread.definition).toMatchObject({ description: 'Now described', tools: [] });
    expect(reread.raw['extra']).toBe(1);
    expect(reread.raw['tools']).toBeUndefined();
    expect(next.split('\n')).toContain('extra: 1');
  });

  it('re-emits the whole frontmatter, keeping values and types, when a rewrite cannot be verified', () => {
    // A quoted key is one a line edit does not recognise, so appending `model` would duplicate it.
    const original = [
      '---',
      '"model": a/b',
      "created: '2024-01-01'",
      'due: 2024-02-02',
      "meta: {a: 1, b: '2024-01-01'}",
      '---',
      'Body.',
      '',
    ].join('\n');
    const next = rewrite('flow', original);
    const reread = parsed('flow', next);
    expect(reread.definition.model).toBe('a/changed');
    expect(reread.raw['meta']).toEqual({ a: 1, b: '2024-01-01' });
    const read = defaultRead(next);
    expect(read['created']).toBe('2024-01-01');
    expect(read['due']).toBeInstanceOf(Date);
    expect(read['meta']).toEqual({ a: 1, b: '2024-01-01' });
  });
});
