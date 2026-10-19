/**
 * COR-1595. No nested object in the input of a served Bureau operation may run in Zod's strip mode.
 *
 * Weft refuses an undeclared key at an operation payload's top level (`unknownKeyPolicy`), but Zod
 * drops one inside a nested `z.object` before any later validation sees it. The published contract
 * calls every such object closed, so the runtime must as well. This guard reads the exported list,
 * so an operation or a field added later is covered without editing it.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { BUREAU_HANDLER_OPERATIONS } from './create-bureau-handler.ts';
import { findStripModeObjects } from './strip-mode-walker.test-support.ts';

/**
 * The nested objects that are loose on purpose, keyed by operation name, then by path, with why.
 * A path joins object keys with `.`, marks an array element `[]`, a record value `{}`, and a union
 * option `(index)`.
 */
const LOOSE_BY_DESIGN: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'bureau.workflows.create': {
    'definition.trigger':
      'a registered trigger kind owns its own keys, so its validator refuses the unknown ones (Unprocessable)',
  },
  'bureau.workflows.update': {
    'definition.trigger':
      'a registered trigger kind owns its own keys, so its validator refuses the unknown ones (Unprocessable)',
  },
};

describe('findStripModeObjects', () => {
  const stripped = z.object({ inner: z.string() });
  const wrapped: Record<string, z.core.$ZodType> = {
    optional: stripped.optional(),
    nullable: stripped.nullable(),
    default: stripped.default({ inner: '' }),
    array: z.array(stripped),
    union: z.union([z.string(), stripped]),
    discriminatedUnion: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('a') }),
      z.object({ kind: z.literal('b') }),
    ]),
    record: z.record(z.string(), stripped),
    intersection: z.intersection(z.looseObject({ a: z.string() }), stripped),
    pipe: stripped.pipe(z.custom<{ inner: string }>()),
    lazy: z.lazy(() => stripped),
  };

  for (const [kind, schema] of Object.entries(wrapped)) {
    it(`finds a strip-mode object under ${kind}`, () => {
      const found = findStripModeObjects(z.strictObject({ field: schema })).filter(
        (finding) => finding.mode === 'strip',
      );
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((finding) => finding.path.startsWith('field'))).toBe(true);
    });
  }

  it('names the path to the object it finds', () => {
    expect(
      findStripModeObjects(z.strictObject({ a: z.strictObject({ b: z.array(stripped) }) })),
    ).toEqual([{ path: 'a.b[]', mode: 'strip' }]);
    expect(findStripModeObjects(z.strictObject({ a: z.record(z.string(), stripped) }))).toEqual([
      { path: 'a.{}', mode: 'strip' },
    ]);
    expect(findStripModeObjects(z.strictObject({ a: z.union([z.string(), stripped]) }))).toEqual([
      { path: 'a(1)', mode: 'strip' },
    ]);
  });

  it('tells a loose object from a strip-mode one, and passes the root and a strict object', () => {
    expect(findStripModeObjects(z.object({ a: z.string() }))).toEqual([]);
    expect(findStripModeObjects(z.object({ strict: z.strictObject({ a: z.string() }) }))).toEqual(
      [],
    );
    expect(findStripModeObjects(z.object({ loose: z.looseObject({}) }))).toEqual([
      { path: 'loose', mode: 'loose' },
    ]);
  });

  it('ends on a self-referencing schema such as z.json()', () => {
    expect(findStripModeObjects(z.strictObject({ payload: z.json() }))).toEqual([]);
    const tree: z.ZodType = z.strictObject({ children: z.array(z.lazy(() => tree)) });
    expect(findStripModeObjects(z.strictObject({ tree }))).toEqual([]);
  });

  it('fails on a Zod type with children that it does not know, instead of skipping it', () => {
    expect(() => findStripModeObjects(z.strictObject({ pair: z.tuple([stripped]) }))).toThrow(
      /does not know the Zod type "tuple"/,
    );
    expect(() => findStripModeObjects(z.strictObject({ readonly: stripped.readonly() }))).toThrow(
      /does not know the Zod type "readonly"/,
    );
  });
});

describe('the input of every served Bureau operation', () => {
  it('has no nested object in strip mode, except where listed', () => {
    const unlisted: string[] = [];
    const used = new Set<string>();
    for (const operation of BUREAU_HANDLER_OPERATIONS) {
      const allowed = LOOSE_BY_DESIGN[operation.name] ?? {};
      for (const { path, mode } of findStripModeObjects(operation.inputSchema)) {
        // A strip-mode object is never excused: only a loose one, listed by name and path.
        if (mode === 'loose' && path in allowed) used.add(`${operation.name} ${path}`);
        else unlisted.push(`${operation.name} ${path}`);
      }
    }
    expect(unlisted).toEqual([]);
    // Every allowlist entry must still be needed, so the list cannot outlive the schema it excuses.
    const listed = Object.entries(LOOSE_BY_DESIGN).flatMap(([name, paths]) =>
      Object.keys(paths).map((path) => `${name} ${path}`),
    );
    expect(listed.filter((entry) => !used.has(entry))).toEqual([]);
  });
});
