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

/** The most steps a rating draws as a row of buttons; a wider range is a number field. */
export const MAXIMUM_RATING_STEPS = 20;

/**
 * The integer steps of a rating, `minimum` to `maximum`, each with its `x-labels` entry when it
 * has one. A range wider than {@link MAXIMUM_RATING_STEPS} has no steps to draw: it returns `[]`,
 * and {@link ratingBounds} says what the number field takes.
 */
export function ratingStepsOf(schema: SchemaNode): QuestionChoice[] {
  const bounds = ratingBounds(schema);
  if (bounds === undefined || bounds.maximum - bounds.minimum + 1 > MAXIMUM_RATING_STEPS) return [];
  const steps: QuestionChoice[] = [];
  for (let step = bounds.minimum; step <= bounds.maximum; step += 1) {
    steps.push({ value: step, label: labelFor(schema, step) });
  }
  return steps;
}

/** The inclusive integer range of a rating, or `undefined` when the schema does not give one. */
export function ratingBounds(schema: SchemaNode): { minimum: number; maximum: number } | undefined {
  const minimum = schemaKeyword(schema, 'minimum');
  const maximum = schemaKeyword(schema, 'maximum');
  if (typeof minimum !== 'number' || typeof maximum !== 'number') return undefined;
  return { minimum, maximum };
}

/** The numeric keyword `name` of `schema`, when it is a number. */
export function schemaNumber(schema: SchemaNode, name: string): number | undefined {
  const value = schemaKeyword(schema, name);
  return typeof value === 'number' ? value : undefined;
}

/** The `contentMediaType` a file question asks for (`image/png`, `image/*`), without parameters, or `undefined` for any file. */
export function acceptedMediaType(schema: SchemaNode): string | undefined {
  const type = schemaKeyword(schema, 'contentMediaType');
  if (typeof type !== 'string') return undefined;
  const bare = (type.split(';')[0] ?? '').trim().toLowerCase();
  return bare === '' || bare === '*/*' ? undefined : bare;
}

/** `application/x-yaml` as `application/yaml`: `x-` marks the same type under an older name. */
function withoutExperimentalPrefix(mediaType: string): string {
  return mediaType.replace(/^([^/]+)\/x-/, '$1/');
}

/**
 * Whether a file of media type `fileType` satisfies the `accepted` type: an exact match or a
 * `type/*` family. A browser leaves the type empty when it cannot name one (`.yaml`), so an empty
 * type is unknown and is accepted.
 */
export function mediaTypeMatches(accepted: string | undefined, fileType: string): boolean {
  if (accepted === undefined) return true;
  const actual = withoutExperimentalPrefix((fileType.split(';')[0] ?? '').trim().toLowerCase());
  if (actual === '') return true;
  const wanted = withoutExperimentalPrefix(accepted);
  if (wanted.endsWith('/*')) return actual.startsWith(wanted.slice(0, -1));
  return actual === wanted;
}
