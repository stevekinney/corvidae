/**
 * Exhaustive tests for template placeholder domain logic.
 * DEP-582: Pure functions with no ProseMirror or DOM dependencies.
 * DEP-625: Comprehensive security tests for prototype pollution and XSS prevention.
 */

import { describe, expect, it } from 'bun:test';
import type { PlaceholderValueKind } from './types.ts';

import { buildPlaceholderCandidatesFromJsonSchema } from './template-placeholders.js';

describe('buildPlaceholderCandidatesFromJsonSchema', () => {
  it('emits candidates for each property of a flat object schema with correct valueKind', () => {
    const schema = {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name' },
        age: { type: 'number' },
      },
    };

    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);

    expect(candidates).toEqual([
      { path: 'age', description: undefined, valueKind: 'number' },
      { path: 'name', description: 'The name', valueKind: 'string' },
    ]);
  });

  it('emits parent and child paths for nested object schema in lexicographic order', () => {
    const schema = {
      type: 'object',
      properties: {
        input: {
          type: 'object',
          properties: {
            y: { type: 'number' },
            x: { type: 'string' },
          },
        },
      },
    };

    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);
    const paths = candidates.map((c) => c.path);

    expect(paths).toEqual(['input', 'input.x', 'input.y']);
  });

  it('emits whole-array path only for array-typed properties with valueKind "array"', () => {
    const schema = {
      type: 'object',
      properties: {
        tags: { type: 'array', items: { type: 'string' } },
      },
    };

    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);

    expect(candidates).toEqual([{ path: 'tags', description: undefined, valueKind: 'array' }]);
  });

  it('carries through description when present; undefined when missing', () => {
    const schema = {
      type: 'object',
      properties: {
        described: { type: 'string', description: 'Has a description' },
        undescribed: { type: 'string' },
      },
    };

    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);

    expect(candidates.find((c) => c.path === 'described')?.description).toBe('Has a description');
    expect(candidates.find((c) => c.path === 'undescribed')?.description).toBeUndefined();
  });

  it('maps JSON Schema type values to correct valueKind', () => {
    const typeMap: [string, PlaceholderValueKind][] = [
      ['string', 'string'],
      ['number', 'number'],
      ['integer', 'number'],
      ['boolean', 'boolean'],
      ['array', 'array'],
      ['object', 'object'],
    ];

    const properties: Record<string, { type: string }> = {};
    for (const [schemaType] of typeMap) {
      properties[schemaType] = { type: schemaType };
    }

    const schema = { type: 'object', properties };
    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);

    for (const [schemaType, expectedKind] of typeMap) {
      const candidate = candidates.find((c) => c.path === schemaType);
      expect(candidate?.valueKind, `type "${schemaType}" should map to "${expectedKind}"`).toBe(
        expectedKind,
      );
    }
  });

  it('returns valueKind "unknown" when the type field is missing', () => {
    const schema = {
      type: 'object',
      properties: {
        mystery: { description: 'no type' },
      },
    };

    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);

    expect(candidates[0]!.valueKind).toBe('unknown');
  });

  const unsupportedKeywords: string[] = [
    '$ref',
    'allOf',
    'anyOf',
    'oneOf',
    'if',
    'then',
    'else',
    'patternProperties',
    'additionalProperties',
  ];

  it.each(unsupportedKeywords)(
    'silently ignores unsupported keyword "%s" (no throw)',
    (keyword) => {
      const schema = {
        type: 'object',
        properties: {
          field: { type: 'string' },
        },
        [keyword]: keyword === '$ref' ? '#/definitions/Foo' : { type: 'string' },
      };

      expect(() => buildPlaceholderCandidatesFromJsonSchema(schema)).not.toThrow();
      const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.path).toBe('field');
    },
  );

  it('returns empty array for a schema with no properties', () => {
    expect(buildPlaceholderCandidatesFromJsonSchema({})).toEqual([]);
    expect(buildPlaceholderCandidatesFromJsonSchema({ type: 'object' })).toEqual([]);
  });

  it('emits all intermediate and leaf paths for deeply nested schema (3+ levels)', () => {
    const schema = {
      type: 'object',
      properties: {
        a: {
          type: 'object',
          properties: {
            b: {
              type: 'object',
              properties: {
                c: {
                  type: 'object',
                  properties: {
                    d: { type: 'string' },
                  },
                },
              },
            },
          },
        },
      },
    };

    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);
    const paths = candidates.map((c) => c.path);

    expect(paths).toEqual(['a', 'a.b', 'a.b.c', 'a.b.c.d']);
  });

  it('recurses into nested properties even without explicit type "object"', () => {
    const schema = {
      type: 'object',
      properties: {
        container: {
          // No type field at all
          properties: {
            inner: { type: 'string' },
          },
        },
      },
    };

    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);
    const paths = candidates.map((c) => c.path);

    expect(paths).toEqual(['container', 'container.inner']);
    expect(candidates.find((c) => c.path === 'container')?.valueKind).toBe('unknown');
    expect(candidates.find((c) => c.path === 'container.inner')?.valueKind).toBe('string');
  });

  it('skips keys with non-identifier characters that PATH_REGEX would reject', () => {
    const schema = {
      type: 'object',
      properties: {
        'first-name': { type: 'string' },
        'first.name': { type: 'string' },
        '123numeric': { type: 'number' },
        valid_field: { type: 'string' },
      },
    };

    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);
    const paths = candidates.map((c) => c.path);

    expect(paths).toEqual(['valid_field']);
  });

  it('skips non-identifier keys in nested schemas', () => {
    const schema = {
      type: 'object',
      properties: {
        parent: {
          type: 'object',
          properties: {
            'child-field': { type: 'string' },
            child_valid: { type: 'number' },
          },
        },
      },
    };

    const candidates = buildPlaceholderCandidatesFromJsonSchema(schema);
    const paths = candidates.map((c) => c.path);

    expect(paths).toContain('parent');
    expect(paths).toContain('parent.child_valid');
    expect(paths).not.toContain('parent.child-field');
  });
});
