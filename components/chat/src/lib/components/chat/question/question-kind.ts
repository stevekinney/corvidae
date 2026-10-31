/**
 * Which control an agent's question is drawn as, read from the answer schema it asked with.
 *
 * The shapes are the ones `requestHumanInput` teaches the model (Operative's README lists them):
 * the standard keywords say what the answer is, and the `x-` keywords (`x-labels`, `x-allowOther`,
 * `x-kind: "rating"`, `x-secret`, `x-asset`) say how to draw it. A schema that matches no kind is
 * drawn by `SchemaForm`, which renders any object and falls back to raw JSON.
 */

/** The kinds of question the chat draws in place. */
export type QuestionKind =
  | 'choice'
  | 'choice-other'
  | 'multiple'
  | 'text'
  | 'boolean'
  | 'number'
  | 'date'
  | 'time'
  | 'date-time'
  | 'rating'
  | 'fields'
  | 'secret'
  | 'file';

/** One option of a choice question: the value that is the answer, and the words shown for it. */
export interface QuestionChoice {
  /** The enum value the answer carries. */
  readonly value: unknown;
  /** What the person reads: the schema's `x-labels` entry, else the value itself. */
  readonly label: string;
}

type SchemaNode = Readonly<Record<string, unknown>>;

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A keyword the schema itself carries; `constructor` and `toString` are never read through the prototype. */
export function schemaKeyword(node: SchemaNode, keyword: string): unknown {
  return Object.hasOwn(node, keyword) ? node[keyword] : undefined;
}

function branchesOf(schema: SchemaNode): SchemaNode[] {
  const branches = schemaKeyword(schema, 'anyOf');
  return Array.isArray(branches) ? branches.filter(isNode) : [];
}

function enumOf(node: SchemaNode | undefined): readonly unknown[] | undefined {
  if (node === undefined) return undefined;
  const values = schemaKeyword(node, 'enum');
  return Array.isArray(values) ? (values as readonly unknown[]) : undefined;
}

function itemsOf(schema: SchemaNode): SchemaNode | undefined {
  const items = schemaKeyword(schema, 'items');
  return isNode(items) ? items : undefined;
}

function formatKind(schema: SchemaNode): QuestionKind | undefined {
  const format = schemaKeyword(schema, 'format');
  if (format === 'date' || format === 'time' || format === 'date-time') return format;
  return undefined;
}

function scalarKind(schema: SchemaNode): QuestionKind | undefined {
  const type = schemaKeyword(schema, 'type');
  if (type === 'boolean') return 'boolean';
  if (type === 'integer' || type === 'number') {
    return schemaKeyword(schema, 'x-kind') === 'rating' ? 'rating' : 'number';
  }
  if (type === 'string') return formatKind(schema) ?? 'text';
  return undefined;
}

/**
 * The kind of question `schema` asks. The first matching rule wins, secrets and files first so a
 * marked string is never drawn as plain text.
 */
export function classifyQuestion(schema: SchemaNode): QuestionKind {
  if (schemaKeyword(schema, 'x-secret') === true) return 'secret';
  if (schemaKeyword(schema, 'x-asset') === true) return 'file';
  if (schemaKeyword(schema, 'x-allowOther') === true && branchesOf(schema).length > 0) {
    return 'choice-other';
  }
  if (schemaKeyword(schema, 'type') === 'array' && enumOf(itemsOf(schema)) !== undefined) {
    return 'multiple';
  }
  if (enumOf(schema) !== undefined) return 'choice';
  return scalarKind(schema) ?? 'fields';
}

/** The `x-labels` entry for `value`, if the schema labels it. */
function labelFor(schema: SchemaNode, value: unknown): string {
  const labels = schemaKeyword(schema, 'x-labels');
  const key = String(value);
  if (isNode(labels) && Object.hasOwn(labels, key)) {
    const label = labels[key];
    if (typeof label === 'string' && label !== '') return label;
  }
  return key;
}

/**
 * The options a choice question offers, in the schema's order: its own `enum`, the `enum` branch
 * of a pick-one-or-something-else question, or the `items.enum` of a pick-several question.
 */
export function choicesOf(schema: SchemaNode): QuestionChoice[] {
  const sources = [
    enumOf(schema),
    enumOf(itemsOf(schema)),
    ...branchesOf(schema).map((branch) => enumOf(branch)),
  ];
  const values = sources.find((candidate) => candidate !== undefined) ?? [];
  return values.map((value) => ({ value, label: labelFor(schema, value) }));
}

/** The integer steps of a rating, `minimum` to `maximum`, each with its `x-labels` entry when it has one. */
export function ratingStepsOf(schema: SchemaNode): QuestionChoice[] {
  const minimum = schemaKeyword(schema, 'minimum');
  const maximum = schemaKeyword(schema, 'maximum');
  if (typeof minimum !== 'number' || typeof maximum !== 'number') return [];
  const steps: QuestionChoice[] = [];
  for (let step = minimum; step <= maximum && steps.length < 20; step += 1) {
    steps.push({ value: step, label: labelFor(schema, step) });
  }
  return steps;
}

/** The numeric keyword `name` of `schema`, when it is a number. */
export function schemaNumber(schema: SchemaNode, name: string): number | undefined {
  const value = schemaKeyword(schema, name);
  return typeof value === 'number' ? value : undefined;
}
