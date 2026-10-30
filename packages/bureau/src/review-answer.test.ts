/**
 * COR-1804 — the one check an answer to a human wait passes: every kind of question accepts a
 * fitting answer and refuses a mismatched one with field-level issues, `date`, `time` and
 * `date-time` are asserted, and a schema that cannot be used fails closed.
 */
import type { HumanInputSchema } from '@lostgradient/operative';
import { describe, expect, it } from 'bun:test';

import { InteractiveSurfaceSchemaCompiler } from './interactive-surface/validation.ts';
import {
  answerFromText,
  formatReviewAnswerIssues,
  REVIEW_ANSWER_MAXIMUM_ISSUES,
  validateReviewAnswer,
} from './review-answer.ts';

const pickOne: HumanInputSchema = {
  type: 'string',
  enum: ['staging', 'production'],
  'x-labels': { staging: 'Staging', production: 'Production' },
};
const pickOneOrOther: HumanInputSchema = {
  anyOf: [{ enum: ['small', 'large'] }, { type: 'string', maxLength: 10 }],
  'x-allowOther': true,
};
const pickSeveral: HumanInputSchema = {
  type: 'array',
  uniqueItems: true,
  items: { enum: ['a', 'b', 'c'] },
  minItems: 1,
  maxItems: 2,
};
const rating: HumanInputSchema = {
  type: 'integer',
  minimum: 1,
  maximum: 5,
  'x-kind': 'rating',
  'x-labels': { '1': 'Poor', '5': 'Great' },
};
const fields: HumanInputSchema = {
  type: 'object',
  properties: { name: { type: 'string' }, count: { type: 'integer', minimum: 0 } },
  required: ['name'],
  additionalProperties: false,
};

type Case = [kind: string, schema: HumanInputSchema, accepted: unknown[], refused: unknown[]];

const cases: Case[] = [
  ['pick one', pickOne, ['staging'], ['qa', 3, null]],
  ['pick one or something else', pickOneOrOther, ['small', 'something'], ['x'.repeat(11), 5]],
  ['pick several', pickSeveral, [['a'], ['a', 'c']], [[], ['a', 'a'], ['a', 'b', 'c'], ['z'], 'a']],
  ['free text', { type: 'string', maxLength: 5 }, ['hello', ''], ['too long', 7]],
  ['yes or no', { type: 'boolean' }, [true, false], ['yes', 1, null]],
  ['number', { type: 'number', minimum: 0, maximum: 10 }, [0, 2.5, 10], [-1, 11, '3']],
  [
    'date',
    { type: 'string', format: 'date' },
    ['2026-10-29', '2028-02-29'],
    ['2027-02-29', '2026-13-01', '10/29/2026', '2026-10-29T00:00:00Z'],
  ],
  [
    'time',
    { type: 'string', format: 'time' },
    ['14:30:00Z', '09:05:59.5+02:00'],
    ['14:30', '25:00:00Z', '14:30:00'],
  ],
  [
    'date and time',
    { type: 'string', format: 'date-time' },
    ['2026-10-29T14:30:00Z', '2026-10-29t14:30:00-07:00'],
    ['2026-10-29', '2026-10-29 14:30:00Z', '2026-02-30T00:00:00Z', 'now'],
  ],
  ['rating', rating, [1, 3, 5], [0, 6, 2.5, '3']],
  [
    'a few fields',
    fields,
    [{ name: 'a' }, { name: 'a', count: 2 }],
    [{}, { name: 'a', extra: 1 }, { name: 1 }, 'a'],
  ],
  ['secret', { type: 'string', writeOnly: true, 'x-secret': true }, ['hunter2'], [12, null]],
  [
    'file',
    { type: 'string', contentMediaType: 'application/pdf', 'x-asset': true },
    ['asset-1'],
    [{}, 5],
  ],
];

describe('validateReviewAnswer: each kind of question', () => {
  for (const [kind, schema, accepted, refused] of cases) {
    it(`accepts a fitting answer to "${kind}" and refuses a mismatched one`, () => {
      for (const answer of accepted) {
        expect(validateReviewAnswer(schema, answer)).toEqual([]);
      }
      for (const answer of refused) {
        const issues = validateReviewAnswer(schema, answer);
        expect(issues.length).toBeGreaterThan(0);
        for (const issue of issues) {
          expect(typeof issue.message).toBe('string');
          expect(typeof issue.code).toBe('string');
          expect(Array.isArray(issue.path)).toBe(true);
        }
      }
    });
  }
});

describe('validateReviewAnswer: issues', () => {
  it('names the field of a structured answer, with the keyword that failed', () => {
    const issues = validateReviewAnswer(fields, { count: -1, extra: true });

    expect(issues).toContainEqual({
      path: ['name'],
      message: '"name" is required',
      code: 'required',
    });
    expect(issues).toContainEqual({
      path: ['extra'],
      message: '"extra" is not an allowed field',
      code: 'additionalProperties',
    });
    expect(issues.find((issue) => issue.code === 'minimum')?.path).toEqual(['count']);
  });

  it('uses array indexes as numbers in a path', () => {
    const issues = validateReviewAnswer(pickSeveral, ['a', 'z']);

    expect(issues.find((issue) => issue.code === 'enum')?.path).toEqual([1]);
  });

  it('unescapes a property name that holds a slash or a tilde', () => {
    const schema = {
      type: 'object',
      properties: { 'a/b': { type: 'string' }, 'c~d': { type: 'string' } },
    } as const;

    const issues = validateReviewAnswer(schema, { 'a/b': 1, 'c~d': 2 });

    expect(issues.map((issue) => issue.path)).toEqual([['a/b'], ['c~d']]);
  });

  it('says what a choice may be and what a date must look like', () => {
    expect(validateReviewAnswer(pickOne, 'qa')[0]?.message).toBe(
      'The answer must be one of "staging", "production"',
    );
    expect(validateReviewAnswer({ type: 'string', format: 'date' }, 'soon')[0]?.message).toBe(
      'The answer must be a date as YYYY-MM-DD',
    );
  });

  it('reports one issue for the answer when a choice-or-text answer fits neither branch', () => {
    const issues = validateReviewAnswer(pickOneOrOther, 'x'.repeat(11));

    expect(issues.some((issue) => issue.code === 'maxLength')).toBe(true);
    // The generic "must match a schema in anyOf" adds nothing beside the branch that says why.
    expect(issues.some((issue) => issue.code === 'anyOf')).toBe(false);
  });

  it('keeps the summary error when it is all there is', () => {
    const issues = validateReviewAnswer({ oneOf: [{ type: 'string' }, { maxLength: 5 }] }, 'abc');

    expect(issues.map((issue) => issue.code)).toEqual(['oneOf']);
  });

  it('caps what it reports', () => {
    const issues = validateReviewAnswer(
      { type: 'array', items: { type: 'string' } },
      Array.from({ length: 500 }, (_, index) => index),
    );

    expect(issues).toHaveLength(REVIEW_ANSWER_MAXIMUM_ISSUES);
  });

  it('formats the issues as one line', () => {
    const issues = validateReviewAnswer(fields, {});

    expect(formatReviewAnswerIssues(issues)).toBe('"name" is required');
  });
});

describe('validateReviewAnswer: no answer, and a schema it cannot use', () => {
  it('requires an answer when the schema is there, whatever the schema would accept', () => {
    expect(validateReviewAnswer({}, undefined)).toEqual([
      {
        path: [],
        message: 'An answer matching the question’s schema is required to approve it',
        code: 'required',
      },
    ]);
  });

  it('accepts null where the schema does', () => {
    expect(validateReviewAnswer({ type: 'null' }, null)).toEqual([]);
  });

  it('fails closed on a schema that uses a pattern', () => {
    const issues = validateReviewAnswer({ type: 'string', pattern: '^a+$' }, 'aaa');

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: [], code: 'schema' });
    expect(issues[0]?.message).toContain('pattern');
  });

  it('fails closed on a schema with an $id', () => {
    expect(validateReviewAnswer({ $id: 'https://x.test/s', type: 'string' }, 'a')[0]?.code).toBe(
      'schema',
    );
  });

  it('treats a format it does not assert as an annotation', () => {
    expect(validateReviewAnswer({ type: 'string', format: 'email' }, 'not an email')).toEqual([]);
  });

  it('asserts formats only for a compiler asked to: an interactive surface’s schemas keep them as annotations', () => {
    const schema = { type: 'string', format: 'date' } as const;

    expect(new InteractiveSurfaceSchemaCompiler().check(schema, 'nope')).toBeUndefined();
    expect(
      new InteractiveSurfaceSchemaCompiler({ formats: { date: () => false } }).check(
        schema,
        'nope',
      ),
    ).toBeDefined();
    // And the cached validator of the answer check gives the same answer twice.
    expect(validateReviewAnswer(schema, 'nope')).toHaveLength(1);
    expect(validateReviewAnswer(schema, 'nope')).toHaveLength(1);
  });
});

describe('answerFromText', () => {
  const ports: HumanInputSchema = {
    anyOf: [{ enum: ['8080', '3000'] }, { type: 'string' }],
    'x-allowOther': true,
  };
  const object: HumanInputSchema = {
    type: 'object',
    properties: { replicas: { type: 'integer' } },
    required: ['replicas'],
  };

  it.each([
    ['an enum-plus-other question, a choice that looks like a number', ports, '8080', '8080'],
    ['an enum-plus-other question, other text', ports, 'other text', 'other text'],
    ['an enum-plus-other question, other digits', ports, '42', '42'],
    ['an enum-plus-other question, other true', ports, 'true', 'true'],
    ['a string question, JSON-looking text', { type: 'string' }, '{"a":1}', '{"a":1}'],
    [
      'a string question, digits that break its limit',
      { type: 'string', maxLength: 2 },
      '123',
      '123',
    ],
  ] as const)('keeps the text as written for %s', (_name, schema, text, expected) => {
    expect(answerFromText(schema, text)).toBe(expected);
  });

  it.each([
    ['an integer', { type: 'integer' }, '3', 3],
    ['a boolean', { type: 'boolean' }, 'true', true],
    ['an object', object, '{"replicas":2}', { replicas: 2 }],
  ] as const)('reads text that does not fit as JSON for %s', (_name, schema, text, expected) => {
    expect(answerFromText(schema, text)).toEqual(expected);
  });

  it('keeps text that is neither a fit nor JSON, so the type it should be is named', () => {
    expect(answerFromText({ type: 'integer' }, 'three')).toBe('three');
    expect(validateReviewAnswer({ type: 'integer' }, 'three')[0]).toMatchObject({ code: 'type' });
  });
});
