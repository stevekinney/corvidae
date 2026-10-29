/**
 * COR-855 — the interrupt vocabulary on its own: the key that identifies a set of
 * interrupts in the command ledger, and the schema that advertises the answer.
 */
import Ajv from 'ajv';
import { describe, expect, it } from 'bun:test';

import type { PendingReview } from '../types.ts';
import {
  interruptKey,
  RESUME_PAYLOAD_SCHEMA,
  responseSchemaFor,
  toInterrupt,
} from './ag-ui-interrupts.ts';

function approval(id: string, round: number): PendingReview {
  return { kind: 'tool-approval', id, round } as unknown as PendingReview;
}
function humanWait(id: string): PendingReview {
  return { kind: 'human-wait', id } as unknown as PendingReview;
}

describe('interruptKey', () => {
  it('names a set the same whatever order it is given in', () => {
    expect(interruptKey([approval('b', 1), humanWait('a')])).toBe(
      interruptKey([humanWait('a'), approval('b', 1)]),
    );
  });

  it('tells apart sets whose joined text would be the same', () => {
    const one = interruptKey([approval('a@1,b', 0)]);
    const two = interruptKey([approval('a', 1), approval('b', 0)]);

    expect(one).not.toBe(two);
  });

  it('tells apart an id that ends where another begins', () => {
    expect(interruptKey([humanWait('x,y')])).not.toBe(
      interruptKey([humanWait('x'), humanWait('y')]),
    );
  });

  it('moves with the round of a tool approval', () => {
    expect(interruptKey([approval('a', 0)])).not.toBe(interruptKey([approval('a', 1)]));
  });
});

describe('the advertised response schema', () => {
  const validate = new Ajv({ strict: false }).compile(RESUME_PAYLOAD_SCHEMA);

  it.each([
    [{ decision: 'approve' }],
    [{ decision: 'approve', arguments: { cents: 1 } }],
    [{ decision: 'approve', answer: 'yes' }],
    [{ decision: 'deny' }],
    [{ decision: 'deny', reason: 'no' }],
    [{ decision: 'reject', reason: 'Wrong customer' }],
  ])('accepts %j', (payload) => {
    expect(validate(payload)).toBe(true);
  });

  it.each([
    ['a reject with no reason', { decision: 'reject' }],
    ['a reject with a blank reason', { decision: 'reject', reason: '   ' }],
    ['an unknown decision', { decision: 'maybe' }],
    ['a payload with no decision', {}],
    ['a field it does not define', { decision: 'approve', extra: 1 }],
  ])('refuses %s', (_name, payload) => {
    expect(validate(payload)).toBe(false);
  });
});

describe('the response schema of a question that carries its own answer schema (COR-1804)', () => {
  const answerSchema = {
    type: 'string',
    enum: ['staging', 'production'],
    'x-labels': { staging: 'Staging', production: 'Production' },
  } as const;

  it('is the generic resume schema when there is no answer schema', () => {
    expect(responseSchemaFor(undefined)).toBe(RESUME_PAYLOAD_SCHEMA);
  });

  it('keeps decision and reason, and embeds the answer schema as properties.answer', () => {
    const schema = responseSchemaFor(answerSchema) as {
      properties: Record<string, unknown>;
      required: string[];
    };

    expect(Object.keys(schema.properties).toSorted()).toEqual([
      'answer',
      'arguments',
      'decision',
      'reason',
    ]);
    expect(schema.properties['answer']).toEqual(answerSchema);
    expect(schema.required).toEqual(['decision']);
  });

  const validate = new Ajv({ strict: false }).compile(responseSchemaFor(answerSchema));

  it.each([
    [{ decision: 'approve', answer: 'staging' }],
    [{ decision: 'deny' }],
    [{ decision: 'deny', reason: 'no', answer: 'staging' }],
    [{ decision: 'reject', reason: 'Wrong customer' }],
  ])('accepts %j', (payload) => {
    expect(validate(payload)).toBe(true);
  });

  it.each([
    ['an approval with no answer', { decision: 'approve' }],
    ['an approval with an answer outside the enum', { decision: 'approve', answer: 'qa' }],
    ['a reject with no reason', { decision: 'reject' }],
    ['a field it does not define', { decision: 'approve', answer: 'staging', extra: 1 }],
  ])('refuses %s', (_name, payload) => {
    expect(validate(payload)).toBe(false);
  });

  it('rebases the answer schema’s own local references so they still resolve', () => {
    const withDefinitions = {
      $defs: { choice: { enum: ['a', 'b'] } },
      type: 'object',
      properties: { pick: { $ref: '#/$defs/choice' }, again: { $ref: '#/properties/pick' } },
      default: { $ref: '#/not-a-reference' },
    };
    const schema = responseSchemaFor(withDefinitions) as {
      properties: { answer: typeof withDefinitions };
    };

    expect(schema.properties.answer.properties.pick.$ref).toBe('#/properties/answer/$defs/choice');
    expect(schema.properties.answer.properties.again.$ref).toBe(
      '#/properties/answer/properties/pick',
    );
    // Data a schema holds is not a reference.
    expect(schema.properties.answer.default).toEqual({ $ref: '#/not-a-reference' });
    const check = new Ajv({ strict: false }).compile(schema);
    expect(check({ decision: 'approve', answer: { pick: 'a' } })).toBe(true);
    expect(check({ decision: 'approve', answer: { pick: 'z' } })).toBe(false);
  });

  it('rebases references under properties and definitions named like keywords that hold data', () => {
    // A property called `enum` (or `const`, `default`, `examples`) holds a subschema, not data.
    const named = {
      $defs: { text: { type: 'string' }, const: { type: 'integer' } },
      type: 'object',
      properties: {
        enum: { $ref: '#/$defs/text' },
        const: { $ref: '#/$defs/const' },
        default: { items: { $ref: '#/$defs/text' } },
        examples: { anyOf: [{ $ref: '#/$defs/text' }] },
      },
    };
    const schema = responseSchemaFor(named) as {
      properties: { answer: Record<string, any> };
    };

    const { properties: rebased } = schema.properties.answer;
    expect(rebased.enum.$ref).toBe('#/properties/answer/$defs/text');
    expect(rebased.const.$ref).toBe('#/properties/answer/$defs/const');
    expect(rebased.default.items.$ref).toBe('#/properties/answer/$defs/text');
    expect(rebased.examples.anyOf[0].$ref).toBe('#/properties/answer/$defs/text');
    const check = new Ajv({ strict: false }).compile(schema);
    expect(check({ decision: 'approve', answer: { enum: 'x', const: 1 } })).toBe(true);
    expect(check({ decision: 'approve', answer: { enum: 2 } })).toBe(false);
  });

  it('rides on the human-wait interrupt, and a wait without a schema keeps the generic one', () => {
    const wait = {
      kind: 'human-wait',
      id: 'human-wait:run-1:ask:0',
      runId: 'run-1',
      sessionId: 'session-1',
      signalName: 'ask',
      prompt: 'Where?',
      inputSchema: answerSchema,
      requestedAt: 0,
      ageMilliseconds: 0,
      agentName: 'a',
    } as unknown as PendingReview;
    const plain = { ...wait, inputSchema: undefined } as unknown as PendingReview;

    const interrupt = toInterrupt(wait);

    expect(interrupt.responseSchema).toEqual(responseSchemaFor(answerSchema));
    expect(toInterrupt(plain).responseSchema).toBe(RESUME_PAYLOAD_SCHEMA);
  });
});
