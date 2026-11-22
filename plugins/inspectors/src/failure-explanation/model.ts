/**
 * The failure explanation page's model (COR-2543): plain code over what the explain read answers,
 * with no DOM and no bridge. The page is the Bureau's own answer to why one run failed, from what it
 * stored about the run and nothing else, so nothing here words a cause. It reads the answer's
 * fields, names the ones a person reads, and reads a refusal's message and remediation back out of
 * an error result. What it draws of an answer, and the words for it, are the shared ones
 * (`@lostgradient/interborough-plugin/failure-explanation`), which the Run page draws too.
 */

import type { Explanation } from '@lostgradient/interborough-plugin/failure-explanation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isNullableString = (value: unknown): boolean => value === null || typeof value === 'string';

function isVerdict(value: unknown): value is Explanation['verdicts'][number] {
  return (
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    (value['kind'] === 'guardrail' || value['kind'] === 'tripwire') &&
    ['tripwire', 'block', 'warn', 'sanitize', 'redact'].includes(String(value['outcome'])) &&
    (value['step'] === null || Number.isInteger(value['step']))
  );
}

/** Whether `value` is what the explain read answers: a result of any other shape is not drawn. */
function isExplanation(value: unknown): value is Explanation {
  if (!isRecord(value) || !isRecord(value['cause'])) return false;
  const { cause, step } = value;
  return (
    typeof value['summary'] === 'string' &&
    isNullableString(cause['category']) &&
    isNullableString(cause['code']) &&
    isNullableString(cause['kind']) &&
    (step === null ||
      (isRecord(step) && Number.isInteger(step['index']) && typeof step['label'] === 'string')) &&
    (value['tries'] === null || Number.isInteger(value['tries'])) &&
    Array.isArray(value['verdicts']) &&
    value['verdicts'].every(isVerdict) &&
    typeof value['remediation'] === 'string' &&
    Array.isArray(value['nextCommands'])
  );
}

/**
 * The explanation a tool result carries: its structured content, which Chat hands a panel as the
 * agent tool's result in JSON text and an MCP client hands it as an object. The agent tool's own
 * result also holds a `status`, which is `ok` for an explanation, and nothing else is one.
 * `undefined` for an error result, or any other content.
 */
export function explanationOfResult(result: {
  readonly structuredContent?: unknown;
  readonly isError?: boolean | undefined;
}): Explanation | undefined {
  if (result.isError === true) return undefined;
  let content = result.structuredContent;
  if (typeof content === 'string') {
    try {
      content = JSON.parse(content);
    } catch {
      return undefined;
    }
  }
  return isExplanation(content) ? content : undefined;
}

/** What the Bureau said when it would not explain: its message, and what to do next when it said. */
export interface Refusal {
  readonly message: string;
  readonly remediation: string | null;
}

/**
 * The refusal an error result carries: the Bureau's fault, as `message` and `remediation` in the
 * result's structured content, else the text of its content. `undefined` for a result that is not
 * an error, or an error with nothing to read.
 */
export function refusalOf(result: {
  readonly isError?: boolean | undefined;
  readonly structuredContent?: unknown;
  readonly content?: unknown;
}): Refusal | undefined {
  if (result.isError !== true) return undefined;
  const fault = result.structuredContent;
  if (isRecord(fault) && typeof fault['message'] === 'string' && fault['message'] !== '') {
    const remediation = fault['remediation'];
    return {
      message: fault['message'],
      remediation: typeof remediation === 'string' && remediation !== '' ? remediation : null,
    };
  }
  const first = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = isRecord(first) ? first['text'] : undefined;
  return typeof text === 'string' && text !== '' ? { message: text, remediation: null } : undefined;
}

/** The run a page was opened for: the explain tool's `runId`, or the `taskId` a run's page passes. */
export function runIdOf(
  argumentsOfOpening: Record<string, unknown> | undefined,
): string | undefined {
  const named = argumentsOfOpening?.['runId'] ?? argumentsOfOpening?.['taskId'];
  return typeof named === 'string' && named !== '' ? named : undefined;
}
