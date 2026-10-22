/**
 * COR-1559 — the `models` field of an agent file: an optional list of the models a session of the
 * agent may be switched to. It is checked when the file is parsed, by literal string comparison,
 * so a file's validity never depends on the model catalog; a snapshot keeps it; and an update that
 * omits it removes it, as it does `tools`.
 */
import { describe, expect, it } from 'bun:test';

import {
  agentFileDefinitionSchema,
  AGENT_FILE_KNOWN_KEYS,
  parseAgentFile,
  resolveAgentFileDefinition,
  serializeNewAgentFile,
  serializeUpdatedAgentFile,
  type ParsedAgentFile,
} from './agent-file';

const decoder = new TextDecoder();

function file(frontmatter: string[]): string {
  return ['---', ...frontmatter, '---', 'Body.', ''].join('\n');
}

function problemOf(text: string) {
  const result = parseAgentFile('picker', text);
  if (result.ok) throw new Error('Expected the file to be invalid.');
  return result.problem;
}

function parsed(text: string): ParsedAgentFile {
  const result = parseAgentFile('picker', text);
  if (!result.ok) throw new Error(`Expected the file to parse: ${result.problem.message}`);
  return result.file;
}

const DEFAULT = 'anthropic/claude-opus-5-5';

describe('the models field', () => {
  it('is a known frontmatter key', () => {
    expect(AGENT_FILE_KNOWN_KEYS).toContain('models');
  });

  it('parses to the listed entries, in order', () => {
    const { definition } = parsed(
      file([`model: ${DEFAULT}`, 'models:', `  - ${DEFAULT}`, '  - openai/gpt-4.1']),
    );

    expect(definition.models).toEqual([DEFAULT, 'openai/gpt-4.1']);
  });

  it('is absent from the definition when the file lists none', () => {
    const { definition } = parsed(file([`model: ${DEFAULT}`]));

    expect(definition.models).toBeUndefined();
    expect('models' in definition).toBe(false);
  });

  it('names the malformed entry in an invalid-frontmatter problem', () => {
    const problem = problemOf(
      file([`model: ${DEFAULT}`, `models: [${DEFAULT}, claude-opus-5, "openai/", "/gpt", ""]`]),
    );

    expect(problem.code).toBe('invalid-frontmatter');
    expect(problem.issues?.map((issue) => issue.path)).toEqual([
      'models.1',
      'models.2',
      'models.3',
      'models.4',
    ]);
  });

  it('names a repeated entry at its own index', () => {
    const problem = problemOf(
      file([`model: ${DEFAULT}`, `models: [${DEFAULT}, openai/gpt-4.1, ${DEFAULT}]`]),
    );

    expect(problem.code).toBe('invalid-frontmatter');
    expect(problem.issues?.map((issue) => issue.path)).toEqual(['models.2']);
  });

  it('refuses an empty list', () => {
    const problem = problemOf(file([`model: ${DEFAULT}`, 'models: []']));

    expect(problem.code).toBe('invalid-frontmatter');
    expect(problem.issues?.map((issue) => issue.path)).toContain('models');
  });

  it('refuses a list that omits the default model, at the models path', () => {
    const problem = problemOf(file([`model: ${DEFAULT}`, 'models: [openai/gpt-4.1]']));

    expect(problem.code).toBe('invalid-frontmatter');
    expect(problem.issues).toEqual([{ path: 'models', message: expect.stringContaining(DEFAULT) }]);
  });

  it('compares the default by literal string, so an alias of it is not it', () => {
    const problem = problemOf(
      file(['model: anthropic/opus', 'models: [anthropic/claude-opus-4-8]']),
    );

    expect(problem.issues?.map((issue) => issue.path)).toEqual(['models']);
  });

  it('refuses a list that is not a list of text', () => {
    expect(problemOf(file([`model: ${DEFAULT}`, 'models: 7'])).code).toBe('invalid-frontmatter');
    expect(
      problemOf(file([`model: ${DEFAULT}`, `models: [${DEFAULT}, 3]`])).issues?.[0]?.path,
    ).toBe('models.1');
  });
});

describe('writing the models field', () => {
  const input = {
    model: DEFAULT,
    models: [DEFAULT, 'openai/gpt-4.1'],
    instructions: 'Body.\n',
  };

  it('serializes a new file with the list, and reads it back', () => {
    const bytes = serializeNewAgentFile(input);

    const { definition } = parsed(decoder.decode(bytes));

    expect(definition.models).toEqual([DEFAULT, 'openai/gpt-4.1']);
  });

  it('resolves a definition with its list', () => {
    expect(resolveAgentFileDefinition('picker', input).models).toEqual([DEFAULT, 'openai/gpt-4.1']);
    expect(
      resolveAgentFileDefinition('picker', { ...input, models: undefined }),
    ).not.toHaveProperty('models');
  });

  it('removes the list when an update omits it, as it does tools', () => {
    const existing = parsed(
      decoder.decode(serializeNewAgentFile({ ...input, tools: ['lookup-order'] })),
    );

    const bytes = serializeUpdatedAgentFile('picker', existing, {
      model: DEFAULT,
      instructions: existing.body,
    });

    const reread = parsed(decoder.decode(bytes));
    expect(reread.definition.models).toBeUndefined();
    expect(reread.raw['models']).toBeUndefined();
    expect(reread.raw['tools']).toBeUndefined();
  });

  it('changes the list when an update names another', () => {
    const existing = parsed(decoder.decode(serializeNewAgentFile(input)));

    const bytes = serializeUpdatedAgentFile('picker', existing, {
      ...input,
      models: [DEFAULT],
      instructions: existing.body,
    });

    expect(parsed(decoder.decode(bytes)).definition.models).toEqual([DEFAULT]);
  });

  it('writes nothing for an update that changes nothing', () => {
    const existing = parsed(decoder.decode(serializeNewAgentFile(input)));

    expect(
      serializeUpdatedAgentFile('picker', existing, { ...input, instructions: existing.body }),
    ).toBeUndefined();
  });
});

describe('a snapshot of the definition', () => {
  const base = { name: 'Picker', model: DEFAULT, instructions: 'Body.\n' };

  it('keeps the list a run was started with', () => {
    const read = agentFileDefinitionSchema.parse({ ...base, models: [DEFAULT, 'openai/gpt-4.1'] });

    expect(read.models).toEqual([DEFAULT, 'openai/gpt-4.1']);
  });

  it('still reads a snapshot written before the field existed, with no list', () => {
    const read = agentFileDefinitionSchema.parse(base);

    expect(read.models).toBeUndefined();
  });
});
