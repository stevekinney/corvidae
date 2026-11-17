/** What a secret value reads as in the JSON view and in a copy: bullets, never a length hint. */
export const SECRET_MASK = '••••••••••••';

/**
 * Stands in for a value that must never be shown. The Fields view recognizes it and writes the
 * word "Hidden"; serialized, it is the {@link SECRET_MASK} text, so the JSON view and Copy never
 * hold the stored value.
 */
export class SecretValue {
  /** The bullets a serializer writes in place of the stored value. */
  toJSON(): string {
    return SECRET_MASK;
  }

  /** The bullets, so text built from the value never reads the stored one. */
  toString(): string {
    return SECRET_MASK;
  }
}

/** True for the stand-in {@link maskSecrets} leaves where a secret was. */
export function isSecretValue(value: unknown): value is SecretValue {
  return value instanceof SecretValue;
}

// Words that name a secret when a property has no schema to say so. Whole words only, so
// `apiKey`, `access_token` and `Authorization` match and `monkey` or `keywords` do not.
const SECRET_WORDS = new Set([
  'token',
  'key',
  'password',
  'passwd',
  'authorization',
  'secret',
  'credential',
  'credentials',
]);

/** True when a property name reads as a secret: any word of it is token, key, password, authorization and the like. */
export function looksSecret(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  return words.some((word) => SECRET_WORDS.has(word));
}

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return (
    typeof value === 'object' &&
    value !== null &&
    !(value instanceof Date) &&
    !(value instanceof SecretValue)
  );
}

function matches(patterns: readonly (readonly string[])[], path: readonly string[]): boolean {
  return patterns.some(
    (pattern) =>
      pattern.length === path.length &&
      pattern.every((segment, index) => segment === '*' || segment === path[index]),
  );
}

// A payload is data from outside, so a hostile one can nest far deeper than any real one. Past this
// depth the value is hidden whole rather than walked, which can only hide more, never less.
const MASK_DEPTH_LIMIT = 200;

function mask(
  value: unknown,
  path: string[],
  patterns: readonly (readonly string[])[] | undefined,
): unknown {
  if (path.length > 0 && patterns !== undefined && matches(patterns, path)) {
    return new SecretValue();
  }
  if (!isContainer(value)) return value;
  if (path.length >= MASK_DEPTH_LIMIT) return new SecretValue();
  if (Array.isArray(value)) {
    return value.map((item, index) => mask(item, [...path, String(index + 1)], patterns));
  }
  // `fromEntries` defines each property, so a stored `__proto__` key stays a property of the copy
  // instead of changing the copy's prototype.
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => {
      const secret = patterns === undefined && looksSecret(key);
      return [key, secret ? new SecretValue() : mask(entry, [...path, key], patterns)];
    }),
  );
}

/**
 * Returns a copy of a payload with every secret replaced by a {@link SecretValue}, before any
 * layout, size or copy text is worked out from it.
 *
 * With `secretPaths`, exactly those values are hidden: each path is dot-separated property names
 * from the root, array positions count from 1 as they do in `linkFor` and `formatValue`, and `*`
 * stands for any one name or position (`headers.authorization`, `attachments.*.token`). Without them, a property is hidden when a word of its name reads as a
 * secret (token, key, password, authorization), because nothing else says which values are.
 * A hidden object or array is hidden whole.
 */
export function maskSecrets(value: unknown, secretPaths?: readonly string[]): unknown {
  const patterns = secretPaths?.map((path) => path.split('.'));
  return mask(value, [], patterns);
}

/**
 * A copy of a payload with each {@link SecretValue} written as its bullets, ready for the JSON
 * view. Anything else is left as it is.
 */
export function writeSecretsAsText(value: unknown, depth = 0): unknown {
  if (value instanceof SecretValue) return SECRET_MASK;
  if (!isContainer(value) || depth >= MASK_DEPTH_LIMIT) return value;
  if (Array.isArray(value)) return value.map((item) => writeSecretsAsText(item, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, writeSecretsAsText(entry, depth + 1)]),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isSecretSchema(schema: Record<string, unknown>): boolean {
  return (
    schema['writeOnly'] === true || schema['format'] === 'password' || schema['x-secret'] === true
  );
}

function collectSecretPaths(schema: unknown, path: string[], found: Set<string>, depth: number) {
  if (!isRecord(schema) || depth > 32) return;
  if (path.length > 0 && isSecretSchema(schema)) {
    found.add(path.join('.'));
    return;
  }
  const properties = schema['properties'];
  if (isRecord(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      collectSecretPaths(child, [...path, name], found, depth + 1);
    }
  }
  collectSecretPaths(schema['items'], [...path, '*'], found, depth + 1);
  for (const branches of [schema['allOf'], schema['anyOf'], schema['oneOf']]) {
    if (Array.isArray(branches)) {
      for (const branch of branches) collectSecretPaths(branch, path, found, depth + 1);
    }
  }
}

/**
 * Reads the secret paths a JSON Schema declares, in the form `redact` takes: every property
 * marked `writeOnly`, `format: "password"` or `x-secret`, found under `properties`, `items`
 * (written `*`) and the `allOf`, `anyOf` and `oneOf` branches. A property name that contains a
 * dot cannot be written as a path, and a `$ref` is not followed.
 */
export function readSecretPaths(schema: unknown): string[] {
  const found = new Set<string>();
  collectSecretPaths(schema, [], found, 0);
  return [...found];
}

/** True when a payload, already masked, holds a {@link SecretValue} anywhere. */
export function containsSecret(value: unknown, depth = 0): boolean {
  if (value instanceof SecretValue) return true;
  if (!isContainer(value) || depth >= MASK_DEPTH_LIMIT) return false;
  const children = Array.isArray(value) ? value : Object.values(value);
  return children.some((child) => containsSecret(child, depth + 1));
}
