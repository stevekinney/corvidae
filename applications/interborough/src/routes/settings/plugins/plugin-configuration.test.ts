/** The configuration form of a plugin, worked out from the JSON Schema its own Zod schema writes. */
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import {
  configurationFields,
  configurationToSave,
  fieldWords,
  jsonText,
  parseJsonField,
  refusedField,
} from './plugin-configuration.ts';

/** What a plugin's own Zod schema becomes: one field of each control the form has. */
const SCHEMA = z.toJSONSchema(
  z.object({
    searchAddress: z.string().meta({ title: 'Search address', description: 'The service.' }),
    region: z.enum(['us', 'eu']).optional(),
    blockedSites: z.array(z.string()).default([]),
    includeSnippets: z.boolean().default(true),
    cacheMs: z.number().default(300_000),
    limit: z.number().min(0).max(1).default(0.8),
    roots: z.array(z.object({ path: z.string() })).default([]),
    nickname: z.string().nullable().optional(),
  }),
  { io: 'input' },
);

describe('configurationFields', () => {
  test('reads a field for each property, in the order the schema declares them, with the control its shape calls for', () => {
    const fields = configurationFields(SCHEMA);
    expect(fields.map((field) => [field.key, field.control.kind])).toEqual([
      ['searchAddress', 'text'],
      ['region', 'select'],
      ['blockedSites', 'tags'],
      ['includeSnippets', 'switch'],
      ['cacheMs', 'duration'],
      ['limit', 'number'],
      ['roots', 'json'],
      ['nickname', 'text'],
    ]);
    expect(fields[1]?.control).toEqual({ kind: 'select', options: ['us', 'eu'] });
  });

  test('takes the schema’s title and description, and the key as words when there is no title', () => {
    const [address, region] = configurationFields(SCHEMA);
    expect(address).toMatchObject({
      label: 'Search address',
      description: 'The service.',
      required: true,
    });
    expect(region).toMatchObject({ label: 'Region', description: '', required: false });
    expect(configurationFields(SCHEMA).find((field) => field.key === 'cacheMs')?.defaultValue).toBe(
      300_000,
    );
  });

  test('draws a schema that is not an object with properties as no form at all', () => {
    expect(configurationFields(null)).toEqual([]);
    expect(configurationFields({ type: 'string' })).toEqual([]);
  });
});

describe('words and values', () => {
  test('puts a key in words', () => {
    expect(fieldWords('blockedSites')).toBe('Blocked sites');
    expect(fieldWords('search-address')).toBe('Search address');
    expect(fieldWords('')).toBe('');
  });

  test('sends only the fields that hold something', () => {
    expect(configurationToSave({ a: 'x', b: '', c: undefined, d: 0, e: false, f: [] })).toEqual({
      a: 'x',
      d: 0,
      e: false,
      f: [],
    });
  });

  test('finds the field a refusal names, and none for any other kind of refusal', () => {
    expect(refusedField('configuration.searchAddress')).toBe('searchAddress');
    expect(refusedField('configuration.roots.0.path')).toBe('roots');
    expect(refusedField('configuration')).toBeUndefined();
    expect(refusedField('enabled')).toBeUndefined();
    expect(refusedField(undefined)).toBeUndefined();
  });

  test('reads the fallback editor’s text back, or says it is not JSON', () => {
    expect(jsonText(undefined)).toBe('');
    expect(jsonText({ a: 1 })).toBe('{\n  "a": 1\n}');
    expect(parseJsonField('')).toEqual({ value: undefined });
    expect(parseJsonField('[1]')).toEqual({ value: [1] });
    expect(parseJsonField('{')).toBe('invalid');
  });
});
