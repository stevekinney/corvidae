import { ownEntry } from '../../_internal/own-entry.ts';
import { humanizeIdentifier } from '../../utilities/humanize-identifier.ts';
export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchemaObject = Record<string, unknown>;

/**
 * How a schema property is rendered. `enumArray`, `tags`, `record` and `choice` are the shapes that
 * used to fall back to a raw JSON textarea (or a generic array/object editor); the narrow schema
 * rule that selects each one is documented in the README.
 */
export type SchemaFormFieldKind =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'enum'
  | 'enumArray'
  | 'tags'
  | 'record'
  | 'choice'
  | 'array'
  | 'object'
  | 'json';

export type SchemaFormOption = {
  label: string;
  value: JsonPrimitive;
  encodedValue: string;
};

export type SchemaFormField = {
  kind: SchemaFormFieldKind;
  key: string;
  path: string[];
  label: string;
  required: boolean;
  description?: string;
  schema: JsonSchemaObject;
  /**
   * Child fields of an `object`. For a `choice` they are its two branches: the literal branch
   * first, then the object branch. Every branch shares the choice's own `path`.
   */
  fields: SchemaFormField[];
  /** Selectable values of an `enum`, or of the items of an `enumArray`. */
  options: SchemaFormOption[];
  item?: SchemaFormField;
  /** Set on a `number` or `integer` field that holds a duration, stored in milliseconds. */
  unit?: 'milliseconds';
};

/**
 * The property-name suffixes that mark a numeric field as a duration in milliseconds, in addition
 * to `format: "duration-ms"`: `timeoutMs`, `retry_ms` and `elapsedMilliseconds`.
 */
export const MILLISECONDS_NAME_PATTERN = /(?:[a-z0-9]Ms|_ms|[a-z0-9]Milliseconds|_milliseconds)$/;

export type SchemaFormModel = {
  field: SchemaFormField;
  sourceSchema: JsonSchemaObject;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isJsonSchemaObject(value: unknown): value is JsonSchemaObject {
  return isRecord(value);
}

export function createSchemaFormModel(schema: JsonSchemaObject): SchemaFormModel {
  return {
    field: fieldFromJsonSchema(schema, [], 'value', true),
    sourceSchema: schema,
  };
}

function fieldFromJsonSchema(
  schema: unknown,
  path: string[],
  key: string,
  required: boolean,
): SchemaFormField {
  if (!isRecord(schema)) {
    return baseField('json', {}, path, key, required);
  }

  const normalizedSchema = schema;
  const options = enumOptions(normalizedSchema);
  if (options.length > 0) {
    return { ...baseField('enum', normalizedSchema, path, key, required), options };
  }

  const choiceBranches = choiceBranchSchemas(normalizedSchema);
  if (choiceBranches) {
    const branchField = (branch: JsonSchemaObject) =>
      fieldFromJsonSchema(
        {
          ...branch,
          title: branchTitle(branch),
          // A `const` branch is a one-option enum.
          ...('const' in branch ? { enum: [branch['const']] } : {}),
        },
        path,
        key,
        required,
      );
    return {
      ...baseField('choice', normalizedSchema, path, key, required),
      fields: [branchField(choiceBranches.literal), branchField(choiceBranches.object)],
    };
  }

  const schemaType = schemaTypeOf(normalizedSchema);
  const schemaProperties = normalizedSchema['properties'];
  if (isStringRecordSchema(normalizedSchema)) {
    return baseField('record', normalizedSchema, path, key, required);
  }
  if (schemaType === 'object' || isRecord(schemaProperties)) {
    const requiredProperties = requiredPropertyNames(normalizedSchema);
    const properties = isRecord(schemaProperties) ? schemaProperties : {};
    const fields = Object.entries(properties).map(([propertyKey, propertySchema]) =>
      fieldFromJsonSchema(
        propertySchema,
        [...path, propertyKey],
        propertyKey,
        requiredProperties.has(propertyKey),
      ),
    );
    return { ...baseField('object', normalizedSchema, path, key, required), fields };
  }

  if (schemaType === 'array') {
    const schemaItems = normalizedSchema['items'];
    const itemSchema = isRecord(schemaItems) ? schemaItems : {};
    const itemOptions = enumOptions(itemSchema);
    if (itemOptions.length > 0) {
      return {
        ...baseField('enumArray', normalizedSchema, path, key, required),
        options: itemOptions,
      };
    }
    if (schemaTypeOf(itemSchema) === 'string') {
      const stringItem = fieldFromJsonSchema(itemSchema, [...path, '0'], 'item', true);
      return { ...baseField('tags', normalizedSchema, path, key, required), item: stringItem };
    }
    const item = fieldFromJsonSchema(itemSchema, [...path, '0'], 'item', true);
    return { ...baseField('array', normalizedSchema, path, key, required), item };
  }

  const fieldKind = fieldKindForSchemaType(schemaType);
  if (fieldKind) {
    const field = baseField(fieldKind, normalizedSchema, path, key, required);
    if (
      (fieldKind === 'number' || fieldKind === 'integer') &&
      isMillisecondsField(normalizedSchema, key)
    ) {
      field.unit = 'milliseconds';
    }
    return field;
  }

  return baseField('json', normalizedSchema, path, key, required);
}

/** True when a numeric property is a duration in milliseconds, by `format` or by name suffix. */
function isMillisecondsField(schema: JsonSchemaObject, key: string): boolean {
  return schema['format'] === 'duration-ms' || MILLISECONDS_NAME_PATTERN.test(key);
}

/**
 * A record is a property-less object whose `additionalProperties` is exactly `{ type: "string" }`
 * (headers, environment variables, labels). Anything wider keeps its existing rendering.
 */
function isStringRecordSchema(schema: JsonSchemaObject): boolean {
  if (schemaTypeOf(schema) !== 'object') return false;
  const properties = schema['properties'];
  if (isRecord(properties) && Object.keys(properties).length > 0) return false;
  const additional = schema['additionalProperties'];
  return isRecord(additional) && additional['type'] === 'string' && !('enum' in additional);
}

/** A choice is a `oneOf` of exactly one primitive branch and one object branch with `properties`. */
function choiceBranchSchemas(
  schema: JsonSchemaObject,
): { literal: JsonSchemaObject; object: JsonSchemaObject } | undefined {
  if (isRecord(schema['properties'])) return undefined;
  const branches = schema['oneOf'];
  if (!Array.isArray(branches) || branches.length !== 2) return undefined;
  const [first, second] = branches as unknown[];
  if (!isRecord(first) || !isRecord(second)) return undefined;
  const literal = [first, second].find(isLiteralBranch);
  const object = [first, second].find(isObjectBranch);
  if (!literal || !object) return undefined;
  return { literal, object };
}

function isObjectBranch(branch: JsonSchemaObject): boolean {
  const properties = branch['properties'];
  return (
    schemaTypeOf(branch) === 'object' && isRecord(properties) && Object.keys(properties).length > 0
  );
}

function isLiteralBranch(branch: JsonSchemaObject): boolean {
  if ('const' in branch) return isJsonPrimitive(branch['const']);
  if (enumOptions(branch).length > 0) return true;
  const type = schemaTypeOf(branch);
  return type === 'string' || type === 'number' || type === 'integer' || type === 'boolean';
}

/** The segment label of a choice branch: its title, else its literal value, else a type name. */
function branchTitle(branch: JsonSchemaObject): string {
  const title = branch['title'];
  if (typeof title === 'string' && title.trim().length > 0) return title;
  if ('const' in branch) return String(branch['const']);
  const options = enumOptions(branch);
  if (options.length === 1 && options[0]) return options[0].label;
  const type = schemaTypeOf(branch);
  return type === undefined ? 'Value' : humanizeIdentifier(type);
}

function fieldKindForSchemaType(type: string | undefined): SchemaFormFieldKind | undefined {
  switch (type) {
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'array':
    case 'object':
      return type;
    default:
      return undefined;
  }
}

function baseField(
  kind: SchemaFormFieldKind,
  schema: JsonSchemaObject,
  path: string[],
  key: string,
  required: boolean,
): SchemaFormField {
  const description = schema['description'];
  return {
    kind,
    key,
    path,
    label: fieldLabel(schema, key),
    required,
    ...(typeof description === 'string' && description.length > 0 ? { description } : {}),
    schema,
    fields: [],
    options: [],
  };
}

function schemaTypeOf(schema: JsonSchemaObject): string | undefined {
  const { type } = schema;
  if (typeof type === 'string') return type;
  if (Array.isArray(type)) {
    const supported = type.find(
      (candidate) => typeof candidate === 'string' && candidate !== 'null',
    );
    return typeof supported === 'string' ? supported : undefined;
  }
  return undefined;
}

function requiredPropertyNames(schema: JsonSchemaObject): Set<string> {
  const required = schema['required'];
  if (!Array.isArray(required)) return new Set();
  return new Set(required.filter((property): property is string => typeof property === 'string'));
}

function enumOptions(schema: JsonSchemaObject): SchemaFormOption[] {
  const values = schema['enum'];
  if (!Array.isArray(values) || values.length === 0) return [];
  if (!values.every((value): value is JsonPrimitive => isJsonPrimitive(value))) return [];
  return values.map((value) => ({
    label: String(value),
    value,
    encodedValue: encodeEnumValue(value),
  }));
}

function isJsonPrimitive(value: unknown): value is JsonPrimitive {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

export function encodeEnumValue(value: JsonPrimitive): string {
  return JSON.stringify(value);
}

export function decodeEnumValue(value: string): JsonPrimitive {
  const parsed: unknown = JSON.parse(value);
  if (!isJsonPrimitive(parsed)) {
    throw new Error('SchemaForm enum values must be JSON primitives.');
  }
  return parsed;
}

function fieldLabel(schema: JsonSchemaObject, key: string): string {
  const title = schema['title'];
  if (typeof title === 'string' && title.trim().length > 0) {
    return title;
  }
  return humanizeIdentifier(key);
}

export function defaultValueForField(field: SchemaFormField): unknown {
  if ('default' in field.schema) return cloneJsonCompatible(field.schema['default']);

  if (field.kind === 'object') {
    const value: Record<string, unknown> = {};
    for (const child of field.fields) {
      value[child.key] = defaultValueForField(child);
    }
    return value;
  }

  if (field.kind === 'array' || field.kind === 'enumArray' || field.kind === 'tags') return [];
  if (field.kind === 'record') return {};
  if (field.kind === 'choice') {
    const [literalBranch] = field.fields;
    return literalBranch ? defaultValueForField(literalBranch) : null;
  }
  if (field.kind === 'boolean') return false;
  if (field.kind === 'enum') return field.options.length > 0 ? field.options[0]!.value : '';
  if (field.kind === 'string') return '';
  if (field.kind === 'json') return null;
  return undefined;
}

export function initialValueForField(field: SchemaFormField, value: unknown): unknown {
  if (value === undefined) return defaultValueForField(field);
  const clonedValue = cloneJsonCompatible(value);
  if (clonedValue === undefined) return defaultValueForField(field);
  return mergeInitialValueWithFieldDefaults(field, clonedValue);
}

function mergeInitialValueWithFieldDefaults(field: SchemaFormField, value: unknown): unknown {
  if (field.kind === 'object' && isRecord(value)) {
    const defaultValue = defaultValueForField(field);
    const defaultRecord = isRecord(defaultValue) ? defaultValue : {};
    const result: Record<string, unknown> = { ...defaultRecord };
    const fieldKeys = new Set(field.fields.map((child) => child.key));

    for (const child of field.fields) {
      const seededValue = Object.hasOwn(value, child.key)
        ? value[child.key]
        : ownEntry(defaultRecord, child.key);
      result[child.key] =
        seededValue === undefined
          ? defaultValueForField(child)
          : mergeInitialValueWithFieldDefaults(child, seededValue);
    }

    for (const [key, extraValue] of Object.entries(value)) {
      if (!fieldKeys.has(key)) result[key] = extraValue;
    }

    return result;
  }

  if (field.kind === 'array' && Array.isArray(value) && field.item) {
    return value.map((item) => mergeInitialValueWithFieldDefaults(field.item!, item));
  }

  if (field.kind === 'choice') {
    return mergeInitialValueWithFieldDefaults(choiceBranchForValue(field, value), value);
  }

  return value;
}

/**
 * The branch of a `choice` that a value belongs to: the object branch for an object, the literal
 * branch for anything else. The branches are told apart by shape alone, so the active branch is
 * always derived from the value and never stored.
 */
export function choiceBranchForValue(field: SchemaFormField, value: unknown): SchemaFormField {
  const [literalBranch, objectBranch] = field.fields;
  if (!literalBranch || !objectBranch) {
    throw new Error('SchemaForm choice fields hold a literal branch and an object branch.');
  }
  return isRecord(value) ? objectBranch : literalBranch;
}

/** Counts the fields a person fills in: everything except the object groups that only hold them. */
export function countLeafFields(field: SchemaFormField): number {
  if (field.kind !== 'object') return 1;
  return field.fields.reduce((total, child) => total + countLeafFields(child), 0);
}

export function cloneJsonCompatible(value: unknown): unknown {
  if (value === undefined) return undefined;
  try {
    const serializedValue = JSON.stringify(value, cloneJsonCompatibleReplacer);
    if (serializedValue === undefined) return undefined;
    const clonedValue: unknown = JSON.parse(serializedValue);
    return clonedValue;
  } catch {
    return undefined;
  }
}

function cloneJsonCompatibleReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new TypeError('SchemaForm values must contain finite numbers.');
  }
  if (typeof value === 'bigint') {
    throw new TypeError('SchemaForm values must not contain bigint values.');
  }
  return value;
}

export function pathKey(path: readonly string[]): string {
  return path.map((segment) => segment.replaceAll('~', '~0').replaceAll('/', '~1')).join('/');
}

export function pathId(path: readonly string[]): string {
  return path.length === 0 ? 'value' : path.map(domIdSegment).join('__');
}

function domIdSegment(segment: string): string {
  let encoded = '';
  for (const character of segment) {
    if (/^[a-zA-Z0-9]$/.test(character)) {
      encoded += character;
    } else {
      encoded += `_${character.codePointAt(0)?.toString(16) ?? '0'}_`;
    }
  }
  return `${segment.length}_${encoded}`;
}

export function getValueAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const segment of path) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (isRecord(current)) {
      current = ownEntry(current, segment);
    } else {
      return undefined;
    }
  }
  return current;
}

export function setValueAtPath(value: unknown, path: readonly string[], next: unknown): unknown {
  if (path.length === 0) return next;

  const [head, ...tail] = path;
  if (head === undefined) return next;

  if (Array.isArray(value)) {
    const copy = [...value];
    const index = Number(head);
    if (!Number.isInteger(index) || index < 0) return copy;
    copy[index] = setValueAtPath(copy[index], tail, next);
    return copy;
  }

  const copy: Record<string, unknown> = isRecord(value) ? { ...value } : {};
  // Assignment would turn the property name `__proto__` into "set the prototype" and drop the value.
  Object.defineProperty(copy, head, {
    value: setValueAtPath(ownEntry(copy, head), tail, next),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return copy;
}

export function pruneUndefined(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => pruneUndefined(item));
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) output[key] = pruneUndefined(child);
  }
  return output;
}

export function arrayValueAtPath(value: unknown, path: readonly string[]): unknown[] {
  const array = getValueAtPath(value, path);
  return Array.isArray(array) ? array : [];
}

export function rebaseFieldPath(field: SchemaFormField, path: string[]): SchemaFormField {
  const originalPath = field.path;

  function rebase(candidate: SchemaFormField): SchemaFormField {
    const suffix = candidate.path.slice(originalPath.length);
    return {
      ...candidate,
      path: [...path, ...suffix],
      fields: candidate.fields.map(rebase),
      ...(candidate.item ? { item: rebase(candidate.item) } : {}),
    };
  }

  return rebase(field);
}

export function collectJsonFields(field: SchemaFormField): SchemaFormField[] {
  const fields: SchemaFormField[] = [];

  function visit(candidate: SchemaFormField) {
    if (candidate.kind === 'json') fields.push(candidate);
    for (const child of candidate.fields) visit(child);
    if (candidate.item) visit(candidate.item);
  }

  visit(field);
  return fields;
}

/**
 * Projects the rows of a record field into the object they stand for. A row without a key is
 * still being typed and is left out; when two rows share a key the first one wins, and
 * {@link recordEntryIssue} tells the person before they can submit.
 */
export function recordFromEntries(
  entries: readonly { key: string; value: string }[],
): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.key.trim() === '' || Object.hasOwn(record, entry.key)) continue;
    // Assignment would turn the property name `__proto__` into "set the prototype" and drop it.
    Object.defineProperty(record, entry.key, {
      value: entry.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return record;
}

/** The reason a record's rows cannot become an object, or `undefined` when they can. */
export function recordEntryIssue(
  entries: readonly { key: string; value: string }[],
): string | undefined {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.key.trim() === '') {
      if (entry.value !== '') return 'Every entry needs a key.';
      continue;
    }
    if (seen.has(entry.key)) return `Duplicate key "${entry.key}".`;
    seen.add(entry.key);
  }
  return undefined;
}
