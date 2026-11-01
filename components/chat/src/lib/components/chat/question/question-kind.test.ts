import { describe, expect, test } from 'bun:test';

import {
  dateTimeFromLocal,
  holdsSecret,
  issuesOfRejection,
  recordAnswer,
  SECRET_SUMMARY,
  summarizeAnswer,
  timeFromLocal,
  withoutSecrets,
} from './question-answer.ts';
import {
  choicesOf,
  classifyQuestion,
  mediaTypeMatches,
  ratingBounds,
  ratingStepsOf,
  type QuestionKind,
} from './question-kind.ts';

describe('classifyQuestion', () => {
  const cases: [string, Record<string, unknown>, QuestionKind][] = [
    ['pick one', { type: 'string', enum: ['a', 'b'] }, 'choice'],
    [
      'pick one or something else',
      {
        anyOf: [{ enum: ['a'] }, { type: 'string', maxLength: 50 }],
        'x-allowOther': true,
      },
      'choice-other',
    ],
    ['pick several', { type: 'array', uniqueItems: true, items: { enum: ['a', 'b'] } }, 'multiple'],
    ['free text', { type: 'string', maxLength: 200 }, 'text'],
    ['yes or no', { type: 'boolean' }, 'boolean'],
    ['number', { type: 'number', minimum: 0 }, 'number'],
    ['integer', { type: 'integer' }, 'number'],
    ['date', { type: 'string', format: 'date' }, 'date'],
    ['time', { type: 'string', format: 'time' }, 'time'],
    ['date and time', { type: 'string', format: 'date-time' }, 'date-time'],
    ['rating', { type: 'integer', minimum: 1, maximum: 5, 'x-kind': 'rating' }, 'rating'],
    ['a few fields', { type: 'object', properties: { a: { type: 'string' } } }, 'fields'],
    ['secret', { type: 'string', writeOnly: true, 'x-secret': true }, 'secret'],
    ['file', { type: 'string', contentMediaType: 'image/png', 'x-asset': true }, 'file'],
    ['a schema that matches nothing', {}, 'fields'],
  ];
  for (const [name, schema, kind] of cases) {
    test(`${name} is ${kind}`, () => {
      expect(classifyQuestion(schema)).toBe(kind);
    });
  }

  test('a schema key that names an inherited property does not match a kind', () => {
    expect(classifyQuestion(JSON.parse('{"__proto__":{"x-secret":true}}'))).toBe('fields');
  });
});

describe('choices and rating steps', () => {
  test('labels come from x-labels and fall back to the value', () => {
    expect(
      choicesOf({ type: 'string', enum: ['stg', 'prod'], 'x-labels': { stg: 'Staging' } }),
    ).toEqual([
      { value: 'stg', label: 'Staging' },
      { value: 'prod', label: 'prod' },
    ]);
  });

  test('a choice carries its x-descriptions entry, and only a non-empty string', () => {
    expect(
      choicesOf({
        enum: ['stg', 'prod', 'dev'],
        'x-descriptions': { stg: 'Safe to try', prod: '', dev: 7 },
      }),
    ).toEqual([
      { value: 'stg', label: 'stg', description: 'Safe to try' },
      { value: 'prod', label: 'prod' },
      { value: 'dev', label: 'dev' },
    ]);
    const bare = choicesOf({ enum: ['a'] })[0];
    expect(bare !== undefined && 'description' in bare).toBe(false);
  });

  test('a description is read from the enum of every choice shape', () => {
    const descriptions = { 'x-descriptions': { a: 'first' } };
    expect(
      choicesOf({ type: 'array', items: { enum: ['a'] }, ...descriptions })[0]?.description,
    ).toBe('first');
    expect(
      choicesOf({ anyOf: [{ enum: ['a'] }, { type: 'string' }], ...descriptions })[0]?.description,
    ).toBe('first');
  });

  test('a description keyed like an inherited property is not read', () => {
    const descriptions = JSON.parse('{"constructor":"x"}') as Record<string, unknown>;
    expect(choicesOf({ enum: ['toString'], 'x-descriptions': descriptions })[0]).toEqual({
      value: 'toString',
      label: 'toString',
    });
    expect(
      choicesOf({ enum: ['constructor'], 'x-descriptions': {} })[0]?.description,
    ).toBeUndefined();
  });

  test('a label keyed like an inherited property is not read', () => {
    const labels = JSON.parse('{"constructor":"x"}') as Record<string, unknown>;
    expect(choicesOf({ enum: ['toString'], 'x-labels': labels })[0]?.label).toBe('toString');
  });

  test('pick several and pick-or-other read their enum', () => {
    expect(choicesOf({ type: 'array', items: { enum: [1, 2] } }).map((c) => c.value)).toEqual([
      1, 2,
    ]);
    expect(choicesOf({ anyOf: [{ enum: ['a'] }, { type: 'string' }] }).map((c) => c.value)).toEqual(
      ['a'],
    );
  });

  test('a rating has one step per integer, labelled where the schema labels it', () => {
    expect(
      ratingStepsOf({ minimum: 1, maximum: 3, 'x-labels': { '1': 'Poor', '3': 'Great' } }),
    ).toEqual([
      { value: 1, label: 'Poor' },
      { value: 2, label: '2' },
      { value: 3, label: 'Great' },
    ]);
  });
});

describe('answers', () => {
  test('a secret answer reads as fixed words and the record keeps no value', () => {
    const schema = { type: 'string', writeOnly: true, 'x-secret': true };
    expect(summarizeAnswer(schema, 'hunter2')).toBe(SECRET_SUMMARY);
    const record = recordAnswer({
      toolCallId: 'c',
      toolName: 't',
      message: undefined,
      schema,
      value: 'hunter2',
    });
    expect(JSON.stringify(record)).not.toContain('hunter2');
    expect(record.secret).toBe(true);
    expect(record.value).toBeUndefined();
  });

  test('a secret field inside a few fields is masked and dropped from the kept value', () => {
    const schema = {
      type: 'object',
      properties: {
        user: { type: 'string' },
        token: { type: 'string', writeOnly: true, 'x-secret': true },
      },
    };
    expect(holdsSecret(schema)).toBe(true);
    const answer = { user: 'ada', token: 'abc123' };
    expect(summarizeAnswer(schema, answer)).toBe('user: ada, token: ••••');
    expect(withoutSecrets(schema, answer)).toEqual({ user: 'ada' });
  });

  test('choices, ratings, booleans and lists read as the person would say them', () => {
    const labelled = { type: 'string', enum: ['stg'], 'x-labels': { stg: 'Staging' } };
    expect(summarizeAnswer(labelled, 'stg')).toBe('Staging');
    expect(summarizeAnswer({ type: 'boolean' }, false)).toBe('No');
    expect(summarizeAnswer({ type: 'array', items: { enum: ['a', 'b'] } }, ['a', 'b'])).toBe(
      'a, b',
    );
    expect(summarizeAnswer({ type: 'number' }, 4)).toBe('4');
  });

  test('a pick-or-other answer reads as the choice label, or as the words the person typed', () => {
    const schema = {
      anyOf: [{ enum: ['stg'] }, { type: 'string', maxLength: 50 }],
      'x-labels': { stg: 'Staging' },
      'x-allowOther': true,
    };
    expect(summarizeAnswer(schema, 'stg')).toBe('Staging');
    expect(summarizeAnswer(schema, 'my own cluster')).toBe('my own cluster');
  });

  test('a value that is not a string, number or boolean reads as its JSON, or as nothing', () => {
    expect(summarizeAnswer({ type: 'string' }, null)).toBe('null');
    expect(summarizeAnswer({ type: 'string' }, ['a', 1])).toBe('["a",1]');
    expect(summarizeAnswer({ type: 'string' }, undefined)).toBe('');
  });

  test('moments are sent as RFC 3339', () => {
    expect(dateTimeFromLocal('2026-10-29T14:30')).toMatch(/^2026-10-29T\d{2}:30:00Z$/);
    expect(dateTimeFromLocal('')).toBeUndefined();
    expect(timeFromLocal('14:30', new Date(2026, 9, 29))).toMatch(/^\d{2}:30:00Z$/);
    expect(timeFromLocal('')).toBeUndefined();
  });

  test('only a rejection that carries issues is a refusal of the answer', () => {
    expect(issuesOfRejection(new Error('offline'))).toBeUndefined();
    expect(
      issuesOfRejection({ issues: [{ path: ['a', 0], message: 'bad' }, { nope: true }] }),
    ).toEqual([{ path: ['a', 0], message: 'bad' }]);
    expect(issuesOfRejection({ issues: [] })).toBeUndefined();
    expect(issuesOfRejection({ issues: [{ message: 'bad' }] })).toEqual([
      { path: [], message: 'bad' },
    ]);
  });
});

describe('media types and wide ratings', () => {
  test('an empty type is unknown and accepted, x- is the same type, other types are refused', () => {
    expect(mediaTypeMatches('application/yaml', '')).toBe(true);
    expect(mediaTypeMatches('application/yaml', 'application/x-yaml')).toBe(true);
    expect(mediaTypeMatches('application/x-yaml', 'application/yaml')).toBe(true);
    expect(mediaTypeMatches('image/*', 'image/png; charset=binary')).toBe(true);
    expect(mediaTypeMatches('image/png', 'text/plain')).toBe(false);
    expect(mediaTypeMatches(undefined, 'anything/at-all')).toBe(true);
  });

  test('a rating wider than the button row has no steps and reports its bounds instead', () => {
    const wide = { type: 'integer', minimum: 1, maximum: 100, 'x-kind': 'rating' };
    expect(ratingStepsOf(wide)).toEqual([]);
    expect(ratingBounds(wide)).toEqual({ minimum: 1, maximum: 100 });
    expect(ratingStepsOf({ minimum: 1, maximum: 20 })).toHaveLength(20);
  });
});
