import { humanizeIdentifier } from '../../utilities/humanize-identifier.ts';

/** One field of a schema, ready to show: a formatted label, a type, and its nested fields. */
export type SchemaViewField = {
  /** The property name in the schema, or `item` for the shape of an array's entries. */
  key: string;
  /** The label shown for the field, formatted from `key`. */
  label: string;
  /** The type as one short string, for example `string`, `array of number` or `string | null`. */
  type: string;
  /** The field's `description`, when the schema gives one. */
  description?: string;
  /** True when the parent object lists the field in `required`. */
  required: boolean;
  /** Fields of a nested object, or of the objects an array holds. */
  fields: SchemaViewField[];
  /** True when nested fields were left out because they are deeper than `maxDepth`. */
  truncated: boolean;
};

type SchemaRecord = Record<string, unknown>;

/** How many levels of `array of` and alternatives a type string spells out before it ends. */
const TYPE_DEPTH_LIMIT = 4;

/** How many enum values a type string lists before it ends with an ellipsis. */
const ENUM_VALUES_SHOWN = 4;

function isRecord(value: unknown): value is SchemaRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Follows a local `$ref` (`#`, `#/$defs/name`, `#/definitions/name`) to the
 * schema it names. Returns `undefined` for a reference that does not resolve or
 * that points outside the document.
 */
function resolveReference(root: SchemaRecord, reference: string): SchemaRecord | undefined {
  if (reference === '#') return root;
  if (!reference.startsWith('#/')) return undefined;
  let current: unknown = root;
  for (const segment of reference.slice(2).split('/')) {
    const name = segment.replaceAll('~1', '/').replaceAll('~0', '~');
    if (!isRecord(current)) return undefined;
    // Walk the own entries rather than indexing: a pointer segment such as
    // `constructor` must not resolve to something every object inherits.
    const entry = Object.entries(current).find(([key]) => key === name);
    if (entry === undefined) return undefined;
    current = entry[1];
  }
  return isRecord(current) ? current : undefined;
}

/**
 * Resolves `$ref` chains and merges `allOf` members into one flat schema, so
 * the rest of the walk reads `properties` and `required` from a single place.
 * `seen` holds the references on the current path and stops a cycle.
 */
function flatten(root: SchemaRecord, schema: SchemaRecord, seen: readonly string[]): SchemaRecord {
  let result: SchemaRecord = { ...schema };
  const reference = result['$ref'];
  if (typeof reference === 'string' && !seen.includes(reference)) {
    const target = resolveReference(root, reference);
    if (target) {
      delete result['$ref'];
      result = { ...flatten(root, target, [...seen, reference]), ...result };
    }
  }
  const members = result['allOf'];
  if (Array.isArray(members)) {
    const properties: SchemaRecord = isRecord(result['properties'])
      ? { ...result['properties'] }
      : {};
    const required = stringList(result['required']);
    for (const member of members) {
      if (!isRecord(member)) continue;
      const merged = flatten(root, member, seen);
      if (isRecord(merged['properties'])) Object.assign(properties, merged['properties']);
      required.push(...stringList(merged['required']));
      for (const keyword of ['type', 'description', 'items', 'enum', 'format'] as const) {
        if (result[keyword] === undefined && merged[keyword] !== undefined) {
          result[keyword] = merged[keyword];
        }
      }
    }
    delete result['allOf'];
    if (Object.keys(properties).length > 0) result['properties'] = properties;
    if (required.length > 0) result['required'] = [...new Set(required)];
  }
  return result;
}

function literal(value: unknown): string {
  return JSON.stringify(value);
}

/** The members of a `oneOf` or `anyOf`, each flattened. */
function alternatives(root: SchemaRecord, schema: SchemaRecord, seen: readonly string[]) {
  for (const keyword of ['oneOf', 'anyOf'] as const) {
    const members = schema[keyword];
    if (Array.isArray(members)) {
      return members.filter(isRecord).map((member) => flatten(root, member, seen));
    }
  }
  return [];
}

function describeType(
  root: SchemaRecord,
  schema: SchemaRecord,
  seen: readonly string[],
  depth = 0,
): string {
  if (depth >= TYPE_DEPTH_LIMIT) return '…';
  if (Array.isArray(schema['enum'])) {
    const values = schema['enum'].map(literal);
    const shown = values.slice(0, ENUM_VALUES_SHOWN).join(' | ');
    return values.length > ENUM_VALUES_SHOWN ? `${shown} | …` : shown;
  }
  if ('const' in schema) return literal(schema['const']);

  const declared = schema['type'];
  const types = typeof declared === 'string' ? [declared] : stringList(declared);
  if (types.length > 0) {
    return types
      .map((type) => {
        if (type === 'array') {
          const items = isRecord(schema['items'])
            ? flatten(root, schema['items'], seen)
            : undefined;
          return items ? `array of ${describeType(root, items, seen, depth + 1)}` : 'array';
        }
        if (type === 'string' && typeof schema['format'] === 'string') {
          return `string (${schema['format']})`;
        }
        return type;
      })
      .join(' | ');
  }

  const members = alternatives(root, schema, seen);
  if (members.length > 0) {
    return members.map((member) => describeType(root, member, seen, depth + 1)).join(' | ');
  }
  if (isRecord(schema['properties'])) return 'object';
  if (isRecord(schema['items'])) return 'array';
  return 'any';
}

/** The object whose `properties` a field shows underneath it, if there is one. */
function nestedObject(
  root: SchemaRecord,
  schema: SchemaRecord,
  seen: readonly string[],
): SchemaRecord | undefined {
  if (isRecord(schema['properties'])) return schema;
  if (isRecord(schema['items'])) {
    const items = flatten(root, schema['items'], seen);
    if (isRecord(items['properties'])) return items;
  }
  return undefined;
}

function buildFields(
  root: SchemaRecord,
  parent: SchemaRecord,
  seen: readonly string[],
  depth: number,
  maxDepth: number,
): SchemaViewField[] {
  const properties = parent['properties'];
  if (!isRecord(properties)) return [];
  const required = new Set(stringList(parent['required']));
  const fields: SchemaViewField[] = [];
  for (const [key, definition] of Object.entries(properties)) {
    const schema = isRecord(definition) ? flatten(root, definition, seen) : {};
    const nested = nestedObject(root, schema, seen);
    const withinDepth = depth < maxDepth;
    const field: SchemaViewField = {
      key,
      label: humanizeIdentifier(key),
      type: describeType(root, schema, seen),
      required: required.has(key),
      fields: nested && withinDepth ? buildFields(root, nested, seen, depth + 1, maxDepth) : [],
      truncated: nested !== undefined && !withinDepth,
    };
    if (typeof schema['description'] === 'string' && schema['description'] !== '') {
      field.description = schema['description'];
    }
    fields.push(field);
  }
  return fields;
}

/**
 * Reads a JSON Schema into the fields a person scans: one entry per property,
 * with a formatted label, a short type, the description, whether it is
 * required, and the fields of a nested object. Local `$ref`s are followed and
 * `allOf` members are merged. A schema that is not an object with properties
 * yields one `Value` field, so the view still names the type; `true`, `{}`
 * and anything unreadable yield no fields.
 *
 * `maxDepth` bounds how many levels of nested objects are expanded.
 */
export function readSchemaFields(schema: unknown, requestedDepth = 8): SchemaViewField[] {
  if (!isRecord(schema)) return [];
  // A caller can pass anything despite the types: a non-finite depth falls back.
  const maxDepth = Number.isFinite(requestedDepth) ? requestedDepth : 8;
  const root = flatten(schema, schema, []);
  const nested = nestedObject(schema, root, []);
  if (nested) return buildFields(schema, nested, [], 0, maxDepth);
  if (Object.keys(root).length === 0) return [];
  const field: SchemaViewField = {
    key: 'value',
    label: 'Value',
    type: describeType(schema, root, []),
    required: false,
    fields: [],
    truncated: false,
  };
  if (typeof root['description'] === 'string' && root['description'] !== '') {
    field.description = root['description'];
  }
  return [field];
}
