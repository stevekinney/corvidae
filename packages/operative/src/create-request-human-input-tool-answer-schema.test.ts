/**
 * COR-1804 — a `requestHumanInput` call carries its own `answerSchema`: the agent chooses the shape
 * of each question as it asks. The schema replaces the one configured for the signal, is held to
 * the same limits, and a schema that breaks them returns `invalid-answer-schema` and parks nothing.
 */
import { CompletableEventTarget } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import {
  createRequestHumanInputTool,
  type InvalidAnswerSchemaResult,
  type RequestHumanInputContext,
  type RequestHumanInputOutcome,
  type RequestHumanInputResult,
} from './create-request-human-input-tool';
import type { CombinedOperativeEventMap } from './events';
import { HumanWaitParkedEvent } from './events';
import {
  HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES,
  HUMAN_INPUT_SCHEMA_MAXIMUM_DEPTH,
  type HumanInputSchema,
} from './human-input-schema';
import { humanWaitParks, modelFacingToolResult, parkedHumanWait } from './human-wait-parks';

function makeContext(): RequestHumanInputContext {
  return { pendingHumanWait: undefined, pendingWakeup: undefined, runId: 'run-1', durable: true };
}

function parked(outcome: RequestHumanInputOutcome): RequestHumanInputResult {
  if (!outcome.parked) throw new Error('expected the request to park');
  return outcome;
}

function invalidSchema(outcome: RequestHumanInputOutcome): InvalidAnswerSchemaResult {
  if (outcome.parked || !('error' in outcome)) {
    throw new Error('expected an invalid-answer-schema result');
  }
  return outcome;
}

/** One schema per kind of question, as the tool description teaches them. */
const kinds: Record<string, HumanInputSchema> = {
  'pick one': {
    type: 'string',
    enum: ['staging', 'production'],
    'x-labels': { staging: 'Staging', production: 'Production' },
  },
  'pick one or something else': {
    anyOf: [{ enum: ['small', 'large'] }, { type: 'string', maxLength: 500 }],
    'x-allowOther': true,
  },
  'pick several': {
    type: 'array',
    uniqueItems: true,
    items: { enum: ['a', 'b', 'c'] },
    minItems: 1,
    maxItems: 2,
  },
  'free text': { type: 'string', maxLength: 2000 },
  'yes or no': { type: 'boolean' },
  number: { type: 'number', minimum: 0, maximum: 100 },
  date: { type: 'string', format: 'date' },
  time: { type: 'string', format: 'time' },
  'date and time': { type: 'string', format: 'date-time' },
  rating: {
    type: 'integer',
    minimum: 1,
    maximum: 5,
    'x-kind': 'rating',
    'x-labels': { '1': 'Poor', '5': 'Great' },
  },
  'a few fields': {
    type: 'object',
    properties: { name: { type: 'string' }, count: { type: 'integer' } },
    required: ['name'],
    additionalProperties: false,
  },
  secret: { type: 'string', writeOnly: true, 'x-secret': true },
  file: { type: 'string', contentMediaType: 'application/pdf', 'x-asset': true },
};

describe('requestHumanInput answerSchema: each kind parks with its schema', () => {
  for (const [kind, schema] of Object.entries(kinds)) {
    it(`parks a "${kind}" question and carries the schema everywhere the wait is read`, () => {
      const context = makeContext();
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const events: HumanWaitParkedEvent[] = [];
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => events.push(event));
      const tool = createRequestHumanInputTool({ context, emitter });

      const parsed = tool.input.parse({ signalName: 'ask', prompt: 'Well?', answerSchema: schema });
      const result = parked(tool.execute(parsed));

      expect(context.pendingHumanWait?.inputSchema).toEqual(schema);
      expect(events[0]?.inputSchema).toEqual(schema);
      expect(result.inputSchema).toEqual(schema);
      // A restarted run reads the wait back from the step record, the per-call schema included.
      const read = parkedHumanWait({ toolName: 'requestHumanInput', result });
      expect(read?.inputSchema).toEqual(schema);
      // The model's copy of the result leaves it out: it wrote the schema and does not need it back.
      const toolResult = { toolName: 'requestHumanInput', result, content: result };
      expect(modelFacingToolResult(toolResult).result).not.toHaveProperty('inputSchema');
    });
  }

  it('lists the kinds in the tool description so the model can pick one', () => {
    const { description } = createRequestHumanInputTool({ context: makeContext() });
    for (const word of ['x-allowOther', 'x-labels', 'x-kind', 'x-secret', 'x-asset', 'enum']) {
      expect(description).toContain(word);
    }
  });
});

describe('requestHumanInput answerSchema: rating and number', () => {
  it('are told apart by x-kind, which a rating needs and a number lacks', () => {
    expect(kinds['rating']).toHaveProperty('x-kind', 'rating');
    expect(kinds['number']).not.toHaveProperty('x-kind');
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    // The same integer range, once with x-kind and once without: both are accepted, and the park
    // keeps the keyword, which is the only thing that differs between them.
    const rating = parked(
      tool.execute({
        signalName: 'rate',
        answerSchema: kinds['rating'],
      }),
    );
    context.pendingHumanWait = undefined;
    const plain = parked(
      tool.execute({
        signalName: 'rate',
        answerSchema: { type: 'integer', minimum: 1, maximum: 5 },
      }),
    );

    expect(rating.inputSchema).toHaveProperty('x-kind', 'rating');
    expect(plain.inputSchema).not.toHaveProperty('x-kind');
  });
});

describe('requestHumanInput answerSchema precedence', () => {
  const configured: HumanInputSchema = { type: 'string', enum: ['configured'] };
  const perCall: HumanInputSchema = { type: 'boolean' };

  it('replaces the schema configured for the signal', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context, inputSchemas: { ask: configured } });

    const result = parked(tool.execute({ signalName: 'ask', answerSchema: perCall }));

    expect(result.inputSchema).toEqual(perCall);
    expect(context.pendingHumanWait?.inputSchema).toEqual(perCall);
  });

  it('applies the configured schema only when the call gives none', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context, inputSchemas: { ask: configured } });

    expect(parked(tool.execute({ signalName: 'ask' })).inputSchema).toEqual(configured);
  });

  it('does not fall back to the configured schema when the call’s schema is refused', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context, inputSchemas: { ask: configured } });

    const outcome = tool.execute({ signalName: 'ask', answerSchema: { $id: 'https://x.test/a' } });

    expect(outcome.parked).toBe(false);
    expect(context.pendingHumanWait).toBeUndefined();
  });

  it('keeps its own copy of the call’s schema', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });
    const schema = { type: 'string', maxLength: 5 };

    parked(tool.execute({ signalName: 'ask', answerSchema: schema }));
    schema.maxLength = 5000;

    expect(context.pendingHumanWait?.inputSchema).toEqual({ type: 'string', maxLength: 5 });
  });
});

function nestedTo(levels: number): Record<string, unknown> {
  let schema: Record<string, unknown> = { type: 'string' };
  for (let level = levels - 1; level >= 1; level -= 1) schema = { next: schema };
  return schema;
}

describe('requestHumanInput answerSchema: invalid-answer-schema', () => {
  const refusals: Array<[string, Record<string, unknown>, RegExp]> = [
    ['an over-limit size', { description: 'x'.repeat(HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES) }, /bytes/],
    ['an over-deep schema', nestedTo(HUMAN_INPUT_SCHEMA_MAXIMUM_DEPTH + 1), /levels deep/],
    ['an $id', { $id: 'https://example.test/a', type: 'string' }, /\$id/],
    ['a pattern', { type: 'string', pattern: '^a+$' }, /pattern/],
    ['a schema that is not valid 2020-12', { type: 'banana' }, /not a valid JSON Schema/],
  ];

  for (const [name, schema, message] of refusals) {
    it(`returns invalid-answer-schema for ${name} and parks nothing`, () => {
      const context = makeContext();
      const emitter = new CompletableEventTarget<CombinedOperativeEventMap>();
      const events: HumanWaitParkedEvent[] = [];
      emitter.addEventListener(HumanWaitParkedEvent.type, (event) => events.push(event));
      const tool = createRequestHumanInputTool({ context, emitter });

      const result = invalidSchema(tool.execute({ signalName: 'ask', answerSchema: schema }));

      expect(result.parked).toBe(false);
      expect(result.error).toBe('invalid-answer-schema');
      expect(result.signalName).toBe('ask');
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]?.path).toEqual([]);
      expect(result.issues[0]?.message).toMatch(message);
      expect(result.message).toContain('answerSchema');
      expect(context.pendingHumanWait).toBeUndefined();
      expect(events).toEqual([]);
    });
  }

  it('accepts a schema exactly at the size limit', () => {
    const base = JSON.stringify({ description: '' }).length;
    const schema = { description: 'x'.repeat(HUMAN_INPUT_SCHEMA_MAXIMUM_BYTES - base) };
    expect(
      parked(
        createRequestHumanInputTool({ context: makeContext() }).execute({
          signalName: 'a',
          answerSchema: schema,
        }),
      ).parked,
    ).toBe(true);
  });

  it('is not a park to anything that reads the step’s results', () => {
    const tool = createRequestHumanInputTool({ context: makeContext() });
    const result = tool.execute({ signalName: 'ask', answerSchema: { pattern: 'a' } });
    const row = { toolName: 'requestHumanInput', result };

    expect(parkedHumanWait(row)).toBeUndefined();
    expect(humanWaitParks([row])).toEqual([]);
    // The model reads the result as it is: the issues are for it.
    expect(modelFacingToolResult({ ...row, content: result }).result).toBe(result);
  });

  it('takes no slot, so the model can ask again in the same step with a corrected schema', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    expect(tool.execute({ signalName: 'ask', answerSchema: { pattern: 'a' } }).parked).toBe(false);
    const again = parked(tool.execute({ signalName: 'ask', answerSchema: { type: 'string' } }));

    expect(again.inputSchema).toEqual({ type: 'string' });
  });

  it('leaves the first-request-wins refusal of a step that already parked as it was', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });
    parked(tool.execute({ signalName: 'first' }));

    const second = tool.execute({ signalName: 'second', answerSchema: { pattern: 'a' } });

    expect(second).toMatchObject({ parked: false, refused: true });
    expect(context.pendingHumanWait?.signalName).toBe('first');
  });

  it('refuses an answerSchema that is not an object at the tool’s input', () => {
    const tool = createRequestHumanInputTool({ context: makeContext() });

    expect(tool.input.safeParse({ signalName: 'a', answerSchema: 'string' }).success).toBe(false);
    expect(tool.input.safeParse({ signalName: 'a', answerSchema: [] }).success).toBe(false);
  });
});

describe('requestHumanInput answerSchema: x- keywords', () => {
  const misuses: Array<[string, Record<string, unknown>, Array<string | number>, RegExp]> = [
    ['x-secret without writeOnly', { type: 'string', 'x-secret': true }, ['x-secret'], /writeOnly/],
    [
      'x-secret on a non-string',
      { type: 'number', writeOnly: true, 'x-secret': true },
      ['x-secret'],
      /type "string"/,
    ],
    [
      'x-secret that is not a boolean',
      { type: 'string', 'x-secret': 'yes' },
      ['x-secret'],
      /true or false/,
    ],
    ['x-asset on a non-string', { type: 'number', 'x-asset': true }, ['x-asset'], /type "string"/],
    [
      'x-kind rating without a range',
      { type: 'integer', 'x-kind': 'rating' },
      ['x-kind'],
      /minimum/,
    ],
    [
      'x-kind rating that is not an integer',
      { type: 'number', minimum: 1, maximum: 5, 'x-kind': 'rating' },
      ['x-kind'],
      /integer/,
    ],
    [
      'x-kind rating with an inverted range',
      { type: 'integer', minimum: 5, maximum: 1, 'x-kind': 'rating' },
      ['x-kind'],
      /must not exceed/,
    ],
    ['an unknown x-kind', { type: 'integer', 'x-kind': 'slider' }, ['x-kind'], /rating/],
    [
      'x-labels with a non-string label',
      { type: 'string', enum: ['a'], 'x-labels': { a: 1 } },
      ['x-labels', 'a'],
      /label/,
    ],
    [
      'x-labels for a value that is not in the enum',
      { type: 'string', enum: ['a'], 'x-labels': { b: 'B' } },
      ['x-labels', 'b'],
      /not one of the enum/,
    ],
    [
      'x-labels with nothing to label',
      { type: 'string', 'x-labels': { a: 'A' } },
      ['x-labels'],
      /needs an "enum"/,
    ],
    [
      'x-labels outside a rating’s range',
      { type: 'integer', minimum: 1, maximum: 3, 'x-kind': 'rating', 'x-labels': { '9': 'Nine' } },
      ['x-labels', '9'],
      /not a step/,
    ],
    [
      'x-allowOther without the two branches',
      { type: 'string', enum: ['a'], 'x-allowOther': true },
      ['x-allowOther'],
      /anyOf/,
    ],
    [
      'x-allowOther that is not a boolean',
      { anyOf: [{ enum: ['a'] }, { type: 'string' }], 'x-allowOther': 1 },
      ['x-allowOther'],
      /true or false/,
    ],
  ];

  for (const [name, schema, path, message] of misuses) {
    it(`refuses ${name}, naming where`, () => {
      const context = makeContext();
      const tool = createRequestHumanInputTool({ context });

      const result = invalidSchema(tool.execute({ signalName: 'ask', answerSchema: schema }));

      const issue = result.issues.find((candidate) => candidate.message.match(message));
      expect(issue?.path).toEqual(path);
      expect(context.pendingHumanWait).toBeUndefined();
    });
  }

  it('finds a misuse inside a property, an array item, and a branch, with the path to it', () => {
    const tool = createRequestHumanInputTool({ context: makeContext() });

    const result = invalidSchema(
      tool.execute({
        signalName: 'ask',
        answerSchema: {
          type: 'object',
          properties: {
            token: { type: 'string', 'x-secret': true },
            tags: { type: 'array', items: { type: 'number', 'x-asset': true } },
            other: {
              anyOf: [
                { type: 'string', 'x-asset': true },
                { type: 'null', 'x-asset': true },
              ],
            },
          },
        },
      }),
    );

    const paths = result.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('properties.token.x-secret');
    expect(paths).toContain('properties.tags.items.x-asset');
    expect(paths).toContain('properties.other.anyOf.1.x-asset');
    expect(paths).not.toContain('properties.other.anyOf.0.x-asset');
  });

  it('refuses x-secret anywhere but the answer itself or a field reached through properties', () => {
    const tool = createRequestHumanInputTool({ context: makeContext() });
    const secret = { type: 'string', writeOnly: true, 'x-secret': true };

    const result = invalidSchema(
      tool.execute({
        signalName: 'ask',
        answerSchema: {
          type: 'object',
          properties: {
            tokens: { type: 'array', items: secret },
            either: { anyOf: [secret, { type: 'number' }] },
          },
          $defs: { hidden: secret },
        },
      }),
    );

    const paths = result.issues.map((issue) => issue.path.join('.'));
    expect(paths).toContain('properties.tokens.items.x-secret');
    expect(paths).toContain('properties.either.anyOf.0.x-secret');
    expect(paths).toContain('$defs.hidden.x-secret');
  });

  it('refuses a reference in a schema that asks for a secret, so no field is a secret by another name', () => {
    const tool = createRequestHumanInputTool({ context: makeContext() });

    const result = invalidSchema(
      tool.execute({
        signalName: 'ask',
        answerSchema: {
          type: 'object',
          properties: {
            password: { type: 'string', writeOnly: true, 'x-secret': true },
            confirmation: { $ref: '#/properties/password' },
          },
        },
      }),
    );

    expect(result.issues.map((issue) => issue.path.join('.'))).toContain(
      'properties.confirmation.$ref',
    );
  });

  it('reads x- keys in data a schema holds (enum, const, default) as data, not as keywords', () => {
    const context = makeContext();
    const tool = createRequestHumanInputTool({ context });

    const schema = {
      type: 'object',
      default: { 'x-secret': true },
      examples: [{ 'x-kind': 'slider' }],
      properties: { x: { const: { 'x-asset': true } } },
    };

    expect(parked(tool.execute({ signalName: 'ask', answerSchema: schema })).inputSchema).toEqual(
      schema,
    );
  });

  it('holds a schema configured per signal to the same x- rules, at creation', () => {
    expect(() =>
      createRequestHumanInputTool({
        context: makeContext(),
        inputSchemas: { ask: { type: 'string', 'x-secret': true } },
      }),
    ).toThrow(/writeOnly/);
  });

  it('caps how many issues one result lists', () => {
    const properties: Record<string, unknown> = {};
    for (let index = 0; index < 60; index += 1) properties[`p${index}`] = { 'x-secret': true };
    const tool = createRequestHumanInputTool({ context: makeContext() });

    const result = invalidSchema(
      tool.execute({ signalName: 'ask', answerSchema: { type: 'object', properties } }),
    );

    expect(result.issues.length).toBe(20);
  });
});
