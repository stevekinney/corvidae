/**
 * COR-2299 — the tool-result scan for a result that does not pass through the run loop.
 *
 * The run loop scans each result with the run's `validateToolResult` hooks before the model sees
 * it. An approved call Bureau runs after the run parked, and a durable child wait's answer, reach
 * the conversation without that step: the host runs this instead, with the run's own hook plan, so
 * the same detectors give the same block, warn and tripwire outcomes.
 */
import type { HookRegistry } from '@lostgradient/lifecycle';
import type { ToolExecutionResult } from 'armorer';
import { materializeToolResultAsync } from 'armorer/protocol';
import type { Conversation } from 'conversationalist';

import { GuardrailTripwireError } from '../errors';
import type { OperativeHookMap } from '../hooks';
import type { GuardrailFiring } from '../types';
import {
  GUARDRAIL_BLOCKED_CODE,
  guardrailBlockedMessage,
  guardrailBlockedResult,
} from './tool-result-guardrail';

/** What {@link scanToolResult} needs of the run. */
export interface ScanToolResultOptions {
  /** The run's hook plan. A plan with no `validateToolResult` handler scans nothing. */
  readonly hooks: Pick<HookRegistry<OperativeHookMap>, 'has' | 'run'> | undefined;
  /** The run's conversation, as the in-loop scan sees it. */
  readonly conversation: Conversation;
  /** The step the result belongs to. */
  readonly step: number;
  /** Told of a guardrail that acted while the result was let through (a warning). */
  readonly reportGuardrail?: ((firing: GuardrailFiring) => void) | undefined;
}

/** What {@link scanToolResult} decided. */
export interface ScannedToolResult {
  /** The result to write: the original, or the one the guardrail replaced it with. */
  readonly result: ToolExecutionResult;
  /** Whether a guardrail refused the result, or the scan failed and withheld it. */
  readonly blocked: boolean;
  /** The tripwire a guardrail raised; the result is withheld, as in the loop. */
  readonly tripwire?: GuardrailTripwireError | undefined;
}

/** The message of a result withheld because the scan itself failed. */
export const SCAN_FAILED_MESSAGE = 'Tool result blocked: the guardrail scan failed.';

function isAsyncIterable(value: unknown): boolean {
  return (
    value !== null &&
    (typeof value === 'object' || typeof value === 'function') &&
    Symbol.asyncIterator in value
  );
}

/** Whether `result` carries a stream that has not been read into its content yet. */
function carriesStream(result: ToolExecutionResult): boolean {
  const candidate = result as { stream?: unknown; result?: unknown };
  return candidate.stream !== undefined || isAsyncIterable(candidate.result);
}

/**
 * Reads a streamed result into its content, so what a guardrail scans is what the model will be
 * shown, not the `'[stream]'` placeholder. A result with no stream is returned as it is.
 */
export async function collectStreamedToolResult(
  result: ToolExecutionResult,
  signal?: AbortSignal,
): Promise<ToolExecutionResult> {
  if (!carriesStream(result)) return result;
  const collected = await materializeToolResultAsync(result, { signal });
  const { stream: _stream, ...rest } = result as ToolExecutionResult & { stream?: unknown };
  return {
    ...rest,
    content: collected.content,
    result: collected.content,
    ...(collected.parts === undefined ? {} : { parts: collected.parts }),
  };
}

/**
 * Scans one result with the run's `validateToolResult` hooks, as the run loop does. A streamed
 * result is collected first. A tripwire withholds the result and is returned, for the host to
 * decide what it stops; a scan that fails for any other reason withholds the result too, so a
 * result no guardrail could read is never shown (COR-2300).
 */
export async function scanToolResult(
  input: ToolExecutionResult,
  options: ScanToolResultOptions,
): Promise<ScannedToolResult> {
  const { hooks } = options;
  if (hooks === undefined || !hooks.has('validateToolResult')) {
    return { result: input, blocked: false };
  }
  let result = input;
  try {
    result = await collectStreamedToolResult(input);
    const validated = await hooks.run('validateToolResult', result, {
      conversation: options.conversation,
      step: options.step,
      toolCalls: [],
      results: [result],
      ...(options.reportGuardrail === undefined
        ? {}
        : { reportGuardrail: options.reportGuardrail }),
    });
    if (validated === undefined || validated === result) return { result, blocked: false };
    return { result: validated, blocked: validated.error?.code === GUARDRAIL_BLOCKED_CODE };
  } catch (error) {
    if (error instanceof GuardrailTripwireError) {
      return {
        result: guardrailBlockedResult(result, guardrailBlockedMessage(error.guardrailName)),
        blocked: true,
        tripwire: error,
      };
    }
    return { result: guardrailBlockedResult(result, SCAN_FAILED_MESSAGE), blocked: true };
  }
}
