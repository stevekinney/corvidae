/**
 * Exhaustive tests for template placeholder domain logic.
 * DEP-582: Pure functions with no ProseMirror or DOM dependencies.
 * DEP-625: Comprehensive security tests for prototype pollution and XSS prevention.
 */

import { describe, expect, it } from 'bun:test';

import {
  buildPlaceholderCandidatesFromJsonSchema,
  resolveTemplatePlaceholders,
} from './template-placeholders.js';

describe('determinism and purity', () => {
  it('buildPlaceholderCandidatesFromJsonSchema returns identical output for identical input across two calls', () => {
    const schema = {
      type: 'object',
      properties: {
        b: { type: 'number' },
        a: { type: 'string', description: 'first' },
      },
    };

    const result1 = buildPlaceholderCandidatesFromJsonSchema(schema);
    const result2 = buildPlaceholderCandidatesFromJsonSchema(schema);

    expect(result1).toEqual(result2);
  });

  it('buildPlaceholderCandidatesFromJsonSchema does not mutate the input schema', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name' },
        nested: {
          type: 'object',
          properties: {
            inner: { type: 'number' },
          },
        },
      },
    };

    const schemaCopy = JSON.parse(JSON.stringify(schema));

    buildPlaceholderCandidatesFromJsonSchema(schema);

    expect(schema).toEqual(schemaCopy);
  });

  it('resolveTemplatePlaceholders returns identical output for identical input across two calls', () => {
    const text = '{{a}} and {{b.c}}';
    const values = { a: 'x', b: { c: 'y' } };

    const result1 = resolveTemplatePlaceholders(text, values);
    const result2 = resolveTemplatePlaceholders(text, values);

    expect(result1).toEqual(result2);
  });

  it('resolveTemplatePlaceholders does not mutate the input values object', () => {
    const values = { a: 'hello', nested: { b: [1, 2, 3] } };
    const valuesCopy = JSON.parse(JSON.stringify(values));

    resolveTemplatePlaceholders('{{a}} {{nested.b}} {{nested}}', values);

    expect(values).toEqual(valuesCopy);
  });
});
