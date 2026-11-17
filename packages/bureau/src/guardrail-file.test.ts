/**
 * COR-2120 — an owner-defined guardrail file: what it may say, what its digest is, how each way it
 * can be wrong is named, and how the guardrail it builds judges input, output, a tool result and a
 * tool call. The format is persisted, owner-written data, so it is read strictly, and a refusal is a
 * code, never text from the file.
 */
import { describe, expect, it } from 'bun:test';

import {
  decodeStoredGuardrailDefinition,
  GUARDRAIL_FILE_PROBLEM_CODES,
  type GuardrailFileDefinition,
  guardrailFileDigest,
  OWNER_GUARDRAIL_CATEGORY,
  ownerGuardrailEntries,
  parseGuardrailFile,
} from './guardrail-file';

const IDENTIFIER = /^[A-Z][A-Z0-9_]{0,63}$/;

const OUTPUT = {
  kind: 'pattern',
  description: 'Keeps the secret sauce secret.',
  checks: 'output',
  phrases: ['secret-sauce'],
};

function parsed(stem: string, json: unknown) {
  return parseGuardrailFile(stem, typeof json === 'string' ? json : JSON.stringify(json));
}

function definitionOf(json: unknown, stem = 'no-sauce'): GuardrailFileDefinition {
  const result = parsed(stem, json);
  if (!result.ok) throw new Error(`expected a valid file, got ${result.code}`);
  return result.definition;
}

describe('a guardrail file', () => {
  it('is read into a canonical definition with each default written out, and a digest of it', () => {
    const result = parsed('no-sauce', OUTPUT);

    expect(result).toEqual({
      ok: true,
      definition: {
        kind: 'pattern',
        description: 'Keeps the secret sauce secret.',
        checks: 'output',
        action: 'block',
        phrases: ['secret-sauce'],
        patterns: [],
      },
      digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    if (result.ok) expect(result.digest).toBe(guardrailFileDigest(result.definition));
  });

  it('has one digest however its defaults are spelled or its keys ordered, and another when what it says changes', () => {
    const plain = parsed('a', OUTPUT);
    const spelled = parsed('b', {
      patterns: [],
      action: 'block',
      phrases: ['secret-sauce'],
      checks: 'output',
      description: 'Keeps the secret sauce secret.',
      kind: 'pattern',
    });
    const stricter = parsed('c', { ...OUTPUT, action: 'tripwire' });
    const wider = parsed('d', { ...OUTPUT, phrases: ['secret-sauce', 'recipe'] });

    expect(plain.ok && spelled.ok && plain.digest).toBe(spelled.ok && spelled.digest);
    expect(stricter.ok && plain.ok && stricter.digest).not.toBe(plain.ok && plain.digest);
    expect(wider.ok && plain.ok && wider.digest).not.toBe(plain.ok && plain.digest);
  });

  it.each([
    ['a stem holding a colon', 'plug:in', OUTPUT, 'GUARDRAIL_FILE_INVALID_NAME'],
    ['a stem with a space', 'two words', OUTPUT, 'GUARDRAIL_FILE_INVALID_NAME'],
    ['text that is not JSON', 'broken', '{"kind":"pattern","descr', 'GUARDRAIL_FILE_NOT_JSON'],
    ['JSON that is not an object', 'list', '[1]', 'GUARDRAIL_FILE_INVALID_DEFINITION'],
    ['another kind', 'other', { ...OUTPUT, kind: 'command' }, 'GUARDRAIL_FILE_INVALID_DEFINITION'],
    [
      'a key it does not take',
      'extra',
      { ...OUTPUT, command: 'true' },
      'GUARDRAIL_FILE_INVALID_DEFINITION',
    ],
    [
      'no checks',
      'unchecked',
      { ...OUTPUT, checks: undefined },
      'GUARDRAIL_FILE_INVALID_DEFINITION',
    ],
    [
      'checks it does not know',
      'strange',
      { ...OUTPUT, checks: 'memory' },
      'GUARDRAIL_FILE_INVALID_DEFINITION',
    ],
    [
      'two checks',
      'both',
      { ...OUTPUT, checks: ['input', 'output'] },
      'GUARDRAIL_FILE_INVALID_DEFINITION',
    ],
    [
      'an action it does not know',
      'sanitizer',
      { ...OUTPUT, action: 'sanitize' },
      'GUARDRAIL_FILE_INVALID_DEFINITION',
    ],
    [
      'nothing to look for',
      'empty',
      { ...OUTPUT, phrases: undefined },
      'GUARDRAIL_FILE_INVALID_DEFINITION',
    ],
    ['an empty phrase', 'blank', { ...OUTPUT, phrases: [''] }, 'GUARDRAIL_FILE_INVALID_DEFINITION'],
    [
      'a regular expression that does not compile',
      'bad',
      { ...OUTPUT, phrases: undefined, patterns: ['('] },
      'GUARDRAIL_FILE_INVALID_PATTERN',
    ],
  ])('is refused, by code, for %s', (_name, stem, json, code) => {
    expect(parsed(stem, json)).toEqual({ ok: false, code } as ReturnType<typeof parsed>);
  });

  it('names every refusal by an identifier, and carries nothing of the file in it', () => {
    for (const code of GUARDRAIL_FILE_PROBLEM_CODES) expect(code).toMatch(IDENTIFIER);

    const canary = 'CANARY-FILE-TEXT-77ab with spaces';
    for (const json of [
      `{"kind":"pattern","description":"${canary}"`,
      { ...OUTPUT, patterns: [`(${canary}`] },
      { ...OUTPUT, [canary]: true },
    ]) {
      const result = parsed('canary', json);
      expect(result.ok).toBe(false);
      expect(Object.keys(result)).toEqual(['ok', 'code']);
      expect(JSON.stringify(result)).not.toContain('CANARY');
    }
  });

  it('is stored and read back as exactly a definition whose patterns still compile', () => {
    const definition = definitionOf(OUTPUT);

    expect(decodeStoredGuardrailDefinition(JSON.parse(JSON.stringify(definition)))).toEqual(
      definition,
    );
    for (const tampered of [
      { ...definition, command: 'true' },
      { ...definition, action: 'sanitize' },
      { ...definition, patterns: ['('] },
      null,
      'text',
    ]) {
      expect(decodeStoredGuardrailDefinition(tampered)).toBeUndefined();
    }
  });
});

describe('the guardrail a definition builds', () => {
  const context = {
    step: 0,
    conversationLength: 1,
    sessionTainted: false,
    provenance: 'user-input' as const,
  };

  it('is an input detector for `input`, with the file’s action, that fires on what the user says and not on a tool result', async () => {
    const entries = ownerGuardrailEntries(
      'no-drops',
      definitionOf({
        kind: 'pattern',
        description: 'No drops.',
        checks: 'input',
        action: 'warn',
        phrases: ['drop table'],
        patterns: ['rm\\s+-rf'],
      }),
    );
    const detector = entries.inputDetector;

    expect(detector?.action).toBe('warn');
    expect(detector?.guardrail.name).toBe('no-drops');
    expect(await detector?.guardrail.detect('Please DROP TABLE users', context)).toMatchObject({
      triggered: true,
      category: OWNER_GUARDRAIL_CATEGORY,
      confidence: 1,
    });
    expect(await detector?.guardrail.detect('and rm  -rf /', context)).toMatchObject({
      triggered: true,
    });
    expect(await detector?.guardrail.detect('hello', context)).toMatchObject({ triggered: false });
    // A detector runs on user input and on tool results alike, so each says which it means.
    expect(
      await detector?.guardrail.detect('drop table', { ...context, provenance: 'tool-result' }),
    ).toMatchObject({ triggered: false });
    expect(entries.outputValidator).toBeUndefined();
    expect(entries.toolValidator).toBeUndefined();
  });

  it('is an input detector for `tool-result` that fires on a tool’s answer and not on what the user says', async () => {
    const detector = ownerGuardrailEntries(
      'no-keys',
      definitionOf({ ...OUTPUT, checks: 'tool-result', phrases: ['api_key='] }),
    ).inputDetector;

    expect(
      await detector?.guardrail.detect('found api_key=abc', {
        ...context,
        provenance: 'tool-result',
      }),
    ).toMatchObject({ triggered: true });
    expect(await detector?.guardrail.detect('api_key=abc', context)).toMatchObject({
      triggered: false,
    });
  });

  it('is an output validator for `output` that finds the reply invalid when it matches', async () => {
    const entries = ownerGuardrailEntries('no-sauce', definitionOf(OUTPUT));
    const validator = entries.outputValidator;
    const validatorContext = { step: 0, conversationLength: 1, toolCallCount: 0 };

    expect(validator?.action).toBe('block');
    expect(
      await validator?.guardrail.validate('The Secret-Sauce is oregano.', validatorContext),
    ).toMatchObject({
      valid: false,
      category: OWNER_GUARDRAIL_CATEGORY,
    });
    expect(await validator?.guardrail.validate('Nothing to see.', validatorContext)).toMatchObject({
      valid: true,
    });
  });

  it('is a tool-call validator for `tool-call` that reads the call’s arguments as JSON text', async () => {
    const validator = ownerGuardrailEntries(
      'no-drops',
      definitionOf({
        kind: 'pattern',
        description: 'No drops.',
        checks: 'tool-call',
        action: 'tripwire',
        phrases: ['drop table'],
      }),
    ).toolValidator;
    const call = (args: unknown) => ({ id: 'c1', name: 'run-sql', arguments: args });
    const toolContext = { step: 0, conversationLength: 1, toolCallCount: 1, sessionTainted: false };

    expect(validator?.action).toBe('tripwire');
    expect(await validator?.validate(call({ sql: 'DROP TABLE users' }), toolContext)).toMatchObject(
      {
        valid: false,
      },
    );
    expect(await validator?.validate(call({ sql: 'select 1' }), toolContext)).toMatchObject({
      valid: true,
    });
    // A call with no arguments serializes to nothing to match.
    expect(await validator?.validate(call(undefined), toolContext)).toMatchObject({ valid: true });
  });

  it('says nothing of the text it matched in a finding', async () => {
    const detector = ownerGuardrailEntries(
      'no-sauce',
      definitionOf({ ...OUTPUT, checks: 'input' }),
    ).inputDetector;

    const finding = await detector?.guardrail.detect('the secret-sauce is SENTINEL-77', context);

    expect(JSON.stringify(finding)).not.toContain('SENTINEL');
    expect(JSON.stringify(finding)).not.toContain('secret-sauce');
  });
});
