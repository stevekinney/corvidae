import { describe, expect, test } from 'bun:test';

import { PUBLISHED_SCHEMA } from './settings-fixtures.test-support.ts';
import { formSchemaOf } from './settings-form-schema.ts';

describe('the schema a form is given', () => {
  test('reads a union as the choice SchemaForm draws, and names the form by its key', () => {
    const schema = formSchemaOf('retention.audit', PUBLISHED_SCHEMA.properties['retention.audit']);
    expect(schema['anyOf']).toBeUndefined();
    expect(schema['oneOf']).toHaveLength(2);
    expect(schema['title']).toBe('retention.audit');
  });

  test('leaves the description to the row, which draws it as Markdown', () => {
    const node = PUBLISHED_SCHEMA.properties['retention.receipts'];
    expect(node?.description).toBeString();
    expect(formSchemaOf('retention.receipts', node)['description']).toBeUndefined();
  });

  test('gives a duration its unit, whatever it is called', () => {
    const schema = formSchemaOf(
      'retention.receipts',
      PUBLISHED_SCHEMA.properties['retention.receipts'],
    );
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['olderThan']?.['format']).toBe('duration-ms');
    const history = formSchemaOf('engine.history', PUBLISHED_SCHEMA.properties['engine.history']);
    const counts = history['properties'] as Record<string, Record<string, unknown>>;
    expect(counts['maxEvents']?.['format']).toBeUndefined();
  });

  test('draws a union with null as its other branch, a number field and not JSON', () => {
    const schema = formSchemaOf(
      'engine.payloadSize',
      PUBLISHED_SCHEMA.properties['engine.payloadSize'],
    );
    const properties = schema['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['maxBytes']?.['anyOf']).toBeUndefined();
    expect(properties['maxBytes']?.['oneOf']).toBeUndefined();
    expect(properties['maxBytes']?.['type']).toBe('integer');
    // A union of two real branches is left a choice.
    const audit = formSchemaOf('retention.audit', PUBLISHED_SCHEMA.properties['retention.audit']);
    expect(audit['oneOf']).toHaveLength(2);
  });

  test('keeps the keywords the page does not read', () => {
    const schema = formSchemaOf('x', {
      type: 'object',
      properties: { n: { type: 'number', minimum: 1 } },
      additionalProperties: false,
    });
    expect(schema['additionalProperties']).toBe(false);
  });

  test('passes a node that is not an object through as an empty schema', () => {
    expect(formSchemaOf('x', null)).toEqual({ title: 'x' });
  });
});
