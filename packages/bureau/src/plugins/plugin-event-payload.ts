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
 * each lets arbitrary text through.
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

function unwrap(schema: unknown): Unwrapped {
  let current = schema;
  let identifier = false;
  let optional: boolean | undefined;
  // A wrapper chain is finite; the bound stops a hand-built cycle from looping.
  for (let depth = 0; depth < 64; depth += 1) {
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

/** The paths under `schema` that could hold content, each starting from `path`. */
function contentPaths(schema: unknown, path: string): string[] {
  const { base, identifier } = unwrap(schema);
  const definition = definitionOf(base);
  if (definition === undefined) return [path];
  const { type } = definition;
  if (NUMBER_LIKE.has(type) || type === 'enum' || type === 'literal') return [];
  if (type === 'string') return identifier ? [] : [path];
  if (type === 'array') return contentPaths(definition.element, `${path}[]`);
  if (type === 'union') {
    return (definition.options ?? []).flatMap((option) => contentPaths(option, path));
  }
  if (type === 'object') {
    const catchall = definitionOf(definition.catchall);
    const open = definition.catchall !== undefined && catchall?.type !== 'never';
    return [
      ...Object.entries(definition.shape ?? {}).flatMap(([key, member]) =>
        contentPaths(member, path === '' ? key : `${path}.${key}`),
      ),
      ...(open ? [path === '' ? '*' : `${path}.*`] : []),
    ];
  }
  return [path];
}

/**
 * The fields of `payload` that could carry content, as dotted paths (`customer.note`, `lines[]`,
 * `*` for an object that accepts any other key), in the order the payload declares them. Empty
 * when the payload holds identifiers, statuses and counts only.
 */
export function eventPayloadContent(payload: z.ZodObject): string[] {
  return contentPaths(payload, '');
}

function literalType(values: readonly unknown[] | undefined): BureauEventFieldType {
  const types = new Set((values ?? []).map((value) => typeof value));
  if (types.size !== 1) return 'unknown';
  const [only] = types;
  return only === 'string' || only === 'number' || only === 'boolean' ? only : 'unknown';
}

function fieldTypeOf(schema: unknown): BureauEventFieldType {
  const { base } = unwrap(schema);
  const definition = definitionOf(base);
  switch (definition?.type) {
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'string':
    case 'enum':
      return 'string';
    case 'literal':
      return literalType(definition.values);
    case 'object':
      return 'object';
    case 'array':
      return fieldTypeOf(definition.element) === 'string' ? 'string[]' : 'unknown';
    case 'union': {
      const types = new Set((definition.options ?? []).map(fieldTypeOf));
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
