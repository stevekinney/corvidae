/**
 * COR-2177 — secret references in a plugin reaction's configuration.
 *
 * A reaction's configuration can hold a secret without storing it. The plugin marks the field with
 * Zod's `.meta({ secret: true })`, and a hook that sets the field stores `{ "$secret": "<key>" }`,
 * where the key names a secret the workspace has published. Each delivery resolves the key to the
 * value published then, puts the value where the reference was, and only then parses the
 * configuration with the kind's schema. The stored hook and the stored delivery keep the reference.
 *
 * A secret field is found in the JSON Schema Zod writes for the kind's configuration
 * (`z.toJSONSchema`, the same one the plugin kinds listing serves), by following `properties` from
 * the root: a field reached through an object's properties is a secret field wherever it nests. A
 * marker anywhere else (an array's `items`, a union's `anyOf`, a record's `additionalProperties`)
 * has no single place to write a reference, so the kind's configuration is refused.
 *
 * @module secret-references
 */

import { z } from 'zod';

/** The one property of a stored reference. */
export const SECRET_REFERENCE_PROPERTY = '$secret';

/**
 * The keys a secret can have: Bungalow's `KEY_PATTERN` (`bungalow/src/secret-provider.ts`), which
 * is not exported and which Bureau does not depend on, so it is written again here.
 */
const SECRET_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** What a secret field holds in a stored hook: the key of the secret, never its value. */
export interface SecretReference {
  readonly $secret: string;
}

/** The secret fields of one kind's configuration, or why it has no place to keep a reference. */
export type SecretFields =
  { readonly paths: readonly (readonly string[])[] } | { readonly refusal: string };

/** What a hook that holds something other than a reference in a secret field is refused with. */
export const SECRET_REFERENCE_DEFECT =
  'This field is a secret: it holds { "$secret": "<key>" }, with the key of a published secret (lowercase letters, digits and hyphens), and never the value';

const secretFieldsByKind = new WeakMap<object, SecretFields>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The keywords whose value is data the schema describes (a default, an example, the one value or
 * the values a field may take), never a schema: a `{ secret: true }` in one is a value, not a marker.
 */
const VALUE_KEYWORDS: ReadonlySet<string> = new Set(['default', 'examples', 'const', 'enum']);

/** The keywords whose value maps a name to a schema, so a name there is not a keyword. */
const SCHEMA_MAPS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/** Whether a marker sits anywhere inside the schema `node`, however deep. */
function containsMarker(node: unknown): boolean {
  if (Array.isArray(node)) return node.some(containsMarker);
  if (!isRecord(node)) return false;
  if (node['secret'] === true) return true;
  return Object.entries(node).some(([keyword, child]) => {
    if (VALUE_KEYWORDS.has(keyword)) return false;
    if (SCHEMA_MAPS.has(keyword))
      return isRecord(child) && Object.values(child).some(containsMarker);
    return containsMarker(child);
  });
}

/**
 * The marked fields reached from `node` through `properties`, or the first marker that is not
 * reached that way.
 */
function walk(
  node: unknown,
  path: readonly string[],
  paths: (readonly string[])[],
): string | undefined {
  if (!isRecord(node)) return undefined;
  if (node['secret'] === true) {
    if (path.length === 0) {
      return 'the configuration itself is marked secret, and a reference needs a field to be kept in';
    }
    // A union has no one place to keep a reference, whichever side of it the marker was written on:
    // Zod writes `.meta(...).nullable()` as `anyOf` and `.nullable().meta(...)` as a `type` list.
    if (
      Array.isArray(node['anyOf']) ||
      Array.isArray(node['oneOf']) ||
      Array.isArray(node['type'])
    ) {
      return 'a field written as a union (a nullable one too) is marked secret, and a reference can be kept only in a field with one shape';
    }
    paths.push(path);
  }
  const { properties } = node;
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      const refusal = walk(child, [...path, name], paths);
      if (refusal !== undefined) return refusal;
    }
  }
  for (const [member, child] of Object.entries(node)) {
    if (member === 'properties' || member === 'secret' || VALUE_KEYWORDS.has(member)) continue;
    if (containsMarker(child)) {
      return `a field under "${member}" is marked secret, and a reference can be kept only in a field of an object`;
    }
  }
  return undefined;
}

/**
 * The secret fields of `schema`, as paths from the configuration's root, or `refusal` when a marker
 * sits where a reference cannot be kept. A schema Zod cannot write as JSON Schema (one built by
 * another major version of Zod, say) has no marker to find, as the plugin kinds listing has no
 * JSON Schema to show for it: it has no secret fields. Cached per schema.
 */
export function secretFieldsOf(schema: z.ZodType): SecretFields {
  const known = secretFieldsByKind.get(schema);
  if (known !== undefined) return known;
  let found: SecretFields;
  try {
    const written: unknown = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' });
    const paths: (readonly string[])[] = [];
    const refusal = walk(written, [], paths);
    found = refusal === undefined ? { paths } : { refusal };
  } catch {
    found = { paths: [] };
  }
  secretFieldsByKind.set(schema, found);
  return found;
}

/** Whether `value` is exactly `{ "$secret": key }` with a key a secret can have. */
export function isSecretReference(value: unknown): value is SecretReference {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const names = Object.keys(value);
  const key = Object.hasOwn(value, SECRET_REFERENCE_PROPERTY)
    ? value[SECRET_REFERENCE_PROPERTY]
    : undefined;
  return names.length === 1 && typeof key === 'string' && SECRET_KEY_PATTERN.test(key);
}

/** The value `root` holds at `path`, or `undefined` when no object along the path holds the field. */
export function secretFieldAt(
  root: unknown,
  path: readonly string[],
): { readonly value: unknown } | undefined {
  let current = root;
  for (const name of path) {
    if (!isRecord(current)) return undefined;
    const record: Record<string, unknown> = current;
    if (!Object.hasOwn(record, name)) return undefined;
    current = record[name];
  }
  return { value: current };
}

/** `root` with `value` put at `path`; the parts it changes are copied, and `root` is left as it was. */
export function withValueAt(root: unknown, path: readonly string[], value: unknown): unknown {
  const [name, ...rest] = path;
  if (name === undefined) return value;
  if (!isRecord(root)) return root;
  const child = Object.hasOwn(root, name) ? root[name] : undefined;
  return { ...root, [name]: withValueAt(child, rest, value) };
}

/** Whether the Zod issue at `issuePath` is at or beneath one of the secret fields `paths`. */
export function issueIsAtSecret(
  issuePath: readonly PropertyKey[],
  paths: readonly (readonly string[])[],
): boolean {
  return paths.some(
    (path) =>
      path.length <= issuePath.length && path.every((name, index) => issuePath[index] === name),
  );
}

/** `values` removed from `text`, longest first so a value that contains another goes whole. */
export function withoutValues(text: string, values: ReadonlySet<string>): string {
  let cleaned = text;
  for (const value of [...values].toSorted((a, b) => b.length - a.length)) {
    if (value !== '') cleaned = cleaned.replaceAll(value, '[redacted]');
  }
  return cleaned;
}
