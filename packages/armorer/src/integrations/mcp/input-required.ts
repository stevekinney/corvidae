import {
  createRequestStateCodec,
  inputRequired,
  inputResponse,
  type CallToolResult,
  type InputRequest,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';

import type { ToolElicitationRequest, ToolElicitationResult } from '../../is-tool';
import { fromElicitResult, toElicitationInputRequest } from './elicitation';

/**
 * Multi-round tool input for protocol revision 2026-07-28 (MRTR).
 *
 * That revision has no server-to-client request channel: a handler that needs
 * input returns an `input_required` result and the client retries the call
 * with the answers. Armorer tools ask for input mid-execution
 * (`await context.elicit(...)`), so re-running the tool on every retry would
 * repeat whatever it did before asking. Instead the execution is suspended
 * in process: the first round returns `input_required` while the tool keeps
 * waiting on `elicit`, and the retry hands the answer to that same waiting
 * execution. The tool body runs exactly once.
 *
 * The retry is matched by a `requestState` HMAC-sealed with a per-instance
 * key (bound to the tool name, the round, and the authenticated client when
 * there is one). Each round can be claimed once: a duplicate or stale retry
 * finds nothing to resume and gets an error result without touching the
 * execution. A round that is never answered expires after `ttlMs`, which
 * aborts the execution. Because the execution lives in memory, every round
 * of a flow must reach the same process.
 */

/** The `inputRequests` key Armorer uses for a suspended execution's elicitation. */
export const MCP_ELICITATION_INPUT_KEY = 'elicitation';

/** Default lifetime of an unanswered input round. */
export const DEFAULT_MCP_INPUT_ROUND_TTL_MS = 10 * 60 * 1000;

type ResumeState = { e: string; r: number; t: string };

type PendingInput = {
  readonly request: ToolElicitationRequest;
  readonly inputRequest: InputRequest;
  readonly resolve: (result: ToolElicitationResult) => void;
  readonly reject: (error: unknown) => void;
  surfaced: boolean;
};

export type RoundOutcome =
  { kind: 'complete'; result: CallToolResult } | { kind: 'input'; pending: PendingInput };

/**
 * One tool execution that can wait for client input across request rounds.
 * `requestInput` is the tool's `context.elicit`; `nextOutcome` races the
 * execution's completion against its next input request.
 */
export type SuspendableExecution = {
  readonly id: string;
  readonly toolName: string;
  /** Number of input rounds issued so far; a retry must name the current one. */
  round: number;
  requestInput(request: ToolElicitationRequest): Promise<ToolElicitationResult>;
  nextOutcome(): Promise<RoundOutcome>;
  answer(read: () => ToolElicitationResult): void;
  pendingInput(): PendingInput | undefined;
  expire(reason: Error): void;
};

export function createSuspendableExecution(options: {
  id: string;
  toolName: string;
  signal: AbortSignal;
  abort: (reason: unknown) => void;
  completion: () => Promise<CallToolResult>;
}): SuspendableExecution {
  let pending: PendingInput | undefined;
  let notifyInput: ((pending: PendingInput) => void) | undefined;
  let completion: Promise<CallToolResult> | undefined;

  const rejectPending = (reason: unknown) => {
    const current = pending;
    pending = undefined;
    current?.reject(reason);
  };
  options.signal.addEventListener('abort', () => rejectPending(options.signal.reason), {
    once: true,
  });

  const execution: SuspendableExecution = {
    id: options.id,
    toolName: options.toolName,
    round: 0,
    requestInput(request) {
      if (options.signal.aborted) return Promise.reject(options.signal.reason);
      if (pending) {
        return Promise.reject(
          new Error('An MCP tool can wait for only one elicitation at a time on 2026-07-28.'),
        );
      }
      // Build the embedded request now so a schema the 2026-07-28 wire
      // cannot express fails this `elicit` call rather than the round.
      const inputRequest = toElicitationInputRequest(request);
      return new Promise<ToolElicitationResult>((resolve, reject) => {
        const next: PendingInput = { request, inputRequest, resolve, reject, surfaced: false };
        pending = next;
        notifyInput?.(next);
      });
    },
    nextOutcome() {
      completion ??= options.completion();
      if (pending && !pending.surfaced) {
        pending.surfaced = true;
        return Promise.resolve({ kind: 'input', pending });
      }
      const input = new Promise<RoundOutcome>((resolve) => {
        notifyInput = (next) => {
          notifyInput = undefined;
          next.surfaced = true;
          resolve({ kind: 'input', pending: next });
        };
      });
      const complete = completion.then((result): RoundOutcome => ({ kind: 'complete', result }));
      return Promise.race([complete, input]);
    },
    answer(read) {
      const current = pending;
      if (!current) return;
      pending = undefined;
      try {
        current.resolve(read());
      } catch (error) {
        current.reject(error);
      }
    },
    pendingInput: () => pending,
    expire(reason) {
      rejectPending(reason);
      options.abort(reason);
    },
  };
  return execution;
}

export type InputRoundRegistryOptions = {
  /** How long an unanswered input round stays resumable. Defaults to ten minutes. */
  ttlMs?: number;
};

/**
 * Holds the executions suspended behind an `input_required` result for one
 * `createMCP` instance, and the codec that seals their `requestState`.
 */
export function createInputRoundRegistry(options: InputRoundRegistryOptions = {}) {
  const ttlMs = options.ttlMs ?? DEFAULT_MCP_INPUT_ROUND_TTL_MS;
  const codec = createRequestStateCodec<ResumeState>({
    key: globalThis.crypto.getRandomValues(new Uint8Array(32)),
    ttlSeconds: Math.max(1, Math.ceil(ttlMs / 1000)),
    bind: (context) => context.http?.authInfo?.clientId ?? '',
  });
  const suspended = new Map<
    string,
    { execution: SuspendableExecution; timer: ReturnType<typeof setTimeout> }
  >();

  const release = (id: string) => {
    const entry = suspended.get(id);
    if (!entry) return undefined;
    clearTimeout(entry.timer);
    suspended.delete(id);
    return entry.execution;
  };

  return {
    /** The verify hook every server instance installs as `requestState.verify`. */
    verify: (...args: Parameters<typeof codec.verify>) => codec.verify(...args),
    /** Number of executions currently waiting for an answer. */
    get size() {
      return suspended.size;
    },
    /** Parks an execution behind its current round and returns the `input_required` result. */
    async suspend(
      execution: SuspendableExecution,
      context: ServerContext,
    ): Promise<InputRequiredResult> {
      const pending = execution.pendingInput();
      if (!pending) {
        throw new Error('Cannot suspend an MCP tool execution that is not waiting for input.');
      }
      release(execution.id);
      const timer = setTimeout(() => {
        if (release(execution.id)) {
          execution.expire(new Error('The MCP input round expired before the client answered.'));
        }
      }, ttlMs);
      (timer as { unref?: () => void }).unref?.();
      suspended.set(execution.id, { execution, timer });
      return inputRequired({
        inputRequests: { [MCP_ELICITATION_INPUT_KEY]: pending.inputRequest },
        requestState: await codec.mint(
          { e: execution.id, r: execution.round, t: execution.toolName },
          context,
        ),
      });
    },
    /**
     * Claims the execution a retry resumes. Returns `undefined` when the
     * round is unknown, expired, already claimed, stale, or minted for
     * another tool; the caller answers with an error and nothing re-runs.
     */
    claim(toolName: string, state: unknown): SuspendableExecution | undefined {
      if (!isResumeState(state) || state.t !== toolName) return undefined;
      const entry = suspended.get(state.e);
      if (!entry || entry.execution.round !== state.r) return undefined;
      return release(state.e);
    },
    /** Drops an execution that finished (or was aborted) while parked. */
    forget(id: string) {
      release(id);
    },
    /** Expires every parked execution, for shutdown. */
    clear(reason: Error) {
      for (const id of suspended.keys()) {
        release(id)?.expire(reason);
      }
    },
  };
}

export type InputRoundRegistry = ReturnType<typeof createInputRoundRegistry>;

/**
 * Hands a retry's answer to the execution waiting for it. Returns `false`
 * when the retry carried no answer for the pending request, in which case
 * the caller re-issues the same round.
 */
export function deliverInputResponse(
  execution: SuspendableExecution,
  responses: Record<string, unknown> | undefined,
  key: string = MCP_ELICITATION_INPUT_KEY,
): boolean {
  const pending = execution.pendingInput();
  if (!pending) return true;
  const view = inputResponse(responses, key);
  if (view.kind === 'missing') return false;
  if (view.kind !== 'elicit') {
    execution.answer(() => {
      throw new TypeError(`Expected an elicitation response, received a ${view.kind} response.`);
    });
    return true;
  }
  const content = view.content;
  execution.answer(() =>
    fromElicitResult(
      { action: view.action, ...(content !== undefined ? { content } : {}) } as Parameters<
        typeof fromElicitResult
      >[0],
      pending.request,
    ),
  );
  return true;
}

function isResumeState(value: unknown): value is ResumeState {
  if (typeof value !== 'object' || value === null) return false;
  const state = value as Record<string, unknown>;
  return (
    typeof state['e'] === 'string' &&
    typeof state['r'] === 'number' &&
    typeof state['t'] === 'string'
  );
}
