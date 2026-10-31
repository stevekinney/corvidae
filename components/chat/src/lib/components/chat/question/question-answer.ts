/**
 * What the chat keeps of a question once it is answered, and how the answer reads back.
 *
 * A secret is never kept: its record holds no value, and its summary is fixed words, so nothing the
 * person typed can reach a rendered row, a message part, or a re-render after Change.
 */

import { choicesOf, classifyQuestion, schemaKeyword, type QuestionKind } from './question-kind.ts';

/** One reason an answer was refused, as the host's validation reports it. */
export interface ChatQuestionIssue {
  /** Where in the answer the problem is, as property names and array indexes; `[]` is the answer itself. */
  readonly path: readonly (string | number)[];
  /** What is wrong, in a sentence the person can act on. */
  readonly message: string;
}

/**
 * What `onInputSubmit` rejects with when the host refused the answer for reasons the person can
 * fix. The issues are shown on the fields they name (paths are relative to the answer), and the
 * question stays open. Any other rejection reads as "could not be sent".
 */
export class ChatQuestionAnswerError extends Error {
  /** Why the answer was refused. */
  readonly issues: readonly ChatQuestionIssue[];

  constructor(issues: readonly ChatQuestionIssue[], message?: string) {
    super(message ?? issues.map((issue) => issue.message).join('; '));
    this.name = 'ChatQuestionAnswerError';
    this.issues = issues;
  }
}

/** The issues a rejection carries, or `undefined` when it is not a refusal of the answer. */
export function issuesOfRejection(error: unknown): readonly ChatQuestionIssue[] | undefined {
  if (typeof error !== 'object' || error === null || !('issues' in error)) return undefined;
  const { issues } = error;
  if (!Array.isArray(issues)) return undefined;
  const found: ChatQuestionIssue[] = [];
  for (const issue of issues as unknown[]) {
    if (typeof issue !== 'object' || issue === null) continue;
    const message = 'message' in issue ? issue.message : undefined;
    const path = 'path' in issue ? issue.path : undefined;
    if (typeof message !== 'string') continue;
    found.push({
      path: Array.isArray(path)
        ? (path as unknown[]).filter(
            (segment): segment is string | number =>
              typeof segment === 'string' || typeof segment === 'number',
          )
        : [],
      message,
    });
  }
  return found.length > 0 ? found : undefined;
}

/** An answered question, kept for the collapsed "You answered" row and for Change. */
export interface QuestionAnswerRecord {
  /** The tool call the question parked. */
  readonly toolCallId: string;
  /** The tool that asked. */
  readonly toolName: string;
  /** The question's prompt. */
  readonly message: string | undefined;
  /** The schema the answer was given against. */
  readonly schema: Readonly<Record<string, unknown>>;
  /** The answer in words. Fixed words for a secret. */
  readonly summary: string;
  /** The answer, to pre-fill Change; `undefined` for a secret, which is never kept. */
  readonly value: unknown;
  /** Whether the answer is or holds a secret. */
  readonly secret: boolean;
}

/** What a secret answer reads as, whatever was typed. */
export const SECRET_SUMMARY = 'a secret (not shown)';

type SchemaNode = Readonly<Record<string, unknown>>;

function isNode(value: unknown): value is SchemaNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function propertiesOf(schema: SchemaNode): [string, SchemaNode][] {
  const properties = schemaKeyword(schema, 'properties');
  if (!isNode(properties)) return [];
  return Object.keys(properties).flatMap((name) => {
    const property = Object.hasOwn(properties, name) ? properties[name] : undefined;
    return isNode(property) ? [[name, property] as [string, SchemaNode]] : [];
  });
}

/** Whether the answer schema marks the answer, or a field of it, as a secret. */
export function holdsSecret(schema: SchemaNode): boolean {
  if (schemaKeyword(schema, 'x-secret') === true) return true;
  return propertiesOf(schema).some(([, property]) => holdsSecret(property));
}

/** `value` with every secret field of `schema` removed, so the rest can be kept to pre-fill Change. */
export function withoutSecrets(schema: SchemaNode, value: unknown): unknown {
  if (schemaKeyword(schema, 'x-secret') === true) return undefined;
  if (!isNode(value)) return value;
  const kept: Record<string, unknown> = {};
  const fields = new Map(propertiesOf(schema));
  for (const key of Object.keys(value)) {
    const property = fields.get(key);
    const next = property === undefined ? value[key] : withoutSecrets(property, value[key]);
    if (next !== undefined || property === undefined) kept[key] = next;
  }
  return kept;
}

function labelOfValue(schema: SchemaNode, value: unknown): string {
  const match = choicesOf(schema).find((choice) => Object.is(choice.value, value));
  return match === undefined ? String(value) : match.label;
}

function scalarText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value) ?? '';
}

function fieldsSummary(schema: SchemaNode, value: unknown): string {
  if (!isNode(value)) return scalarText(value);
  const properties = new Map(propertiesOf(schema));
  return Object.keys(value)
    .map((key) => {
      const property = properties.get(key);
      const title = property === undefined ? undefined : schemaKeyword(property, 'title');
      const label = typeof title === 'string' && title !== '' ? title : key;
      const secret = property !== undefined && holdsSecret(property);
      return `${label}: ${secret ? '••••' : summarizeValue(property, value[key])}`;
    })
    .join(', ');
}

function summarizeValue(schema: SchemaNode | undefined, value: unknown): string {
  if (schema === undefined) return scalarText(value);
  const kind: QuestionKind = classifyQuestion(schema);
  if (kind === 'secret') return SECRET_SUMMARY;
  if (kind === 'boolean') return value === true ? 'Yes' : 'No';
  if (kind === 'choice' || kind === 'rating') return labelOfValue(schema, value);
  if (kind === 'multiple') {
    const picked = Array.isArray(value) ? (value as unknown[]) : [];
    return picked.map((entry) => labelOfValue(schema, entry)).join(', ');
  }
  if (kind === 'choice-other') {
    const label = labelOfValue(schema, value);
    return label;
  }
  if (kind === 'fields') return fieldsSummary(schema, value);
  return scalarText(value);
}

/** The answer in words, for the "You answered …" row. A secret reads as {@link SECRET_SUMMARY}. */
export function summarizeAnswer(schema: SchemaNode, value: unknown): string {
  if (holdsSecret(schema) && classifyQuestion(schema) !== 'fields') return SECRET_SUMMARY;
  return summarizeValue(schema, value);
}

/** The record to keep for an answered question; it holds no secret value. */
export function recordAnswer(input: {
  toolCallId: string;
  toolName: string;
  message: string | undefined;
  schema: SchemaNode;
  value: unknown;
}): QuestionAnswerRecord {
  const { toolCallId, toolName, message, schema, value } = input;
  return {
    toolCallId,
    toolName,
    message,
    schema,
    summary: summarizeAnswer(schema, value),
    value: withoutSecrets(schema, value),
    secret: holdsSecret(schema),
  };
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A local `YYYY-MM-DDTHH:MM` (a datetime-local control's value) as RFC 3339 in UTC; `undefined` when it is not a moment. */
export function dateTimeFromLocal(local: string): string | undefined {
  const moment = new Date(local);
  if (local === '' || Number.isNaN(moment.getTime())) return undefined;
  return `${moment.toISOString().slice(0, 19)}Z`;
}

/** A local `HH:MM` (a time control's value) as RFC 3339 `full-time` in UTC on today's date; `undefined` when empty. */
export function timeFromLocal(local: string, today: Date = new Date()): string | undefined {
  const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(local);
  if (match === null) return undefined;
  const moment = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate(),
    Number(match[1]),
    Number(match[2]),
    Number(match[3] ?? 0),
  );
  return `${pad(moment.getUTCHours())}:${pad(moment.getUTCMinutes())}:${pad(moment.getUTCSeconds())}Z`;
}
