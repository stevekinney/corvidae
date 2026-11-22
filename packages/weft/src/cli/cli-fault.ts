/**
 * The structured failure every server-facing and schedule CLI command reports: the same fields as
 * a fault on the wire (`code`, `message`, `retryable`, `remediation`), so an agent that reads
 * `weft workflow ... --json` gets a code and a next step instead of prose.
 *
 * @module cli/cli-fault
 */

import { isFaultCode, type FaultCode } from '@lostgradient/backchannel';
import { FAULT_CODE_RETRYABLE, remediationProblem } from '@lostgradient/backchannel/internals';
import { weftFaultPolicy } from '../server/weft-fault-policy.ts';
import { prettyJson } from './output.ts';
import type { CommandOutput } from './types.ts';

/** What a failed command reports: a fault code, a message, whether a retry can help, and the next step. */
export type CliFault = {
  /** The server's {@link FaultCode}, or the code of the same meaning for a failure the CLI found itself. */
  readonly code: FaultCode;
  readonly message: string;
  /** Whether repeating the identical command later can succeed. */
  readonly retryable: boolean;
  /** One line saying what to do next, when there is something to say. */
  readonly remediation?: string;
};

/** A fault of `code`, with `retryable` from the code's single table in the operation layer. */
export function cliFault(code: FaultCode, message: string, remediation?: string): CliFault {
  return {
    code,
    message,
    retryable: FAULT_CODE_RETRYABLE[code],
    ...(remediation === undefined ? {} : { remediation }),
  };
}

/**
 * The fault a server's JSON-RPC `error` carries: `data.weftCode` is the coarse fault code, and
 * `data.retryable` and `data.remediation` the advice. A server that predates the fields (or an
 * answer that is not a fault at all) is read as `EngineFailure`, with `retryable` from the table.
 */
export function faultFromWireError(message: string, data: unknown): CliFault {
  const record = typeof data === 'object' && data !== null ? data : undefined;
  const weftCode: unknown = record === undefined ? undefined : Reflect.get(record, 'weftCode');
  const code: FaultCode = isFaultCode(weftCode) ? weftCode : 'EngineFailure';
  const retryable: unknown = record === undefined ? undefined : Reflect.get(record, 'retryable');
  const remediation: unknown =
    record === undefined ? undefined : Reflect.get(record, 'remediation');
  return {
    code,
    message,
    retryable: typeof retryable === 'boolean' ? retryable : FAULT_CODE_RETRYABLE[code],
    ...(typeof remediation === 'string' && remediationProblem(remediation) === undefined
      ? { remediation }
      : {}),
  };
}

/**
 * The fault of an error thrown by the embedded engine a local command runs: the code comes from
 * Weft's fault policy (`NotFound`, `Conflict`, `InvalidParams` for the engine's own classes) and
 * `EngineFailure` otherwise; the message is the error's own, because the operator who ran the
 * command is the one who reads it.
 */
export function faultFromLocalError(error: unknown): CliFault {
  const message = error instanceof Error ? error.message : String(error);
  return cliFault(weftFaultPolicy.classifyError?.(error)?.code ?? 'EngineFailure', message);
}

/**
 * Render a failed command. With `json`, stdout holds `{ ok: false, error }` and stderr stays empty,
 * as `weft api --json` does. Otherwise stderr holds the message (after `prefix`), then a `Try:`
 * line when the fault has a remediation. The exit code is the caller's, never derived here.
 */
export function renderFault(
  fault: CliFault,
  options: { readonly json: boolean; readonly exitCode: number; readonly prefix?: string },
): CommandOutput {
  if (options.json) {
    // Only the four fault fields: `fault` may be a larger object (a call result with its `kind`).
    const { code, message, retryable, remediation } = fault;
    const error = {
      code,
      message,
      retryable,
      ...(remediation === undefined ? {} : { remediation }),
    };
    return { stdout: prettyJson({ ok: false, error }), exitCode: options.exitCode };
  }
  const lines = [`${options.prefix ?? ''}${fault.message}`];
  if (fault.remediation !== undefined) lines.push(`Try: ${fault.remediation}`);
  return { stdout: '', stderr: lines.join('\n'), exitCode: options.exitCode };
}
