/**
 * COR-1866 — an agent file's `references` and `compaction` keys as a format: what they accept, how
 * a write keeps them, and that a definition stored before they existed still loads.
 */
import { describe, expect, it } from 'bun:test';

import {
  agentFileDefinitionSchema,
  agentReferencePathProblem,
  parseAgentFile,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
  type ParsedAgentFile,
} from './agent-file';
import { KNOWN_MODEL } from './testing/agent-file-fixtures.test-support';

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

describe('references in the frontmatter', () => {
  it('parses a list of paths in the order written, and a file without the key has none', () => {
    const { definition } = parsed(
      '---\nmodel: a/b\nreferences: [docs/style.md, glossary.txt]\n---\n',
    );
    expect(definition.references).toEqual(['docs/style.md', 'glossary.txt']);
    expect(Object.hasOwn(parsed('---\nmodel: a/b\n---\n').definition, 'references')).toBe(false);
    expect(
      Object.hasOwn(parsed('---\nmodel: a/b\nreferences: []\n---\n').definition, 'references'),
    ).toBe(false);
  });

  it('names the entry of every path that leaves the agent file’s directory or cannot be one', () => {
    expect(issuePaths('references: ["../secret.md"]')).toEqual(['references.0']);
    expect(issuePaths('references: [ok.md, "a/../../b.md"]')).toEqual(['references.1']);
    expect(issuePaths('references: ["/etc/passwd"]')).toEqual(['references.0']);
    expect(issuePaths('references: ["C:/windows/win.ini"]')).toEqual(['references.0']);
    expect(issuePaths('references: ["a\\\\b.md"]')).toEqual(['references.0']);
    expect(issuePaths('references: [".env"]')).toEqual(['references.0']);
    expect(issuePaths('references: ["./a.md"]')).toEqual(['references.0']);
    expect(issuePaths('references: ["docs//a.md"]')).toEqual(['references.0']);
    expect(issuePaths('references: ["docs/"]')).toEqual(['references.0']);
    expect(issuePaths('references: [""]')).toEqual(['references.0']);
    expect(issuePaths('references: [3]')).toEqual(['references.0']);
  });

  it('refuses a list that repeats a path, is too long, or is not a list', () => {
    expect(issuePaths('references: [a.md, a.md]')).toEqual(['references']);
    const seventeen = Array.from({ length: 17 }, (_, index) => `d${index}.md`).join(', ');
    expect(issuePaths(`references: [${seventeen}]`)).toEqual(['references']);
    expect(issuePaths('references: a.md')).toEqual(['references']);
  });

  it('explains why a path is refused, in one place the sources share', () => {
    expect(agentReferencePathProblem('docs/a.md')).toBeUndefined();
    expect(agentReferencePathProblem('../a.md')).toContain('..');
    expect(agentReferencePathProblem('a\u0000b')).toContain('control');
    expect(agentReferencePathProblem('x'.repeat(256))).toContain('255');
  });
});

describe('compaction in the frontmatter', () => {
  it('parses enabled with or without a threshold, and a file without the key has none', () => {
    expect(
      parsed('---\nmodel: a/b\ncompaction: {enabled: true, thresholdPercent: 70}\n---\n').definition
        .compaction,
    ).toEqual({ enabled: true, thresholdPercent: 70 });
    expect(
      parsed('---\nmodel: a/b\ncompaction: {enabled: false}\n---\n').definition.compaction,
    ).toEqual({ enabled: false });
    expect(Object.hasOwn(parsed('---\nmodel: a/b\n---\n').definition, 'compaction')).toBe(false);
  });

  it('names the field of every out-of-range or malformed value', () => {
    expect(issuePaths('compaction: {enabled: true, thresholdPercent: 49}')).toEqual([
      'compaction.thresholdPercent',
    ]);
    expect(issuePaths('compaction: {enabled: true, thresholdPercent: 96}')).toEqual([
      'compaction.thresholdPercent',
    ]);
    expect(issuePaths('compaction: {enabled: true, thresholdPercent: 70.5}')).toEqual([
      'compaction.thresholdPercent',
    ]);
    expect(issuePaths('compaction: {thresholdPercent: 70}')).toEqual(['compaction.enabled']);
    expect(issuePaths('compaction: {enabled: "yes"}')).toEqual(['compaction.enabled']);
    expect(issuePaths('compaction: {enabled: true, model: x}')).toEqual(['compaction']);
    expect(issuePaths('compaction: true')?.[0]).toBe('compaction');
  });

  it('accepts the bounds', () => {
    expect(issuePaths('compaction: {enabled: true, thresholdPercent: 50}')).toBeUndefined();
    expect(issuePaths('compaction: {enabled: true, thresholdPercent: 95}')).toBeUndefined();
  });
});

describe('writing references and compaction', () => {
  it('writes a new file that parses back to the same values', () => {
    const text = decoder.decode(
      serializeNewAgentFile({
        model: 'a/b',
        references: ['docs/style.md', 'glossary.txt'],
        compaction: { enabled: true, thresholdPercent: 60 },
        instructions: 'Body.\n',
      }),
    );
    const { definition } = parsed(text);
    expect(definition.references).toEqual(['docs/style.md', 'glossary.txt']);
    expect(definition.compaction).toEqual({ enabled: true, thresholdPercent: 60 });
  });

  it('writes neither key when the definition sets neither, or lists no references', () => {
    const text = decoder.decode(
      serializeNewAgentFile({ model: 'a/b', references: [], instructions: 'Body.\n' }),
    );
    expect(text).not.toContain('references');
    expect(text).not.toContain('compaction');
  });

  it('keeps both when an update leaves them out, and adds neither to a file without them', () => {
    const file = parsed(
      '---\nmodel: a/b\nreferences: [a.md]\ncompaction: {enabled: true}\ncolor: blue\n---\nBody.\n',
    );
    const kept = decoder.decode(
      serializeUpdatedAgentFile('helper', file, {
        model: 'a/b',
        name: 'Named',
        instructions: 'Body.\n',
      }),
    );
    expect(parsed(kept).definition).toMatchObject({
      name: 'Named',
      references: ['a.md'],
      compaction: { enabled: true },
    });
    expect(kept).toContain('color: blue');

    const renamed = decoder.decode(
      serializeUpdatedAgentFile('helper', parsed('---\nmodel: a/b\n---\nBody.\n'), {
        model: 'a/b',
        name: 'Named',
        instructions: 'Body.\n',
      }),
    );
    expect(renamed).not.toContain('references');
    expect(renamed).not.toContain('compaction');
  });

  it('changes a value the update states, and removes one the update sets to null or empty', () => {
    const file = parsed(
      '---\nmodel: a/b\nreferences: [a.md]\ncompaction: {enabled: true}\n---\nBody.\n',
    );
    const changed = parsed(
      decoder.decode(
        serializeUpdatedAgentFile('helper', file, {
          model: 'a/b',
          references: ['b.md', 'a.md'],
          compaction: { enabled: false, thresholdPercent: 90 },
          instructions: 'Body.\n',
        }),
      ),
    );
    expect(changed.definition.references).toEqual(['b.md', 'a.md']);
    expect(changed.definition.compaction).toEqual({ enabled: false, thresholdPercent: 90 });

    const removed = decoder.decode(
      serializeUpdatedAgentFile('helper', changed, {
        model: 'a/b',
        references: [],
        compaction: null,
        instructions: 'Body.\n',
      }),
    );
    expect(removed).not.toContain('references');
    expect(removed).not.toContain('compaction');
    const nulled = decoder.decode(
      serializeUpdatedAgentFile('helper', file, {
        model: 'a/b',
        references: null,
        instructions: 'Body.\n',
      }),
    );
    expect(nulled).not.toContain('references');
  });

  it('rewrites nothing when the update states the values the file has', () => {
    const file = parsed(
      '---\nmodel: a/b\nreferences: [a.md]\ncompaction: {enabled: true}\n---\nBody.\n',
    );
    expect(
      serializeUpdatedAgentFile('helper', file, {
        model: 'a/b',
        references: ['a.md'],
        compaction: { enabled: true },
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

  it('loads when it was written before the fields existed', () => {
    const loaded = agentFileDefinitionSchema.parse(OLD_SNAPSHOT);
    expect(loaded.references).toBeUndefined();
    expect(loaded.compaction).toBeUndefined();
  });

  it('keeps both when it has them, and refuses a value a file would refuse', () => {
    const loaded = agentFileDefinitionSchema.parse({
      ...OLD_SNAPSHOT,
      references: ['a.md'],
      compaction: { enabled: true, thresholdPercent: 60 },
    });
    expect(loaded).toMatchObject({
      references: ['a.md'],
      compaction: { enabled: true, thresholdPercent: 60 },
    });
    expect(
      agentFileDefinitionSchema.safeParse({ ...OLD_SNAPSHOT, references: ['../a.md'] }).success,
    ).toBe(false);
    expect(
      agentFileDefinitionSchema.safeParse({ ...OLD_SNAPSHOT, compaction: { enabled: 1 } }).success,
    ).toBe(false);
  });
});
