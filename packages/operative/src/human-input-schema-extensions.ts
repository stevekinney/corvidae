/**
 * The `x-` keywords a human-input answer schema may use to say which control to show (COR-1804).
 *
 * JSON Schema 2020-12 ignores keywords it does not know, so these ride beside the standard ones:
 * `x-labels` (what to show for each enum value or rating step), `x-allowOther` (a choice that also
 * takes free text), `x-kind: "rating"` (an integer range shown as a rating, not a number),
 * `x-secret` (a string that is never echoed and never reaches the model), and `x-asset` (a string
 * that is a managed asset id). A keyword is useless if a client cannot rely on its shape, so each
 * one that is present is checked here and a schema that misuses one is refused.
 *
 * @module human-input-schema-extensions
 */

import type { HumanInputSchemaIssue } from './human-input-schema';

/** The longest label `x-labels` may give one choice or rating step. */
export const HUMAN_INPUT_LABEL_MAXIMUM_LENGTH = 500;

type Path = ReadonlyArray<string | number>;
type SchemaNode = Readonly<Record<string, unknown>>;

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keywords whose value is one subschema. */
const SUBSCHEMA_KEYWORDS = [
  'items',
  'additionalProperties',
  'contains',
  'propertyNames',
  'not',
  'if',
  'then',
  'else',
  'unevaluatedItems',
  'unevaluatedProperties',
  'contentSchema',
] as const;
/** Keywords whose value is an array of subschemas. */
const SUBSCHEMA_LIST_KEYWORDS = ['allOf', 'anyOf', 'oneOf', 'prefixItems'] as const;
/** Keywords whose value is a map from a name to a subschema. */
const SUBSCHEMA_MAP_KEYWORDS = ['properties', '$defs', 'definitions', 'dependentSchemas'] as const;

/**
 * Every schema node under `node`, `node` first, found only where JSON Schema puts a subschema, so
 * data a schema merely holds (`enum`, `const`, `default`, `examples`) is never read as a schema.
 */
function* schemaNodes(node: SchemaNode, path: Path): Generator<{ node: SchemaNode; path: Path }> {
  yield { node, path };
  for (const keyword of SUBSCHEMA_KEYWORDS) {
    const child: unknown = Object.hasOwn(node, keyword) ? node[keyword] : undefined;
    if (isNode(child)) yield* schemaNodes(child, [...path, keyword]);
  }
  for (const keyword of SUBSCHEMA_LIST_KEYWORDS) {
    const children: unknown = Object.hasOwn(node, keyword) ? node[keyword] : undefined;
    if (!Array.isArray(children)) continue;
    for (const [index, child] of children.entries()) {
      if (isNode(child)) yield* schemaNodes(child, [...path, keyword, index]);
    }
  }
  for (const keyword of SUBSCHEMA_MAP_KEYWORDS) {
    const children: unknown = Object.hasOwn(node, keyword) ? node[keyword] : undefined;
    if (!isNode(children)) continue;
    for (const name of Object.keys(children)) {
      const child: unknown = Object.hasOwn(children, name) ? children[name] : undefined;
      if (isNode(child)) yield* schemaNodes(child, [...path, keyword, name]);
    }
  }
}

/** The enum values a node offers: its own `enum`, those of its `anyOf`/`oneOf` branches, and those of its `items`. */
function enumValuesOf(node: SchemaNode): string[] {
  const values: string[] = [];
  const collect = (candidate: unknown): void => {
    if (!isNode(candidate) || !Array.isArray(candidate['enum'])) return;
    for (const value of candidate['enum']) values.push(String(value));
  };
  collect(node);
  collect(node['items']);
  for (const keyword of ['anyOf', 'oneOf'] as const) {
    const branches: unknown = node[keyword];
    if (Array.isArray(branches)) branches.forEach(collect);
  }
  return values;
}

function checkSecret(node: SchemaNode, path: Path, add: Adder): void {
  const value = node['x-secret'];
  if (typeof value !== 'boolean')
    return add([...path, 'x-secret'], 'x-secret must be true or false.');
  if (!value) return;
  if (node['type'] !== 'string')
    add([...path, 'x-secret'], 'x-secret needs type "string" beside it.');
  if (node['writeOnly'] !== true) {
    add([...path, 'x-secret'], 'x-secret needs writeOnly: true beside it.');
  }
}

function checkAsset(node: SchemaNode, path: Path, add: Adder): void {
  const value = node['x-asset'];
  if (typeof value !== 'boolean')
    return add([...path, 'x-asset'], 'x-asset must be true or false.');
  if (value && node['type'] !== 'string') {
    add(
      [...path, 'x-asset'],
      'x-asset needs type "string" beside it: the answer is a managed asset id.',
    );
  }
}

function checkAllowOther(node: SchemaNode, path: Path, add: Adder): void {
  const value = node['x-allowOther'];
  if (typeof value !== 'boolean') {
    return add([...path, 'x-allowOther'], 'x-allowOther must be true or false.');
  }
  if (!value) return;
  const branches: unknown = node['anyOf'];
  const list = Array.isArray(branches) ? branches.filter(isNode) : [];
  const offersChoices = list.some((branch) => Array.isArray(branch['enum']));
  const takesText = list.some(
    (branch) => branch['type'] === 'string' && !Array.isArray(branch['enum']),
  );
  if (!offersChoices || !takesText) {
    add(
      [...path, 'x-allowOther'],
      'x-allowOther needs anyOf beside it with one branch that has an "enum" and one that is a plain {"type":"string"}.',
    );
  }
}

function checkKind(node: SchemaNode, path: Path, add: Adder): void {
  if (node['x-kind'] !== 'rating') {
    return add([...path, 'x-kind'], 'x-kind must be "rating", the only kind defined.');
  }
  const { minimum, maximum } = node;
  if (node['type'] !== 'integer')
    add([...path, 'x-kind'], 'A rating needs type "integer" beside it.');
  if (!Number.isInteger(minimum) || !Number.isInteger(maximum)) {
    add([...path, 'x-kind'], 'A rating needs integer "minimum" and "maximum" beside it.');
  } else if ((minimum as number) > (maximum as number)) {
    add([...path, 'x-kind'], 'A rating’s "minimum" must not exceed its "maximum".');
  }
}

function checkLabels(node: SchemaNode, path: Path, add: Adder): void {
  const labels = node['x-labels'];
  if (!isNode(labels)) {
    return add([...path, 'x-labels'], 'x-labels must be an object from each choice to its label.');
  }
  const isRating = node['x-kind'] === 'rating';
  const offered = new Set(enumValuesOf(node));
  if (!isRating && offered.size === 0) {
    add([...path, 'x-labels'], 'x-labels needs an "enum" (or x-kind "rating") to label.');
  }
  const { minimum, maximum } = node;
  for (const key of Object.keys(labels)) {
    const label: unknown = Object.hasOwn(labels, key) ? labels[key] : undefined;
    const where: Path = [...path, 'x-labels', key];
    if (
      typeof label !== 'string' ||
      label.length === 0 ||
      label.length > HUMAN_INPUT_LABEL_MAXIMUM_LENGTH
    ) {
      add(
        where,
        `The label for "${key}" must be a string of 1 to ${HUMAN_INPUT_LABEL_MAXIMUM_LENGTH} characters.`,
      );
    }
    if (isRating) {
      const step = Number(key);
      if (
        !Number.isInteger(step) ||
        (Number.isInteger(minimum) && step < (minimum as number)) ||
        (Number.isInteger(maximum) && step > (maximum as number))
      ) {
        add(where, `"${key}" is not a step of this rating.`);
      }
    } else if (offered.size > 0 && !offered.has(key)) {
      add(where, `"${key}" is not one of the enum values.`);
    }
  }
}

type Adder = (path: Path, message: string) => void;

/**
 * Checks every `x-` keyword in a schema and returns one issue per misuse, or `[]`. The schema is
 * already known to be a valid 2020-12 schema; this checks only the shapes the `x-` keywords promise.
 */
export function humanInputSchemaExtensionIssues(
  schema: Readonly<Record<string, unknown>>,
): HumanInputSchemaIssue[] {
  const issues: HumanInputSchemaIssue[] = [];
  for (const { node, path } of schemaNodes(schema, [])) {
    const add: Adder = (at, message) => {
      issues.push({ path: at, message });
    };
    if (Object.hasOwn(node, 'x-secret')) checkSecret(node, path, add);
    if (Object.hasOwn(node, 'x-asset')) checkAsset(node, path, add);
    if (Object.hasOwn(node, 'x-allowOther')) checkAllowOther(node, path, add);
    if (Object.hasOwn(node, 'x-kind')) checkKind(node, path, add);
    if (Object.hasOwn(node, 'x-labels')) checkLabels(node, path, add);
  }
  return issues;
}
