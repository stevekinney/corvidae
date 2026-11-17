/**
 * COR-2119 — an owner-defined validator file: what it may say, what its version is, how each way it
 * can be wrong is named, and how the `match` kind judges an answer. A file is an owner-written,
 * persisted format, so the file is read strictly and a refusal is a code, never text from the file.
 */
import { describe, expect, it } from 'bun:test';

import {
  createFileValidator,
  decodeStoredValidatorDefinition,
  parseValidatorFile,
  VALIDATOR_FILE_PROBLEM_CODES,
  type ValidatorFileDefinition,
  validatorFileVersion,
} from './validator-file';

/** The identifier shape every code a pushed event may carry has (`published-error-names.ts`). */
const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,63}$/;

function parsed(stem: string, json: unknown) {
  return parseValidatorFile(stem, typeof json === 'string' ? json : JSON.stringify(json));
}

function definitionOf(stem: string, json: unknown): ValidatorFileDefinition {
  const result = parsed(stem, json);
  if (!result.ok) throw new Error(`expected a valid file, got ${result.code}`);
  return result.definition;
}

const MATCH = { kind: 'match', description: 'The notes say so.', phrases: ['staging fix'] };

describe('a validator file', () => {
  it('is read into a canonical definition with each default written out, and a version that is its digest', () => {
    const result = parsed('notes-say-so', MATCH);

    expect(result).toEqual({
      ok: true,
      definition: {
        kind: 'match',
        description: 'The notes say so.',
        phrases: ['staging fix'],
        patterns: [],
        mode: 'all',
      },
      version: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    if (result.ok) expect(result.version).toBe(validatorFileVersion(result.definition));
  });

  it('has the same version however its defaults are spelled or its keys ordered, and another when what it says changes', () => {
    const spelled = parsed('a', {
      mode: 'all',
      description: 'The notes say so.',
      patterns: [],
      phrases: ['staging fix'],
      kind: 'match',
    });
    const plain = parsed('b', MATCH);
    const edited = parsed('c', { ...MATCH, phrases: ['staging fix', 'rollback'] });
    const flagged = parsed('d', {
      kind: 'match',
      description: 'x',
      patterns: [{ pattern: 'done', flags: 'i' }],
    });
    const defaulted = parsed('e', {
      kind: 'match',
      description: 'x',
      patterns: [{ pattern: 'done' }],
    });

    expect(spelled.ok && plain.ok && spelled.version).toBe(plain.ok && plain.version);
    expect(edited.ok && plain.ok && edited.version).not.toBe(plain.ok && plain.version);
    // A pattern's flags default to case-insensitive, so spelling the default is not a change.
    expect(flagged.ok && defaulted.ok && flagged.version).toBe(defaulted.ok && defaulted.version);
  });

  it.each([
    ['a stem holding a colon', 'plug:in', MATCH, 'VALIDATOR_FILE_INVALID_NAME'],
    ['a stem that is not a plugin name', 'Upper_Case', MATCH, 'VALIDATOR_FILE_INVALID_NAME'],
    ['text that is not JSON', 'broken', '{"kind":"match","descr', 'VALIDATOR_FILE_NOT_JSON'],
    ['JSON that is not an object', 'list', '[1,2]', 'VALIDATOR_FILE_INVALID_DEFINITION'],
    [
      'a file with no kind',
      'kindless',
      { description: 'x', phrases: ['a'] },
      'VALIDATOR_FILE_INVALID_DEFINITION',
    ],
    [
      'a command kind',
      'runs-a-command',
      { kind: 'command', command: 'true' },
      'VALIDATOR_FILE_COMMAND_KIND',
    ],
    [
      'a kind no file may define',
      'strange',
      { kind: 'frobnicate', description: 'x' },
      'VALIDATOR_FILE_UNKNOWN_KIND',
    ],
    [
      'a key the kind does not take',
      'extra',
      { ...MATCH, command: 'true' },
      'VALIDATOR_FILE_INVALID_DEFINITION',
    ],
    [
      'a match with nothing to match',
      'empty',
      { kind: 'match', description: 'x' },
      'VALIDATOR_FILE_INVALID_DEFINITION',
    ],
    ['an empty phrase', 'blank', { ...MATCH, phrases: [''] }, 'VALIDATOR_FILE_INVALID_DEFINITION'],
    [
      'a mode that is neither',
      'moody',
      { ...MATCH, mode: 'some' },
      'VALIDATOR_FILE_INVALID_DEFINITION',
    ],
    [
      'a regular expression that does not compile',
      'bad-pattern',
      { kind: 'match', description: 'x', patterns: [{ pattern: '(' }] },
      'VALIDATOR_FILE_INVALID_PATTERN',
    ],
    [
      'a flag a file may not set',
      'global',
      { kind: 'match', description: 'x', patterns: [{ pattern: 'a', flags: 'g' }] },
      'VALIDATOR_FILE_INVALID_PATTERN',
    ],
  ])('is refused, by code, for %s', (_name, stem, json, code) => {
    expect(parsed(stem, json)).toEqual({ ok: false, code } as ReturnType<typeof parsed>);
  });

  it('names every refusal by an identifier, and carries nothing of the file in it', () => {
    for (const code of VALIDATOR_FILE_PROBLEM_CODES) expect(code).toMatch(IDENTIFIER);

    const canary = 'CANARY-FILE-TEXT-3c7e with spaces';
    for (const json of [
      `{"kind":"match","description":"${canary}"`,
      { kind: 'match', description: canary, patterns: [{ pattern: `(${canary}` }] },
      { kind: canary },
      { ...MATCH, [canary]: true },
    ]) {
      const result = parsed('canary', json);
      expect(result.ok).toBe(false);
      expect(Object.keys(result)).toEqual(['ok', 'code']);
      expect(JSON.stringify(result)).not.toContain('CANARY');
    }
  });

  it('is stored and read back as exactly a definition, with its patterns still compiling', () => {
    const definition = definitionOf('ok', MATCH);

    expect(decodeStoredValidatorDefinition(JSON.parse(JSON.stringify(definition)))).toEqual(
      definition,
    );
    for (const tampered of [
      { ...definition, command: 'true' },
      { ...definition, mode: 'some' },
      { ...definition, patterns: [{ pattern: '(', flags: 'i' }] },
      { kind: 'command' },
      null,
      'text',
    ]) {
      expect(decodeStoredValidatorDefinition(tampered)).toBeUndefined();
    }
  });
});

const SCHEMA = {
  kind: 'schema',
  description: 'The result names a ticket.',
  schema: {
    type: 'object',
    properties: { ticket: { type: 'string' }, priority: { type: 'integer' } },
    required: ['ticket', 'priority'],
  },
};

describe('the schema kind (COR-2121)', () => {
  const signal = new AbortController().signal;
  const run = async (file: unknown, result: Record<string, unknown>) => {
    const validator = createFileValidator('tickets', definitionOf('tickets', file));
    return validator.validate({ result: { content: '', ...result } } as never, signal);
  };

  it('is read with its target written out, structured output by default', () => {
    expect(definitionOf('tickets', SCHEMA)).toMatchObject({
      kind: 'schema',
      target: 'structured-output',
    });
    expect(definitionOf('tickets', { ...SCHEMA, target: 'content' })).toMatchObject({
      target: 'content',
    });
  });

  it('passes structured output that matches, and fails a mismatch with feedback naming the path', async () => {
    expect(await run(SCHEMA, { output: { ticket: 'COR-1', priority: 2 } })).toMatchObject({
      kind: 'pass',
    });

    const outcome = await run(SCHEMA, { output: { ticket: 'COR-1', priority: 'high' } });
    expect(outcome).toMatchObject({ kind: 'fail', retryable: true });
    expect(outcome.kind === 'fail' && outcome.feedback).toContain('priority');
    expect(outcome.kind === 'fail' && outcome.feedback).not.toContain('ticket:');
  });

  it('fails a run that produced no structured output, and says so', async () => {
    const outcome = await run(SCHEMA, {});
    expect(outcome).toMatchObject({ kind: 'fail' });
    expect(outcome.kind === 'fail' && outcome.feedback).toContain('no structured output');
  });

  it('parses the answer as JSON first under the content target, and fails text that is not JSON, saying so', async () => {
    const file = { ...SCHEMA, target: 'content' };

    expect(await run(file, { content: '{"ticket":"COR-1","priority":2}' })).toMatchObject({
      kind: 'pass',
    });
    const outcome = await run(file, { content: 'all done, no JSON here' });
    expect(outcome).toMatchObject({ kind: 'fail', retryable: true });
    expect(outcome.kind === 'fail' && outcome.feedback).toContain('not JSON');
    const mismatch = await run(file, { content: '{"ticket":3,"priority":2}' });
    expect(mismatch.kind === 'fail' && mismatch.feedback).toContain('ticket');
  });

  it('refuses, when the file loads, a schema that is not a JSON Schema or that uses a regular expression', () => {
    for (const schema of [
      { type: 'nonsense' },
      { type: 'string', pattern: '^a+$' },
      { $id: 'https://example.com/x', type: 'object' },
    ]) {
      expect(parsed('tickets', { ...SCHEMA, schema })).toEqual({
        ok: false,
        code: 'VALIDATOR_FILE_INVALID_SCHEMA',
      });
    }
    expect(parsed('tickets', { ...SCHEMA, schema: 'object' })).toEqual({
      ok: false,
      code: 'VALIDATOR_FILE_INVALID_DEFINITION',
    });
  });

  it('lists at most the first five errors, by path', async () => {
    const wide = {
      kind: 'schema',
      description: 'Seven fields.',
      schema: {
        type: 'object',
        properties: Object.fromEntries(
          ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((key) => [key, { type: 'string' }]),
        ),
      },
    };
    const outcome = await run(wide, {
      output: { a: 1, b: 1, c: 1, d: 1, e: 1, f: 1, g: 1 },
    });

    expect(outcome.kind).toBe('fail');
    const feedback = outcome.kind === 'fail' ? outcome.feedback : '';
    expect(['a', 'b', 'c', 'd', 'e'].every((path) => feedback.includes(`${path}:`))).toBe(true);
    expect(feedback).not.toContain('f:');
    expect(feedback).not.toContain('g:');
    expect(feedback).toContain('2 more');
  });
});

describe('the tool-called kind (COR-2122)', () => {
  const FILE = { kind: 'tool-called', description: 'Files a ticket.', tool: 'tickets:file' };
  const signal = new AbortController().signal;
  const call = (
    toolName: string,
    outcome: 'success' | 'error' | 'action_required' = 'success',
  ) => ({
    toolName,
    outcome,
  });
  const run = async (file: unknown, ...calls: ReturnType<typeof call>[]) =>
    createFileValidator('files-tickets', definitionOf('files-tickets', file)).validate(
      { result: { content: '', steps: [{ results: calls }] } } as never,
      signal,
    );

  it('is read with its minimum written out, one by default', () => {
    expect(definitionOf('files-tickets', FILE)).toMatchObject({ tool: 'tickets:file', minimum: 1 });
  });

  it('passes a run with a successful call to the tool', async () => {
    expect(await run(FILE, call('other'), call('tickets:file'))).toMatchObject({ kind: 'pass' });
  });

  it('fails a run whose only call failed, and a run with no call, each naming the tool', async () => {
    for (const calls of [
      [call('tickets:file', 'error')],
      [call('tickets:file', 'action_required')],
      [],
    ]) {
      const outcome = await run(FILE, ...calls);
      expect(outcome).toMatchObject({ kind: 'fail', retryable: true });
      expect(outcome.kind === 'fail' && outcome.feedback).toContain('tickets:file');
    }
  });

  it('needs the minimum number of successful calls, counting none that failed', async () => {
    const twice = { ...FILE, minimum: 2 };

    expect(await run(twice, call('tickets:file'))).toMatchObject({ kind: 'fail' });
    expect(await run(twice, call('tickets:file'), call('tickets:file', 'error'))).toMatchObject({
      kind: 'fail',
    });
    expect(await run(twice, call('tickets:file'), call('tickets:file'))).toMatchObject({
      kind: 'pass',
    });
    const outcome = await run(twice, call('tickets:file'));
    expect(outcome.kind === 'fail' && outcome.feedback).toContain('tickets:file');
  });

  it('counts the calls of every step of the run', async () => {
    const validator = createFileValidator(
      'files-tickets',
      definitionOf('files-tickets', { ...FILE, minimum: 2 }),
    );

    const outcome = await validator.validate(
      {
        result: {
          content: '',
          steps: [{ results: [call('tickets:file')] }, { results: [call('tickets:file')] }],
        },
      } as never,
      signal,
    );

    expect(outcome).toMatchObject({ kind: 'pass' });
  });

  it('refuses a minimum below one, and a tool name that is not one', () => {
    expect(parsed('files-tickets', { ...FILE, minimum: 0 })).toEqual({
      ok: false,
      code: 'VALIDATOR_FILE_INVALID_DEFINITION',
    });
    expect(parsed('files-tickets', { ...FILE, tool: 'has spaces' })).toEqual({
      ok: false,
      code: 'VALIDATOR_FILE_INVALID_DEFINITION',
    });
  });
});

describe('the judge kind’s file (COR-2123)', () => {
  const FILE = {
    kind: 'judge' as const,
    description: 'Reads like release notes.',
    model: 'anthropic/claude-haiku-5-5',
    rubric: 'The answer is written as release notes.',
  };

  it('is read as it is written, and says it is stochastic', () => {
    const definition = definitionOf('release-notes', FILE);

    expect(definition).toEqual(FILE);
    expect(createFileValidator('release-notes', definition).determinism).toBe('stochastic');
  });

  it('is refused for a model that is not in the catalog, and only when it is asked', () => {
    const known = (model: string) => model === 'anthropic/claude-haiku-5-5';

    expect(
      parseValidatorFile('release-notes', JSON.stringify(FILE), { modelKnown: known }).ok,
    ).toBe(true);
    expect(
      parseValidatorFile('release-notes', JSON.stringify({ ...FILE, model: 'nobody/none' }), {
        modelKnown: known,
      }),
    ).toEqual({ ok: false, code: 'VALIDATOR_FILE_UNKNOWN_MODEL' });
    // With no catalog to ask, no model is refused.
    expect(
      parseValidatorFile('release-notes', JSON.stringify({ ...FILE, model: 'nobody/none' })).ok,
    ).toBe(true);
  });

  it('is refused for a model that is not written as a catalog row, and for a missing rubric', () => {
    for (const bad of [
      { ...FILE, model: 'haiku' },
      { ...FILE, rubric: '' },
      { ...FILE, rubric: undefined },
    ]) {
      expect(parsed('release-notes', bad)).toEqual({
        ok: false,
        code: 'VALIDATOR_FILE_INVALID_DEFINITION',
      });
    }
  });
});

describe('the match kind', () => {
  const input = (content: string) => ({ result: { content } }) as never;
  const signal = new AbortController().signal;
  const run = async (definition: ValidatorFileDefinition, content: string) =>
    createFileValidator('notes', definition).validate(input(content), signal);

  it('is named for the file and versioned by the digest, and is deterministic', () => {
    const definition = definitionOf('notes', MATCH);
    const validator = createFileValidator('notes', definition);

    expect(validator.identity).toEqual({
      name: 'notes',
      version: validatorFileVersion(definition),
    });
    expect(validator.determinism).toBe('deterministic');
  });

  it('passes and fails by phrase in all mode, in any letter case, and says what is missing', async () => {
    const definition = definitionOf('notes', {
      ...MATCH,
      phrases: ['staging fix', 'rollback plan'],
    });

    expect(await run(definition, 'The STAGING FIX and the Rollback Plan.')).toMatchObject({
      kind: 'pass',
    });
    const outcome = await run(definition, 'Only the staging fix.');
    expect(outcome).toMatchObject({ kind: 'fail', retryable: true });
    expect(outcome.kind === 'fail' && outcome.feedback).toContain('rollback plan');
    expect(outcome.kind === 'fail' && outcome.feedback).not.toContain('staging fix');
  });

  it('passes on one hit in any mode, and fails on none, naming what it looked for', async () => {
    const definition = definitionOf('notes', {
      kind: 'match',
      description: 'x',
      mode: 'any',
      phrases: ['staging fix'],
      patterns: [{ pattern: '^done\\b' }],
    });

    expect(await run(definition, 'Done and dusted.')).toMatchObject({ kind: 'pass' });
    expect(await run(definition, 'the staging fix')).toMatchObject({ kind: 'pass' });
    const outcome = await run(definition, 'nothing of the sort');
    expect(outcome).toMatchObject({ kind: 'fail', retryable: true });
    expect(outcome.kind === 'fail' && outcome.feedback).toContain('staging fix');
    expect(outcome.kind === 'fail' && outcome.feedback).toContain('^done');
  });

  it('matches a pattern with the flags the file gave, case-insensitive only by default', async () => {
    const sensitive = definitionOf('notes', {
      kind: 'match',
      description: 'x',
      patterns: [{ pattern: 'OK', flags: '' }],
    });
    const defaulted = definitionOf('notes', {
      kind: 'match',
      description: 'x',
      patterns: [{ pattern: 'OK' }],
    });

    expect(await run(sensitive, 'ok')).toMatchObject({ kind: 'fail' });
    expect(await run(sensitive, 'OK')).toMatchObject({ kind: 'pass' });
    expect(await run(defaulted, 'ok')).toMatchObject({ kind: 'pass' });
  });

  it('judges the same, again and again, from the definition alone', async () => {
    const validator = createFileValidator('notes', definitionOf('notes', MATCH));

    for (let round = 0; round < 3; round += 1) {
      expect(await validator.validate(input('the staging fix'), signal)).toMatchObject({
        kind: 'pass',
      });
    }
  });
});
