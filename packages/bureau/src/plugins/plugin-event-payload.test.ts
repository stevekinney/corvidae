/**
 * COR-2223 — what the payload of a declared event may hold, and the fields it lists as. One walk
 * answers both, so the refusal and the catalog cannot disagree.
 */
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { eventPayloadContent, eventPayloadFields, isEventPayload } from './plugin-event-payload.ts';

const identifier = () => z.string().meta({ identifier: true });

describe('eventPayloadContent', () => {
  it('accepts identifiers, statuses and counts', () => {
    expect(
      eventPayloadContent(
        z.object({
          greetingId: identifier(),
          status: z.enum(['sent', 'failed']),
          count: z.number().int(),
          urgent: z.boolean(),
          kind: z.literal('greeting'),
        }),
      ),
    ).toEqual([]);
  });

  it('refuses a free string, naming the field', () => {
    expect(eventPayloadContent(z.object({ greetingId: identifier(), text: z.string() }))).toEqual([
      'text',
    ]);
  });

  it.each([
    ['optional', () => identifier().optional()],
    ['nullable', () => identifier().nullable()],
    ['with a default', () => identifier().default('x')],
    ['readonly', () => identifier().readonly()],
  ])('accepts a marked identifier that is %s', (_name, build) => {
    expect(eventPayloadContent(z.object({ id: build() }))).toEqual([]);
  });

  it('accepts the marker on either side of a wrapper, and refuses a wrapper with none', () => {
    expect(
      eventPayloadContent(z.object({ id: z.string().optional().meta({ identifier: true }) })),
    ).toEqual([]);
    expect(eventPayloadContent(z.object({ id: z.string().optional() }))).toEqual(['id']);
    expect(eventPayloadContent(z.object({ id: z.string().nullable().default('x') }))).toEqual([
      'id',
    ]);
  });

  it('does not take any other meta as the marker', () => {
    expect(
      eventPayloadContent(
        z.object({
          a: z.string().meta({ identifier: false }),
          b: z.string().meta({ description: 'an id' }),
          c: z.string().describe('an identifier'),
        }),
      ),
    ).toEqual(['a', 'b', 'c']);
  });

  it('does not let the marker excuse a value that is not a string', () => {
    expect(eventPayloadContent(z.object({ any: z.unknown().meta({ identifier: true }) }))).toEqual([
      'any',
    ]);
  });

  it('accepts a z.enum as a status, optional or not', () => {
    expect(
      eventPayloadContent(
        z.object({ status: z.enum(['a', 'b']), later: z.enum(['a']).optional() }),
      ),
    ).toEqual([]);
  });

  it('follows nested objects, arrays and unions, and names the path', () => {
    expect(
      eventPayloadContent(
        z.object({
          customer: z.object({ id: identifier(), note: z.string() }),
          lines: z.array(z.string()),
          ids: z.array(identifier()),
          either: z.union([z.number(), z.string()]),
          fine: z.union([z.number(), identifier()]),
        }),
      ),
    ).toEqual(['customer.note', 'lines[]', 'either']);
  });

  it.each([
    ['z.unknown()', () => z.unknown()],
    ['z.any()', () => z.any()],
    ['a record', () => z.record(z.string(), z.number())],
    ['a tuple', () => z.tuple([z.number()])],
    ['a date', () => z.date()],
    ['a lazy schema', () => z.lazy(() => z.number())],
    ['a template literal', () => z.templateLiteral(['a-', z.number()])],
  ])('refuses %s', (_name, build) => {
    expect(eventPayloadContent(z.object({ value: build() }))).toEqual(['value']);
  });

  it('refuses an object that accepts any other key', () => {
    expect(eventPayloadContent(z.looseObject({ id: identifier() }))).toEqual(['*']);
    expect(eventPayloadContent(z.object({ id: identifier() }).catchall(z.string()))).toEqual(['*']);
    expect(eventPayloadContent(z.strictObject({ id: identifier() }))).toEqual([]);
    expect(eventPayloadContent(z.object({ nested: z.looseObject({}) }))).toEqual(['nested.*']);
  });

  it('reads a pipe through the schema it parses', () => {
    expect(eventPayloadContent(z.object({ n: z.string().transform(Number) }))).toEqual(['n']);
    expect(eventPayloadContent(z.object({ n: identifier().transform(Number) }))).toEqual([]);
  });
});

describe('a payload that recurses', () => {
  const tree = () => {
    const Node = z.object({
      id: identifier(),
      get children() {
        return z.array(Node).optional();
      },
    });
    return Node;
  };
  const noisyTree = () => {
    const Node = z.object({
      id: identifier(),
      note: z.string(),
      get children() {
        return z.array(Node).optional();
      },
    });
    return Node;
  };

  it('is walked once and accepted when every leaf passes', () => {
    expect(eventPayloadContent(z.object({ root: tree() }))).toEqual([]);
  });

  it('is refused for the leaf that carries content, named once', () => {
    expect(eventPayloadContent(z.object({ root: noisyTree() }))).toEqual(['root.note']);
  });

  it('lists the fields of the payload without walking into the recursion', () => {
    expect(eventPayloadFields(z.object({ root: tree() }))).toEqual([
      { name: 'root', type: 'object', optional: false },
    ]);
  });
});

/**
 * COR-2223, round two — the walk's cost is bounded by the schemas it reads, not by the paths
 * through them, so every payload settles. Each row asserts a result, never a duration: a payload
 * the walk cannot finish is refused at the path where its budget ran out.
 */
describe('the outcome of every payload shape', () => {
  /** A schema that builds a new object on every read, through `wrap`: it has no end. */
  const freshOne = (wrap: (inner: z.ZodObject) => z.ZodType = (inner) => inner.optional()) => {
    const fresh = (): z.ZodObject =>
      z.object({
        get next() {
          return wrap(fresh());
        },
      });
    return fresh();
  };
  const freshTwo = () => {
    const fresh = (): z.ZodObject =>
      z.object({
        get l() {
          return fresh().optional();
        },
        get r() {
          return fresh().optional();
        },
      });
    return fresh();
  };
  /** `count` objects that hold each other through fresh unions: stable identities, factorial paths. */
  const mutual = (count: number, noteAt?: number) => {
    const nodes: z.ZodObject[] = [];
    for (let index = 0; index < count; index += 1) {
      nodes.push(
        z.object({
          id: identifier(),
          ...(index === noteAt ? { note: z.string() } : {}),
          get next() {
            return z.union(nodes).optional();
          },
        }),
      );
    }
    return nodes[0]!;
  };
  const shared = z.object({ id: identifier(), note: z.string() });
  const childless = () => {
    const Node = z.object({
      id: identifier(),
      get children() {
        return z.array(Node).optional();
      },
      after: z.string(),
    });
    return Node;
  };

  const refusedAtBudget = (prefix: string) => (found: string[]) => {
    expect(found).toHaveLength(1);
    expect(found[0]?.startsWith(prefix)).toBe(true);
  };

  const rows: ReadonlyArray<readonly [string, () => z.ZodObject, (found: string[]) => void]> = [
    [
      'a clean fresh factory with one getter: refused, budget exhausted',
      () => z.object({ root: freshOne() }),
      refusedAtBudget('root.next'),
    ],
    [
      'a fresh factory with two getters: refused, budget exhausted',
      () => z.object({ root: freshTwo() }),
      refusedAtBudget('root.l'),
    ],
    [
      'a fresh factory through an array: refused, budget exhausted',
      () => z.object({ root: freshOne((inner) => z.array(inner)) }),
      refusedAtBudget('root.next'),
    ],
    [
      'a fresh factory through a union: refused, budget exhausted',
      () => z.object({ root: freshOne((inner) => z.union([inner, z.number()])) }),
      refusedAtBudget('root.next'),
    ],
    [
      'a fresh factory through nullable and default: refused, budget exhausted',
      () => z.object({ root: freshOne((inner) => inner.nullable().default(null)) }),
      refusedAtBudget('root.next'),
    ],
    [
      'a fresh factory through a pipe: refused, budget exhausted',
      () => z.object({ root: freshOne((inner) => inner.transform((value) => value)) }),
      refusedAtBudget('root.next'),
    ],
    [
      'a record of a fresh factory: refused as a record, never entered',
      () => z.object({ root: z.record(z.string(), freshOne()) }),
      (found) => expect(found).toEqual(['root']),
    ],
    [
      'a lazy fresh factory: refused as a lazy schema, never entered',
      () => z.object({ root: z.lazy(() => freshOne()) }),
      (found) => expect(found).toEqual(['root']),
    ],
    [
      'twelve stable objects holding each other through unions, every leaf clean: accepted',
      () => z.object({ root: mutual(12) }),
      (found) => expect(found).toEqual([]),
    ],
    [
      'twelve stable objects holding each other, one with a free string: refused, naming it',
      () => z.object({ root: mutual(12, 7) }),
      (found) => {
        expect(found.length).toBeGreaterThan(0);
        expect(found.length).toBeLessThanOrEqual(32);
        for (const path of found) expect(path.endsWith('note')).toBe(true);
      },
    ],
    [
      'a getter that recurses through a stable object, leaves clean: accepted',
      () => {
        const Node = z.object({
          id: identifier(),
          get children() {
            return z.array(Node).optional();
          },
        });
        return z.object({ root: Node });
      },
      (found) => expect(found).toEqual([]),
    ],
    [
      'content after the point where the cycle closes: found',
      () => z.object({ root: childless() }),
      (found) => expect(found).toEqual(['root.after']),
    ],
    [
      'one subschema used by three fields: three paths',
      () => z.object({ a: shared, b: shared, c: z.array(shared) }),
      (found) => expect(found).toEqual(['a.note', 'b.note', 'c[].note']),
    ],
    [
      'a payload with no recursion: the same paths as before',
      () =>
        z.object({
          a: identifier(),
          b: z.string(),
          c: z.array(z.object({ d: z.string(), e: z.number() })),
          f: z.looseObject({}),
        }),
      (found) => expect(found).toEqual(['b', 'c[].d', 'f.*']),
    ],
  ];

  it.each(rows)('%s', (_name, build, expected) => {
    expected(eventPayloadContent(build()));
  });
});

describe('the value type of a field', () => {
  it('reports the real type of an enum or a literal, not always string', () => {
    enum Level {
      Low = 1,
      High = 2,
    }
    expect(
      eventPayloadFields(
        z.object({
          words: z.enum(['a', 'b']),
          levels: z.enum(Level),
          one: z.literal(1),
          yes: z.literal(true),
          mixed: z.literal(['a', 1]),
        }),
      ).map(({ name, type }) => [name, type]),
    ).toEqual([
      ['words', 'string'],
      ['levels', 'number'],
      ['one', 'number'],
      ['yes', 'boolean'],
      ['mixed', 'unknown'],
    ]);
  });
});

describe('eventPayloadFields', () => {
  it('lists each field in order, with its JSON type and whether it is optional', () => {
    expect(
      eventPayloadFields(
        z.object({
          greetingId: identifier(),
          status: z.enum(['sent', 'failed']),
          count: z.number(),
          urgent: z.boolean(),
          ids: z.array(identifier()),
          detail: z.object({ id: identifier() }),
          maybe: identifier().optional(),
          counted: z.number().default(0),
          either: z.union([z.number(), identifier()]),
          kind: z.literal('greeting'),
        }),
      ),
    ).toEqual([
      { name: 'greetingId', type: 'string', optional: false },
      { name: 'status', type: 'string', optional: false },
      { name: 'count', type: 'number', optional: false },
      { name: 'urgent', type: 'boolean', optional: false },
      { name: 'ids', type: 'string[]', optional: false },
      { name: 'detail', type: 'object', optional: false },
      { name: 'maybe', type: 'string', optional: true },
      { name: 'counted', type: 'number', optional: false },
      { name: 'either', type: 'unknown', optional: false },
      { name: 'kind', type: 'string', optional: false },
    ]);
  });
});

describe('isEventPayload', () => {
  it('is true for a Zod object only', () => {
    expect(isEventPayload(z.object({}))).toBe(true);
    for (const value of [z.string(), z.array(z.object({})), {}, null, undefined, 'x']) {
      expect(isEventPayload(value)).toBe(false);
    }
  });
});
