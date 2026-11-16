/**
 * COR-2177 — which fields of a reaction's configuration are secret, and what a stored reference is.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import {
  isSecretReference,
  issueIsAtSecret,
  secretFieldAt,
  secretFieldsOf,
  withValueAt,
  withoutValues,
} from './secret-references.ts';

const marked = z.string().meta({ secret: true });

describe('secretFieldsOf', () => {
  it('finds a marked field however it is made optional, defaulted or refined, and however deep it nests', () => {
    const schema = z.object({
      channel: z.string(),
      plain: marked,
      optional: marked.optional(),
      defaulted: marked.default('x'),
      refined: marked.refine((value) => value.length > 1),
      late: z.string().optional().meta({ secret: true }),
      nested: z.object({ token: marked, other: z.number() }),
    });
    expect(secretFieldsOf(schema)).toEqual({
      paths: [['plain'], ['optional'], ['defaulted'], ['refined'], ['late'], ['nested', 'token']],
    });
  });

  it('finds nothing in a schema with no marker', () => {
    expect(secretFieldsOf(z.object({ channel: z.string() }))).toEqual({ paths: [] });
  });

  it('refuses a marker under items, anyOf or additionalProperties, and one on the root', () => {
    for (const schema of [
      z.object({ tokens: z.array(marked) }),
      z.object({ token: marked.nullable() }),
      z.object({ token: z.union([marked, z.number()]) }),
      z.object({ tokens: z.record(z.string(), marked) }),
      marked,
    ]) {
      expect(secretFieldsOf(schema)).toHaveProperty('refusal');
    }
  });

  it('refuses a nullable secret whichever order the marker and the nullable are written in', () => {
    for (const schema of [
      z.object({ token: z.string().meta({ secret: true }).nullable() }),
      z.object({ token: z.string().nullable().meta({ secret: true }) }),
      z.object({ token: z.union([z.string(), z.number()]).meta({ secret: true }) }),
    ]) {
      expect(secretFieldsOf(schema)).toHaveProperty('refusal');
    }
  });

  it('reads a marker from the schema, never from a default or an example value that holds one', () => {
    for (const schema of [
      z.object({ secret: z.boolean() }).default({ secret: true }),
      z.object({ flag: z.object({ secret: z.boolean() }).default({ secret: true }) }),
      z.object({ note: z.string().meta({ examples: [{ secret: true }] }) }),
      z.object({ mode: z.literal('a').meta({ default: { secret: true } }) }),
    ]) {
      expect(secretFieldsOf(schema)).toEqual({ paths: [] });
    }
    // A property that happens to be called `default` or `examples` is still a field of the object.
    expect(secretFieldsOf(z.object({ default: marked, examples: z.string() }))).toEqual({
      paths: [['default']],
    });
  });

  it('finds no marker in a schema Zod cannot write as JSON Schema', () => {
    const foreign = { safeParse: (value: unknown) => ({ success: true, data: value }) };
    expect(secretFieldsOf(foreign as unknown as z.ZodType)).toEqual({ paths: [] });
  });
});

describe('isSecretReference', () => {
  it('accepts exactly { "$secret": key } with a key Bungalow accepts', () => {
    expect(isSecretReference({ $secret: 'slack-token' })).toBe(true);
    expect(isSecretReference({ $secret: '0-start' })).toBe(true);
    for (const value of [
      { $secret: 'slack-token', extra: 1 },
      { $secret: 'Slack' },
      { $secret: '-slack' },
      { $secret: 'a_b' },
      { $secret: '' },
      { $secret: 3 },
      {},
      [],
      null,
      'slack-token',
      Object.create({ $secret: 'inherited' }),
    ]) {
      expect(isSecretReference(value)).toBe(false);
    }
  });
});

describe('the helpers that read and write along a path', () => {
  it('reads only a field that is present, through own properties', () => {
    const configuration = { a: { b: 'x' }, c: undefined };
    expect(secretFieldAt(configuration, ['a', 'b'])).toEqual({ value: 'x' });
    expect(secretFieldAt(configuration, ['a', 'missing'])).toBeUndefined();
    expect(secretFieldAt(configuration, ['toString'])).toBeUndefined();
    expect(secretFieldAt('text', ['a'])).toBeUndefined();
  });

  it('writes into a copy and leaves the original alone', () => {
    const stored = { channel: 'ops', auth: { token: { $secret: 'k' } } };
    const resolved = withValueAt(stored, ['auth', 'token'], 'value');
    expect(resolved).toEqual({ channel: 'ops', auth: { token: 'value' } });
    expect(stored).toEqual({ channel: 'ops', auth: { token: { $secret: 'k' } } });
  });

  it('ignores an issue only at or beneath a secret field', () => {
    const paths = [['token'], ['auth', 'key']];
    expect(issueIsAtSecret(['token'], paths)).toBe(true);
    expect(issueIsAtSecret(['auth', 'key'], paths)).toBe(true);
    expect(issueIsAtSecret(['auth', 'key', 0], paths)).toBe(true);
    expect(issueIsAtSecret(['auth'], paths)).toBe(false);
    expect(issueIsAtSecret(['channel'], paths)).toBe(false);
    expect(issueIsAtSecret([], paths)).toBe(false);
  });

  it('removes every resolved value from a text, the longest first', () => {
    const values = new Set(['abc', 'abcdef']);
    expect(withoutValues('x abcdef y abc z', values)).toBe('x [redacted] y [redacted] z');
    expect(withoutValues('nothing here', values)).toBe('nothing here');
  });
});
