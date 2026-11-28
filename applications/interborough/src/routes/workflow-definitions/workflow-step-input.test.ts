/**
 * The input a workflow step starts with, from the schema the Bureau's catalog gives its activity
 * (COR-2774): the schema as Zod published it, a union left a union and a nullable field left
 * nullable, so the starting input is what the form shows and the form checks what it was given.
 */
import { validateSchemaFormValue } from '@lostgradient/cinder';
import { describe, expect, test } from 'bun:test';

import { startingInput, stepFormSchema } from './workflow-step-input.ts';

const ACTIVITY = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    retain: {
      anyOf: [
        { type: 'string', const: 'forever' },
        {
          type: 'object',
          properties: { olderThan: { type: 'number', unit: 'milliseconds' } },
          required: ['olderThan'],
        },
      ],
    },
    limit: { anyOf: [{ type: 'integer' }, { type: 'null' }] },
    fallback: {
      anyOf: [{ const: false }, { type: 'object', properties: { count: { type: 'integer' } } }],
    },
  },
  required: ['retain'],
};

describe('the schema of a step’s input', () => {
  test('is the activity’s schema, without the dialect marker and titled by the activity', () => {
    const schema = stepFormSchema('archive', ACTIVITY);
    expect(schema?.['$schema']).toBeUndefined();
    expect(schema?.['title']).toBe('archive');
    expect(schema?.['properties']).toEqual(ACTIVITY.properties);
  });

  test('says nothing for an activity that declares none', () => {
    expect(stepFormSchema('archive', null)).toBeUndefined();
    expect(startingInput('archive', null)).toBeUndefined();
  });

  test('accepts the values its unions hold, a null and a false among them', async () => {
    const schema = stepFormSchema('archive', ACTIVITY);
    if (schema === undefined) throw new Error('The schema is missing.');
    for (const input of [
      { retain: 'forever' },
      { retain: { olderThan: 60_000 }, limit: null },
      { retain: 'forever', limit: 4, fallback: false },
      { retain: 'forever', fallback: { count: 2 } },
    ]) {
      const result = await validateSchemaFormValue(schema, input);
      expect(result.valid, JSON.stringify(input)).toBe(true);
    }
    const refused = await validateSchemaFormValue(schema, { retain: 'forever', limit: false });
    expect(refused.valid).toBe(false);
  });
});

describe('the input a new step starts with', () => {
  test('is the first alternative of a union, and null for a nullable field', async () => {
    const input = startingInput('archive', ACTIVITY);
    expect(input).toMatchObject({ retain: 'forever', limit: null });
    const schema = stepFormSchema('archive', ACTIVITY);
    if (schema === undefined) throw new Error('The schema is missing.');
    const result = await validateSchemaFormValue(schema, input);
    expect(result.valid).toBe(true);
  });
});
