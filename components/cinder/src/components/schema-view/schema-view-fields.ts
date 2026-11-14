import { humanizeIdentifier } from '../../utilities/humanize-identifier.ts';

/** One field of a schema, ready to show: a formatted label, a type, and its nested fields. */
export type SchemaViewField = {
  /** The property name in the schema. */
  key: string;
  /**
   * Where the field sits: the keys of its ancestors and its own key, joined with `/`. A field that
   * belongs to one branch of a choice carries `<choice>:` before its key. Unique within a schema,
   * so a view can remember which field it expanded.
   */
  path: string;
  /**
   * The label shown for the field, formatted from `key` in sentence case. A field that belongs to
   * one branch of a choice reads `If <choice>: <field>`.
   */
  label: string;
  /**
   * The type in plain words, for example `text`, `yes or no`, `list of steps`, `one of: email,
   * slack` or `JSON schema`.
   */
  type: string;
  /** The field's `description`, when the schema gives one, whole. */
  description?: string;
  /** The first paragraph of `description`: the line a person reads. */
  summary?: string;
  /** The rest of `description`, after its first paragraph: the text written for a model. */
  detail?: string;
  /** True when the parent object lists the field in `required`. */
  required: boolean;
  /**
   * Fields of a nested object, or of the objects an array holds, then the fields of each branch of
   * a choice (a `oneOf` of objects).
   */
  fields: SchemaViewField[];
  /** True when nested fields were left out because they are deeper than `maxDepth`. */
  truncated: boolean;
  /** What kind of value the field takes, for its type mark. */
  kind: SchemaViewKind;
  /** The quiet facts about the value: allowed values, the default, the format, its limits. */
  facts: SchemaViewFact[];
};

/** The kinds of value a type mark names, each with its own word and hue. */
export type SchemaViewKind = 'text' | 'number' | 'boolean' | 'object' | 'list' | 'choice' | 'any';

/** The word a type mark shows for each kind. */
export const SCHEMA_VIEW_KIND_WORDS: Readonly<Record<SchemaViewKind, string>> = {
  text: 'text',
  number: 'number',
  boolean: 'yes or no',
  object: 'object',
  list: 'list',
  choice: 'choice',
  any: 'any',
};

/**
 * One fact about a field's value, read as `label`, then `detail` in words, then `values` in the
 * code face: "Default `thorough`", "One of `quick`, `thorough`", "Format date and time".
 */
export type SchemaViewFact = { label: string; detail?: string; values?: string[] };

/**
 * Splits a description into the line a person reads and the text written for a model. The first
 * paragraph is the summary; whatever follows the first blank line is the detail. A description of
 * one paragraph has no detail. Line breaks inside a paragraph read as spaces.
 */
export function splitDescription(description: string): { summary: string; detail?: string } {
  const [first = '', ...rest] = description.trim().split(/\n[ \t]*\n+/);
  const joinLines = (paragraph: string) => paragraph.replaceAll(/\s*\n\s*/g, ' ').trim();
  const detail = rest
    .map((paragraph) => joinLines(paragraph))
    .filter((paragraph) => paragraph !== '')
    .join(' ');
  return detail === '' ? { summary: joinLines(first) } : { summary: joinLines(first), detail };
}

/**
 * Orders the top-level fields of a schema for reading: the required ones first, then the rest,
 * each group in the order the schema declares. Nested fields keep the schema's order, so only the
 * top level is reordered.
 */
export function partitionRequiredFields(fields: readonly SchemaViewField[]): {
  required: SchemaViewField[];
  optional: SchemaViewField[];
} {
  return {
    required: fields.filter((field) => field.required),
    optional: fields.filter((field) => !field.required),
  };
}

type SchemaRecord = Record<string, unknown>;

/** How many levels of `array of` and alternatives a type string spells out before it ends. */
const TYPE_DEPTH_LIMIT = 4;

/**
 * How many fields one schema expands to, in total. Expansion stops there and
 * marks the fields it did not open as truncated, so a schema whose references
 * fan out cannot grow the list past what a person could read.
 */
const FIELD_BUDGET = 500;

/** How many enum values a type string lists before it ends with an ellipsis. */
const ENUM_VALUES_SHOWN = 8;

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
 * Combines the `properties` of two schemas. A property both declare keeps both
 * definitions, joined under `allOf`, so the walk merges them when it reads the
 * property, instead of one definition replacing the other.
 */
function mergeProperties(base: unknown, incoming: unknown): SchemaRecord | undefined {
  if (!isRecord(base)) return isRecord(incoming) ? { ...incoming } : undefined;
  if (!isRecord(incoming)) return { ...base };
  const entries = new Map(Object.entries(base));
  for (const [key, definition] of Object.entries(incoming)) {
    const existing = entries.get(key);
    if (existing === undefined || !isRecord(existing)) {
      entries.set(key, definition);
    } else if (isRecord(definition)) {
      entries.set(key, { allOf: [existing, definition] });
    }
  }
  return Object.fromEntries(entries);
}

/**
 * Lays `over` on top of `base`: its keywords win, except that `properties` and
 * `required` from both are kept.
 */
function overlay(base: SchemaRecord, over: SchemaRecord): SchemaRecord {
  const result: SchemaRecord = { ...base, ...over };
  const properties = mergeProperties(base['properties'], over['properties']);
  if (properties) result['properties'] = properties;
  const required = [...stringList(base['required']), ...stringList(over['required'])];
  if (required.length > 0) result['required'] = [...new Set(required)];
  return result;
}

/**
 * Resolves `$ref` chains and merges `allOf` members into one flat schema, so
 * the rest of the walk reads `properties` and `required` from a single place.
 * `seen` holds the references on the current path: one of them is left
 * unresolved, which stops a cycle. Every reference this call follows is added
 * to `followed`, so the caller can extend the path beneath the schema.
 */
function flatten(
  root: SchemaRecord,
  schema: SchemaRecord,
  seen: readonly string[],
  followed: string[] = [],
): SchemaRecord {
  let result: SchemaRecord = { ...schema };
  const reference = result['$ref'];
  if (typeof reference === 'string' && !seen.includes(reference)) {
    const target = resolveReference(root, reference);
    if (target) {
      delete result['$ref'];
      followed.push(reference);
      result = overlay(flatten(root, target, [...seen, reference], followed), result);
    }
  }
  const members = result['allOf'];
  if (Array.isArray(members)) {
    delete result['allOf'];
    for (const member of members) {
      if (!isRecord(member)) continue;
      // The schema's own keywords, and those of earlier members, win.
      result = overlay(flatten(root, member, seen, followed), result);
    }
  }
  return result;
}

/** The name a reference ends in, for example `node` for `#/$defs/node`. */
function referenceName(reference: string): string {
  const last = reference.split('/').pop() ?? '';
  const name = last.replaceAll('~1', '/').replaceAll('~0', '~');
  return reference === '#' || name === '' || name === '#' ? 'schema' : name;
}

/** A value as plain text: a string as it is, anything else as JSON. */
function plain(value: unknown): string {
  return typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
}

/** The types a schema names, in plain words. */
const TYPE_WORDS = new Map<string, string>([
  ['string', 'text'],
  ['number', 'number'],
  ['integer', 'whole number'],
  ['boolean', 'yes or no'],
  ['null', 'none'],
  ['object', 'object'],
]);

/** The formats that read better as a word than as `text (format)`. */
const FORMAT_WORDS = new Map<string, string>([
  ['date-time', 'date and time'],
  ['date', 'date'],
  ['time', 'time'],
  ['email', 'email address'],
  ['uri', 'link'],
  ['url', 'link'],
  ['uuid', 'ID'],
]);

/** The type a field reads as when it holds a JSON Schema document. */
const JSON_SCHEMA_TYPE = 'JSON schema';

/** A label as a noun in running text: `Steps` reads `steps`, `Order ID` reads `order ID`. */
function lowerNoun(label: string): string {
  return label
    .split(' ')
    .map((word) => (word === word.toUpperCase() && word.length > 1 ? word : word.toLowerCase()))
    .join(' ');
}

/** One branch of a choice: the object a `oneOf` or `anyOf` member describes. */
type Choice = {
  /** What the branch is called: the value of the property that tells the branches apart. */
  name: string;
  schema: SchemaRecord;
};

/** The branches of a `oneOf` or `anyOf` whose members are all objects, and what tells them apart. */
type Choices = {
  members: Choice[];
  /** The property whose constant value names each branch, when every branch has one. */
  discriminator?: string;
};

/** The single value a property is fixed to by `const` or a one-value `enum`, if it is. */
function fixedValue(root: SchemaRecord, definition: unknown): string | undefined {
  if (!isRecord(definition)) return undefined;
  const schema = flatten(root, definition, []);
  if ('const' in schema) return plain(schema['const']);
  const values = schema['enum'];
  return Array.isArray(values) && values.length === 1 ? plain(values[0]) : undefined;
}

const COMMON_DISCRIMINATORS = ['kind', 'type', 'mode', 'variant'];

/** The property that names each branch: a constant in every branch, with a different value in each. */
function findDiscriminator(root: SchemaRecord, members: SchemaRecord[]): string | undefined {
  const first = members[0]?.['properties'];
  if (!isRecord(first)) return undefined;
  const candidates = [
    ...COMMON_DISCRIMINATORS.filter((key) => Object.hasOwn(first, key)),
    ...Object.keys(first).filter((key) => !COMMON_DISCRIMINATORS.includes(key)),
  ];
  return candidates.find((key) => {
    const values = members.map((member) => {
      const properties = member['properties'];
      return isRecord(properties) && Object.hasOwn(properties, key)
        ? fixedValue(root, properties[key])
        : undefined;
    });
    return values.every((value) => value !== undefined) && new Set(values).size === values.length;
  });
}

/**
 * Reads a `oneOf` or `anyOf` of objects as a choice. Returns `undefined` when the schema has no
 * such keyword, when it has fewer than two members, or when a member is not an object.
 */
function readChoices(
  root: SchemaRecord,
  schema: SchemaRecord,
  seen: readonly string[],
): Choices | undefined {
  const members = alternatives(root, schema, seen);
  if (members.length < 2) return undefined;
  const objects = members.every(
    (member) => isRecord(member['properties']) || member['type'] === 'object',
  );
  if (!objects) return undefined;
  const discriminator = findDiscriminator(root, members);
  const names = members.map((member, index) => {
    const properties = member['properties'];
    if (
      discriminator !== undefined &&
      isRecord(properties) &&
      Object.hasOwn(properties, discriminator)
    ) {
      return fixedValue(root, properties[discriminator]) ?? `option ${index + 1}`;
    }
    const title = member['title'];
    return typeof title === 'string' && title !== '' ? title : `option ${index + 1}`;
  });
  return {
    members: members.map((member, index) => ({
      name: names[index] ?? `option ${index + 1}`,
      schema: member,
    })),
    ...(discriminator === undefined ? {} : { discriminator }),
  };
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
  label: string,
  depth = 0,
): string {
  if (depth >= TYPE_DEPTH_LIMIT) return '…';
  const reference = schema['$ref'];
  if (typeof reference === 'string') {
    if (resolveReference(root, reference)) {
      // Left unresolved only because it is already being expanded above.
      return `${referenceName(reference)} (recursive)`;
    }
    if (reference.includes('json-schema.org')) return JSON_SCHEMA_TYPE;
  }
  if (schema['format'] === 'json-schema') return JSON_SCHEMA_TYPE;
  if (Array.isArray(schema['enum'])) {
    const values = schema['enum'].map(plain);
    const shown = values.slice(0, ENUM_VALUES_SHOWN).join(', ');
    return `one of: ${values.length > ENUM_VALUES_SHOWN ? `${shown}, …` : shown}`;
  }
  if ('const' in schema) return `exactly ${plain(schema['const'])}`;

  const choices = readChoices(root, schema, seen);
  if (choices) return `one of: ${choices.members.map((member) => member.name).join(', ')}`;

  const declared = schema['type'];
  const types = typeof declared === 'string' ? [declared] : stringList(declared);
  if (types.length > 0) {
    return types
      .map((type) => {
        if (type === 'array') {
          const items = isRecord(schema['items'])
            ? flatten(root, schema['items'], seen)
            : undefined;
          if (!items) return 'list';
          if (isRecord(items['properties'])) {
            const title = items['title'];
            return `list of ${typeof title === 'string' && title !== '' ? title.toLowerCase() : lowerNoun(label)}`;
          }
          return `list of ${describeType(root, items, seen, label, depth + 1)}`;
        }
        if (type === 'string' && typeof schema['format'] === 'string') {
          return FORMAT_WORDS.get(schema['format']) ?? 'text';
        }
        if (type === 'object' && isRecord(schema['properties'])) return 'group of fields';
        return TYPE_WORDS.get(type) ?? type;
      })
      .join(' or ');
  }

  const members = alternatives(root, schema, seen);
  if (members.length > 0) {
    return members.map((member) => describeType(root, member, seen, label, depth + 1)).join(' or ');
  }
  if (isRecord(schema['properties'])) return 'group of fields';
  if (isRecord(schema['items'])) return 'list';
  return 'anything';
}

/** The object whose `properties` a field shows underneath it, if there is one. */
function nestedObject(
  root: SchemaRecord,
  schema: SchemaRecord,
  seen: readonly string[],
  followed: string[],
): SchemaRecord | undefined {
  if (isRecord(schema['properties'])) return schema;
  if (isRecord(schema['items'])) {
    const items = flatten(root, schema['items'], seen, followed);
    if (isRecord(items['properties'])) return items;
  }
  return undefined;
}

/** What is left to spend on fields, shared by every level of one walk. */
type FieldBudget = { remaining: number };

/** Where in the schema a walk is, and how it reads fields there. */
type FieldWalk = {
  root: SchemaRecord;
  maxDepth: number;
  budget: FieldBudget;
};

/** How the fields of one object are named: under a parent, and inside one branch of a choice. */
type FieldScope = {
  /** The path of the field that holds them, `''` at the top. */
  parentPath: string;
  /** The branch they belong to, when they are the fields of one branch of a choice. */
  branch?: string;
};

/** The types a schema declares, without `null`, and whether `null` was one of them. */
function declaredTypes(schema: SchemaRecord): { types: string[]; nullable: boolean } {
  const declared = schema['type'];
  const all = typeof declared === 'string' ? [declared] : stringList(declared);
  return { types: all.filter((type) => type !== 'null'), nullable: all.includes('null') };
}

const KIND_BY_TYPE = new Map<string, SchemaViewKind>([
  ['string', 'text'],
  ['number', 'number'],
  ['integer', 'number'],
  ['boolean', 'boolean'],
  ['object', 'object'],
  ['array', 'list'],
]);

/** What kind of value a (flattened) schema takes. */
function fieldKind(schema: SchemaRecord, isChoice: boolean): SchemaViewKind {
  if (isChoice || Array.isArray(schema['enum']) || 'const' in schema) return 'choice';
  const { types } = declaredTypes(schema);
  if (types.length === 1) return KIND_BY_TYPE.get(types[0] ?? '') ?? 'any';
  if (types.length === 0) {
    if (isRecord(schema['properties'])) return 'object';
    if (isRecord(schema['items'])) return 'list';
  }
  return 'any';
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** A limit in words: `1 to 3 items`, `At least 1 character`, `At most 1`. */
function rangeFact(minimum: unknown, maximum: unknown, unit = ''): SchemaViewFact | undefined {
  const low = finiteNumber(minimum);
  const high = finiteNumber(maximum);
  const of = (count: number) => (unit === '' ? '' : ` ${count === 1 ? unit : `${unit}s`}`);
  if (low !== undefined && high !== undefined) {
    return { label: low === high ? `Exactly ${low}${of(low)}` : `${low} to ${high}${of(high)}` };
  }
  if (low !== undefined) return { label: `At least ${low}${of(low)}` };
  if (high !== undefined) return { label: `At most ${high}${of(high)}` };
  return undefined;
}

/**
 * The quiet facts about a field's value, in reading order: what kind of number or text it is,
 * what it holds, the values it allows, its default, and its limits.
 */
function fieldFacts(
  schema: SchemaRecord,
  kind: SchemaViewKind,
  type: string,
  choices: Choices | undefined,
): SchemaViewFact[] {
  const facts: SchemaViewFact[] = [];
  const { types, nullable } = declaredTypes(schema);
  if (types.length === 1 && types[0] === 'integer') facts.push({ label: 'Whole number' });
  const format = schema['format'];
  if (kind === 'text' && typeof format === 'string') {
    facts.push({ label: 'Format:', detail: FORMAT_WORDS.get(format) ?? format });
  }
  if (kind === 'list' && type.startsWith('list of ')) {
    facts.push({ label: 'Holds', detail: type.slice('list of '.length) });
  }
  if (kind === 'any' && type !== 'anything') facts.push({ label: type });
  const values = schema['enum'];
  if (Array.isArray(values)) {
    const shown = values.slice(0, ENUM_VALUES_SHOWN).map(plain);
    facts.push({
      label: 'One of',
      values: values.length > ENUM_VALUES_SHOWN ? [...shown, '…'] : shown,
    });
  } else if ('const' in schema) {
    facts.push({ label: 'Always', values: [plain(schema['const'])] });
  } else if (choices) {
    facts.push({
      label: 'One of',
      detail: choices.members.map((member) => member.name).join(', '),
    });
  }
  if (nullable) facts.push({ label: 'Or none' });
  if ('default' in schema) facts.push({ label: 'Default', values: [plain(schema['default'])] });
  const limits =
    kind === 'text'
      ? rangeFact(schema['minLength'], schema['maxLength'], 'character')
      : kind === 'list'
        ? rangeFact(schema['minItems'], schema['maxItems'], 'item')
        : kind === 'number'
          ? rangeFact(
              schema['minimum'] ?? schema['exclusiveMinimum'],
              schema['maximum'] ?? schema['exclusiveMaximum'],
            )
          : undefined;
  if (limits) facts.push(limits);
  if (typeof schema['pattern'] === 'string') {
    facts.push({ label: 'Matches', values: [schema['pattern']] });
  }
  return facts;
}

function describeField(field: SchemaViewField, schema: SchemaRecord): SchemaViewField {
  const description = schema['description'];
  if (typeof description === 'string' && description.trim() !== '') {
    field.description = description;
    const { summary, detail } = splitDescription(description);
    field.summary = summary;
    if (detail !== undefined) field.detail = detail;
  }
  return field;
}

function buildFields(
  walk: FieldWalk,
  parent: SchemaRecord,
  path: readonly string[],
  depth: number,
  scope: FieldScope,
  skip?: string,
): SchemaViewField[] {
  const { root, maxDepth, budget } = walk;
  const properties = parent['properties'];
  if (!isRecord(properties)) return [];
  const required = new Set(stringList(parent['required']));
  const fields: SchemaViewField[] = [];
  for (const [key, definition] of Object.entries(properties)) {
    if (key === skip) continue;
    // `path` holds the references being expanded above this field. A reference
    // on it is not followed again: the field shows the reference's name instead.
    const followed: string[] = [];
    const schema = isRecord(definition) ? flatten(root, definition, path, followed) : {};
    // The type is read against the references that led to this field only. The
    // ones `nestedObject` follows into an array's items are being expanded
    // below the field, not above it, so they do not make its type recursive.
    const typePath = [...path, ...followed];
    const nested = nestedObject(root, schema, path, followed);
    const choices = readChoices(root, schema, typePath);
    const below = [...path, ...followed];
    budget.remaining -= 1;
    const label = humanizeIdentifier(key, { casing: 'sentence' });
    const shownLabel = scope.branch === undefined ? label : `If ${scope.branch}: ${label}`;
    const fieldPath = `${scope.parentPath}${scope.parentPath === '' ? '' : '/'}${
      scope.branch === undefined ? '' : `${scope.branch}:`
    }${key}`;
    const hasChildren =
      nested !== undefined ||
      (choices !== undefined &&
        choices.members.some((member) => isRecord(member.schema['properties'])));
    const expand = hasChildren && depth < maxDepth && budget.remaining > 0;
    const children: SchemaViewField[] = [];
    if (expand) {
      if (nested) {
        children.push(...buildFields(walk, nested, below, depth + 1, { parentPath: fieldPath }));
      }
      if (choices) children.push(...buildBranchFields(walk, choices, below, depth + 1, fieldPath));
    }
    const type = describeType(root, schema, typePath, label);
    const kind = fieldKind(schema, choices !== undefined);
    fields.push(
      describeField(
        {
          key,
          path: fieldPath,
          label: shownLabel,
          type,
          required: required.has(key),
          fields: children,
          truncated: hasChildren && !expand,
          kind,
          facts: fieldFacts(schema, kind, type, choices),
        },
        schema,
      ),
    );
  }
  return fields;
}

/** The fields of every branch of a choice, each labelled `If <choice>: <field>`. */
function buildBranchFields(
  walk: FieldWalk,
  choices: Choices,
  path: readonly string[],
  depth: number,
  parentPath: string,
): SchemaViewField[] {
  return choices.members.flatMap((member) =>
    buildFields(
      walk,
      member.schema,
      path,
      depth,
      { parentPath, branch: member.name },
      choices.discriminator,
    ),
  );
}

/**
 * Reads a JSON Schema into the fields a person scans: one entry per property,
 * with a sentence-case label, a type in plain words, the description, whether
 * it is required, and the fields of a nested object. Local `$ref`s are followed
 * and `allOf` members are merged. A `oneOf` of objects that tell themselves
 * apart by a constant property (`kind: { const: 'email' }`) lists each branch's
 * fields under the choice, labelled `If email: Address`; the constant property
 * itself is not a field. A schema that is not an object with properties yields
 * one `Value` field, so the view still names the type; `true`, `{}` and
 * anything unreadable yield no fields.
 *
 * Fields come in the order the schema declares them; use
 * `partitionRequiredFields` to read the required ones first.
 *
 * `maxDepth` bounds how many levels of nested objects are expanded. A schema
 * that refers to itself shows the reference, for example `node (recursive)`,
 * rather than expanding it again, and the walk stops opening nested objects
 * once it has listed `FIELD_BUDGET` fields; the ones it did not open are marked
 * `truncated`.
 */
export function readSchemaFields(schema: unknown, requestedDepth = 8): SchemaViewField[] {
  if (!isRecord(schema)) return [];
  // A caller can pass anything despite the types: a non-finite depth falls back.
  const maxDepth = Number.isFinite(requestedDepth) ? requestedDepth : 8;
  const followed: string[] = [];
  const root = flatten(schema, schema, [], followed);
  const nested = nestedObject(schema, root, [], followed);
  // `#` is the document itself, which is being expanded from the start.
  const path = ['#', ...followed];
  const walk: FieldWalk = { root: schema, maxDepth, budget: { remaining: FIELD_BUDGET } };
  const choices = readChoices(schema, root, path);
  const branchesHaveFields =
    choices?.members.some((member) => isRecord(member.schema['properties'])) ?? false;
  if (nested || branchesHaveFields) {
    return [
      ...(nested ? buildFields(walk, nested, path, 0, { parentPath: '' }) : []),
      ...(choices && branchesHaveFields ? buildBranchFields(walk, choices, path, 0, '') : []),
    ];
  }
  if (Object.keys(root).length === 0) return [];
  const type = describeType(schema, root, path, 'Value');
  const kind = fieldKind(root, choices !== undefined);
  const field: SchemaViewField = {
    key: 'value',
    path: 'value',
    label: 'Value',
    type,
    required: false,
    fields: [],
    truncated: false,
    kind,
    facts: fieldFacts(root, kind, type, choices),
  };
  return [describeField(field, root)];
}
