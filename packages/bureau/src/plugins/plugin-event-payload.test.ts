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
