/**
 * COR-2223 — what the payload of a plugin's declared event may hold, and the fields it lists as.
 *
 * An event reaches hooks, activity views and other plugins, so its payload carries identifiers,
 * statuses and counts, never content. One walk over the Zod schema answers both questions the host
 * asks of it, so the refusal and the catalog's field list cannot disagree:
 *
 * - {@link eventPayloadContent}: the fields that could hold content, which the host refuses.
 * - {@link eventPayloadFields}: the fields a payload lists, as `bureau.events.catalog` shows them.
 *
 * A value is accepted when every leaf it can hold is a number, a boolean, a literal, a `z.enum` (a
 * status), or a string marked `.meta({ identifier: true })`; an object, an array, a union, an
 * optional, a nullable or a default of accepted values is accepted. A free string, `z.unknown()`,
 * `z.any()`, a record, a tuple, a date, a lazy schema and an object with a catchall are refused:
 * each lets arbitrary text through. A schema that recurses through a getter is accepted when every
 * leaf passes (revisiting an object adds no leaf). The walk reads at most
 * {@link EVENT_PAYLOAD_NODE_BUDGET} schemas, getter reads included; a payload that needs more, such
 * as one that builds a new schema on every read, is refused at the path where the count ran out.
 *
 * The schema is read through `_zod.def`, as `schemaDigest` reads it, never through `instanceof`: a
 * plugin may carry its own copy of Zod.
 *
 * @module plugin-event-payload
 */

import { z } from 'zod';

import type { BureauEventField, BureauEventFieldType } from '../bureau-event-catalog';

/** The members of a Zod definition this module reads. */
interface Definition {
  readonly type: string;
  readonly innerType?: unknown;
  readonly in?: unknown;
  readonly element?: unknown;
  readonly options?: readonly unknown[];
  readonly shape?: Readonly<Record<string, unknown>>;
  readonly catchall?: unknown;
  readonly values?: readonly unknown[];
  readonly entries?: Readonly<Record<string, unknown>>;
}

function definitionOf(schema: unknown): Definition | undefined {
  if (typeof schema !== 'object' || schema === null) return undefined;
  const internals: unknown = Reflect.get(schema, '_zod');
  if (typeof internals !== 'object' || internals === null) return undefined;
  return Reflect.get(internals, 'def') as Definition | undefined;
}

/** The wrappers that hold another schema as `innerType` and add no values of their own. */
const WRAPPERS: ReadonlySet<string> = new Set([
  'optional',
  'nullable',
  'default',
  'prefault',
  'nonoptional',
  'readonly',
  'catch',
]);

/** Whether `schema` is a Zod object schema: the shape a payload must have. */
export function isEventPayload(schema: unknown): schema is z.ZodObject {
  return definitionOf(schema)?.type === 'object';
}

function isMarkedIdentifier(schema: unknown): boolean {
  return (
    typeof schema === 'object' &&
    schema !== null &&
    z.globalRegistry.get(schema as z.core.$ZodType)?.['identifier'] === true
  );
}

interface Unwrapped {
  /** The schema under every wrapper. */
  readonly base: unknown;
  /** Whether any layer, from the outermost to `base`, carries `.meta({ identifier: true })`. */
  readonly identifier: boolean;
  /** Whether a payload may leave the field out: the outermost of optional, default and nonoptional decides. */
  readonly optional: boolean;
}

/** `onLayer` runs once for each schema this reads, so the caller can count them. */
function unwrap(schema: unknown, onLayer: () => void = () => undefined): Unwrapped {
  let current = schema;
  let identifier = false;
  let optional: boolean | undefined;
  // A wrapper chain is finite; the bound stops a hand-built cycle from looping.
  for (let depth = 0; depth < 64; depth += 1) {
    onLayer();
    identifier ||= isMarkedIdentifier(current);
    const definition = definitionOf(current);
    if (definition === undefined) break;
    if (definition.type === 'optional') optional ??= true;
    else if (['default', 'prefault', 'nonoptional'].includes(definition.type)) optional ??= false;
    if (WRAPPERS.has(definition.type) && definition.innerType !== undefined) {
      current = definition.innerType;
    } else if (definition.type === 'pipe' && definition.in !== undefined) {
      current = definition.in;
    } else {
      break;
    }
  }
  return { base: current, identifier, optional: optional ?? false };
}

const NUMBER_LIKE: ReadonlySet<string> = new Set(['number', 'boolean', 'null', 'undefined']);

/**
 * The most schemas one payload's walk may read, wrappers and getter reads included. A payload that
 * is finite and shares its subschemas needs a few per field; one that builds a new schema on every
 * read (`get next() { return fresh() }`) never ends, and one that fans out through getters would
 * take longer than a plugin may stall the host, so either is refused where the count runs out.
 */
export const EVENT_PAYLOAD_NODE_BUDGET = 1000;

/** The most field paths a refusal names, so a payload with many offending fields stays readable. */
const MAXIMUM_NAMED_FIELDS = 32;

/** Thrown inside the walk when it has read its budget of schemas; carries the path it reached. */
class NodeBudgetExhausted extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`the payload has more than ${EVENT_PAYLOAD_NODE_BUDGET} schemas`);
    this.path = path;
  }
}

/** `rest` under the object key `key`: `note` under `customer` is `customer.note`, `[]` is `lines[]`. */
function underKey(key: string, rest: string): string {
  if (rest === '') return key;
  return rest.startsWith('[') ? `${key}${rest}` : `${key}.${rest}`;
}

/** `rest` under an array element: an element that is content is `[]`, and `note` in it `[].note`. */
function underElement(rest: string): string {
  if (rest === '') return '[]';
  return rest.startsWith('[') ? `[]${rest}` : `[].${rest}`;
}

function distinct(paths: readonly string[]): string[] {
  return [...new Set(paths)].slice(0, MAXIMUM_NAMED_FIELDS);
}

/**
 * The fields of `payload` that could carry content, as dotted paths (`customer.note`, `lines[]`,
 * `*` for an object that accepts any other key), in the order the payload declares them. Empty
 * when the payload holds identifiers, statuses and counts only. At most 32 are named.
 *
 * The walk counts every schema it reads, a getter's included, against {@link
 * EVENT_PAYLOAD_NODE_BUDGET}; a payload that runs it out is refused with the one path it reached.
 * Each object schema is judged once: its offending paths are computed relative to it and prefixed
 * at every place it is used, so a subschema shared by three fields names three paths without being
 * read three times. An object reached again while it is being judged is a cycle: it adds nothing at
 * that point, because its own judgement, still running, reports its content. A result memoized
 * from inside a cycle may therefore leave out a path that runs back through it; whether the
 * payload holds content is never affected, since every leaf is reported by the object that holds it.
 */
export function eventPayloadContent(payload: z.ZodObject): string[] {
  const memo = new Map<unknown, string[]>();
  const active = new Set<unknown>();
  let remaining = EVENT_PAYLOAD_NODE_BUDGET;

  /** The offending paths under `schema`, relative to it; `path` only names where the walk is. */
  const walk = (schema: unknown, path: string): string[] => {
    const { base, identifier } = unwrap(schema, () => {
      remaining -= 1;
      if (remaining < 0) throw new NodeBudgetExhausted(path);
    });
    const definition = definitionOf(base);
    if (definition === undefined) return [''];
    const { type } = definition;
    if (NUMBER_LIKE.has(type) || type === 'enum' || type === 'literal') return [];
    if (type === 'string') return identifier ? [] : [''];
    if (type === 'array') {
      return distinct(walk(definition.element, `${path}[]`).map(underElement));
    }
    if (type === 'union') {
      return distinct((definition.options ?? []).flatMap((option) => walk(option, path)));
    }
    if (type === 'object') {
      const judged = memo.get(base);
      if (judged !== undefined) return judged;
      if (active.has(base)) return [];
      active.add(base);
      try {
        const catchall = definitionOf(definition.catchall);
        const open = definition.catchall !== undefined && catchall?.type !== 'never';
        const found = distinct([
          ...Object.entries(definition.shape ?? {}).flatMap(([key, member]) =>
            walk(member, path === '' ? key : `${path}.${key}`).map((rest) => underKey(key, rest)),
          ),
          ...(open ? ['*'] : []),
        ]);
        memo.set(base, found);
        return found;
      } finally {
        active.delete(base);
      }
    }
    return [''];
  };

  try {
    return walk(payload, '');
  } catch (error) {
    if (error instanceof NodeBudgetExhausted) return [error.path === '' ? '*' : error.path];
    throw error;
  }
}

/** The JSON type every one of `values` has, or `unknown` when they differ or are not scalars. */
function valuesType(values: readonly unknown[] | undefined): BureauEventFieldType {
  const types = new Set((values ?? []).map((value) => typeof value));
  if (types.size !== 1) return 'unknown';
  const [only] = types;
  return only === 'string' || only === 'number' || only === 'boolean' ? only : 'unknown';
}

/** The values of an enum's entries, without the reverse mapping a numeric TypeScript enum adds. */
function enumValues(entries: Readonly<Record<string, unknown>>): unknown[] {
  const numeric = Object.values(entries).filter((value) => typeof value === 'number');
  return Object.entries(entries)
    .filter(([key]) => !numeric.includes(Number(key)))
    .map(([, value]) => value);
}

/** How many arrays and unions deep a field's type is read; an object is `object` and stops there. */
const MAXIMUM_FIELD_TYPE_DEPTH = 32;

function fieldTypeOf(schema: unknown, depth = 0): BureauEventFieldType {
  if (depth > MAXIMUM_FIELD_TYPE_DEPTH) return 'unknown';
  const { base } = unwrap(schema);
  const definition = definitionOf(base);
  switch (definition?.type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
      return 'string';
    case 'enum':
      return valuesType(enumValues(definition.entries ?? {}));
    case 'literal':
      return valuesType(definition.values);
    case 'object':
      return 'object';
    case 'array':
      return fieldTypeOf(definition.element, depth + 1) === 'string' ? 'string[]' : 'unknown';
    case 'union': {
      const types = new Set(
        (definition.options ?? []).map((option) => fieldTypeOf(option, depth + 1)),
      );
      const [only] = types;
      return types.size === 1 && only !== undefined ? only : 'unknown';
    }
    default:
      return 'unknown';
  }
}

/** The fields `payload` lists, in declaration order, as `bureau.events.catalog` shows them. */
export function eventPayloadFields(payload: z.ZodObject): BureauEventField[] {
  return Object.entries(definitionOf(payload)?.shape ?? {}).map(([name, member]) => ({
    name,
    type: fieldTypeOf(member),
    optional: unwrap(member).optional,
  }));
}
