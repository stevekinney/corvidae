/**
 * The one check an answer to a human-wait review passes before anything is claimed or delivered
 * (COR-1804).
 *
 * An answer is untrusted input, and a wait's schema (the model's per-call `answerSchema`, else the
 * author's per-signal one) says what it may be. Every path that answers a human wait goes through
 * `bureau.reviews.resolve`: the `bureau.reviews.resolve` operation, `tasks.respond`, and the AG-UI
 * resume. So the check sits in that one core, {@link validateReviewAnswer}, and each path reports
 * what it returns in its own wire: `InvalidParams` with `data.issues` on the operation, a refusal
 * on a resume.
 *
 * `date`, `time` and `date-time` are asserted here (RFC 3339), because Ajv does not assert any
 * format unless told how; every other `format` stays an annotation. The same limits as a schema's
 * creation apply while answering: no `pattern`, no `$id`, no `$async`.
 *
 * @module review-answer
 */

import type { HumanInputSchema } from '@lostgradient/operative';
import type { ErrorObject } from 'ajv/dist/2020.js';

import { takesPlainText } from './a2ui/input-form.ts';
import type { InteractiveSurfaceJsonObject } from './interactive-surface/types.ts';
import { InteractiveSurfaceSchemaCompiler } from './interactive-surface/validation.ts';

/**
 * One reason an answer does not satisfy its wait's schema. `path` is where in the answer, as
 * property names and array indexes (`[]` is the answer itself); `code` is the schema keyword that
 * failed (`enum`, `type`, `required`, `format`, ...), or `required` for a missing answer and
 * `schema` for a wait whose schema cannot be used. A consumer maps `path` to a field of the control
 * it showed, and `code` to a message of its own.
 */
export interface ReviewAnswerIssue {
  /** Where in the answer the problem is; `[]` is the answer as a whole. */
  readonly path: ReadonlyArray<string | number>;
  /** What is wrong, in a sentence a person or a model can act on. */
  readonly message: string;
  /** The schema keyword that failed, or `required` / `schema` (see the interface). */
  readonly code: string;
}

/** The most issues one check reports, so an answer with thousands of bad entries is not echoed back whole. */
export const REVIEW_ANSWER_MAXIMUM_ISSUES = 50;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

/** `YYYY-MM-DD` naming a day that exists. */
function isRfc3339Date(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  const longest = month === 2 && isLeapYear(year) ? 29 : (DAYS_IN_MONTH[month - 1] ?? 0);
  return day >= 1 && day <= longest;
}

/** `HH:MM:SS`, optional fraction, and a `Z` or `+HH:MM` offset (RFC 3339 `full-time`). */
function isRfc3339Time(value: string): boolean {
  const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (match === null) return false;
  const [hour, minute, second] = [Number(match[1]), Number(match[2]), Number(match[3])];
  // A leap second is allowed to read 60.
  if (hour > 23 || minute > 59 || second > 60) return false;
  return match[4] === undefined || (Number(match[4]) <= 23 && Number(match[5]) <= 59);
}

/** A date, a `T`, and a time (RFC 3339 `date-time`). */
function isRfc3339DateTime(value: string): boolean {
  const parts = value.split(/[Tt]/);
  const [date, time] = parts;
  return parts.length === 2 && isRfc3339Date(date ?? '') && isRfc3339Time(time ?? '');
}

/** What a failed format is told to look like, for the formats this module asserts. */
const FORMAT_EXPECTATIONS: Readonly<Record<string, string>> = {
  date: 'a date as YYYY-MM-DD',
  time: 'a time as HH:MM:SS with an offset, for example 14:30:00Z',
  'date-time':
    'a date and time as YYYY-MM-DDTHH:MM:SS with an offset, for example 2026-10-29T14:30:00Z',
};

/**
 * Compiles and caches the validators for wait schemas. Its formats are the three the question
 * kinds use; the compiler refuses a regular expression, a nested `$id`, and an asynchronous schema.
 */
const answerChecker = new InteractiveSurfaceSchemaCompiler({
  formats: { date: isRfc3339Date, time: isRfc3339Time, 'date-time': isRfc3339DateTime },
});

function unescapePointerSegment(segment: string): string {
  return segment.replaceAll('~1', '/').replaceAll('~0', '~');
}

/** The path Ajv's error points at: its instance path, plus the property a `required` or `additionalProperties` error names. */
function pathOf(error: ErrorObject): Array<string | number> {
  const segments: Array<string | number> =
    error.instancePath === ''
      ? []
      : error.instancePath
          .slice(1)
          .split('/')
          .map((segment) => {
            const name = unescapePointerSegment(segment);
            return /^(0|[1-9]\d*)$/.test(name) ? Number(name) : name;
          });
  const params = error.params as Record<string, unknown>;
  const named =
    error.keyword === 'required' ? params['missingProperty'] : params['additionalProperty'];
  if (
    (error.keyword === 'required' || error.keyword === 'additionalProperties') &&
    typeof named === 'string'
  ) {
    segments.push(named);
  }
  return segments;
}

function messageOf(error: ErrorObject): string {
  const params = error.params as Record<string, unknown>;
  if (error.keyword === 'format' && typeof params['format'] === 'string') {
    const expected = Object.hasOwn(FORMAT_EXPECTATIONS, params['format'])
      ? FORMAT_EXPECTATIONS[params['format']]
      : undefined;
    return expected === undefined ? 'must match its format' : `must be ${expected}`;
  }
  if (error.keyword === 'enum' && Array.isArray(params['allowedValues'])) {
    const allowed = (params['allowedValues'] as unknown[]).map((value) => JSON.stringify(value));
    return `must be one of ${allowed.join(', ')}`;
  }
  if (error.keyword === 'required') return 'is required';
  if (error.keyword === 'additionalProperties') return 'is not an allowed field';
  return error.message ?? 'is not valid';
}

/** The issues for one answer, with the summary errors (`anyOf`, `oneOf`, `if`) dropped wherever a more specific error shares their path. */
function issuesOf(errors: readonly ErrorObject[]): ReviewAnswerIssue[] {
  const issues: ReviewAnswerIssue[] = [];
  const seen = new Set<string>();
  const specificPaths = new Set(
    errors
      .filter((error) => !['anyOf', 'oneOf', 'if'].includes(error.keyword))
      .map((error) => JSON.stringify(pathOf(error))),
  );
  for (const error of errors) {
    const path = pathOf(error);
    const summary = ['anyOf', 'oneOf', 'if'].includes(error.keyword);
    if (summary && specificPaths.has(JSON.stringify(path))) continue;
    const subject = path.length === 0 ? 'The answer' : `"${path.join('.')}"`;
    const issue = { path, message: `${subject} ${messageOf(error)}`, code: error.keyword };
    const key = JSON.stringify(issue);
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(issue);
    if (issues.length === REVIEW_ANSWER_MAXIMUM_ISSUES) break;
  }
  return issues;
}

/**
 * Checks `answer` against the schema of the wait it answers and returns every way it fails, or `[]`
 * when it satisfies the schema. `undefined` is no answer, and a schema that asks for one refuses it
 * as `required`. A schema that cannot be used (it breaks the rules a wait's schema is held to) is a
 * single `schema` issue, because an answer that cannot be checked is not accepted.
 *
 * This is the one place an answer to a human wait is judged; the paths that deliver one call it
 * before they claim the review, so a refusal leaves the review pending.
 */
export function validateReviewAnswer(
  schema: HumanInputSchema,
  answer: unknown,
): readonly ReviewAnswerIssue[] {
  if (answer === undefined) {
    return [
      {
        path: [],
        message: 'An answer matching the question’s schema is required to approve it',
        code: 'required',
      },
    ];
  }
  try {
    return issuesOf(answerChecker.errors(schema as InteractiveSurfaceJsonObject, answer));
  } catch (error) {
    return [
      {
        path: [],
        message: `The question’s schema could not be used: ${error instanceof Error ? error.message : String(error)}`,
        code: 'schema',
      },
    ];
  }
}

/**
 * The value text typed to a wait stands for (COR-1804). A person answers in text, in the chat, the
 * reviews inbox, or the run's wait page, so a wait whose schema asks for more than a string reads
 * the text as JSON (`3` is the integer 3, `{"a":1}` an object). A schema that asks only for a
 * string (`type: "string"`, or `enum`/`const` of strings) takes the text as written, never as JSON.
 * Text that is not JSON is kept as the string it is, so {@link validateReviewAnswer} names the type
 * the schema wanted instead of a parse error.
 */
export function answerFromText(schema: HumanInputSchema, text: string): unknown {
  if (takesPlainText(schema)) return text;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The issues as one line, each message a sentence on its own, for a transport that carries a string. */
export function formatReviewAnswerIssues(issues: readonly ReviewAnswerIssue[]): string {
  return issues.map((issue) => issue.message).join('; ');
}
