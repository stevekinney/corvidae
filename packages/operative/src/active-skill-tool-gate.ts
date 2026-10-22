/**
 * COR-1628 — the execution half of `withActiveSkillToolPolicy`.
 *
 * `tools()` hides what an active skill's `allowed-tools` excludes; this gate answers a call that
 * names such a tool with a refusal instead of running it. It judges a call by the same predicate
 * `tools()` applies, by reading the visible names off the proxy's own filtered `tools()` rather
 * than importing that predicate.
 */

import type { AnyToolbox, ToolExecutionResult } from 'armorer';
import { createToolCall, resolveFuzzyToolName } from 'armorer';
import type { ToolCall, ToolCallInput } from 'armorer/protocol';

/** The `ToolError.code` of a call the active skills' `allowed-tools` exclude. */
export const SKILL_TOOL_DENIED_CODE = 'SKILL_TOOL_DENIED';

type ExecuteOptions = { errorMode?: 'failFast' | 'collect'; [key: string]: unknown } | undefined;

type DurableOperationKey =
  | string
  | ((call: ToolCall, index: number) => string | undefined)
  | undefined;

/** The refusal for `toolName`, shaped like Armorer's own policy denial. */
function refusalFor(call: ToolCallInput, toolName: string): ToolExecutionResult {
  const callId = call.id !== undefined && call.id.length > 0 ? call.id : createToolCall(toolName).id;
  const message = `Tool "${toolName}" is not available: the active skills' allowed-tools exclude it.`;
  return {
    callId,
    outcome: 'error',
    content: message,
    toolCallId: callId,
    toolName,
    result: undefined,
    error: { code: SKILL_TOOL_DENIED_CODE, category: 'permission', retryable: false, message },
    errorMessage: message,
    errorCategory: 'permission',
  };
}

/**
 * The registered name a call reaches in `target`: by name or id first, then by Armorer's fuzzy
 * resolution over every registered tool name, which a toolbox with `resolution` enabled applies
 * itself. `undefined` for a name nothing resolves to.
 */
function canonicalName(
  target: AnyToolbox,
  registeredNames: readonly string[],
  name: string,
): string | undefined {
  const direct = target.getTool(name)?.name;
  if (direct !== undefined) return direct;
  const resolved = resolveFuzzyToolName(name, [...registeredNames]).resolved;
  return resolved === null ? undefined : target.getTool(resolved)?.name;
}

/** Re-bases a function key's index onto the original batch, so a refusal never shifts a key. */
function rebasedKey(key: DurableOperationKey, originalIndices: readonly number[]): DurableOperationKey {
  if (typeof key !== 'function') return key;
  return (call, index) => key(call, originalIndices[index] ?? index);
}

/**
 * Builds the gated `execute` of a toolbox proxy.
 *
 * `visibleNames` is read once per call to `execute`, so a batch runs under the policy the model was
 * shown when it generated the step. Allowed calls reach `execute` unchanged and in order, with
 * refused ones removed and their results merged back at their original positions. Under
 * `errorMode: 'failFast'` a refusal throws its `ToolError` before any call of the batch runs.
 */
export function createGatedExecute(
  target: AnyToolbox,
  execute: (calls: unknown, options?: unknown) => Promise<unknown>,
  visibleTools: () => ReadonlyArray<{ name: string }>,
): (callOrCalls: ToolCallInput | ToolCallInput[], options?: ExecuteOptions) => Promise<unknown> {
  return async (callOrCalls, options) => {
    const visible = new Set(visibleTools().map((tool) => tool.name));
    const registered = target.tools().map((tool) => tool.name);
    const calls = Array.isArray(callOrCalls) ? callOrCalls : [callOrCalls];

    const refusals = new Map<number, ToolExecutionResult>();
    calls.forEach((call, index) => {
      const name = canonicalName(target, registered, call.name);
      if (name !== undefined && !visible.has(name)) refusals.set(index, refusalFor(call, name));
    });
    if (refusals.size === 0) return execute(callOrCalls, options);

    if (options?.errorMode === 'failFast') throw refusals.values().next().value!.error;

    const allowedIndices = calls.flatMap((_call, index) => (refusals.has(index) ? [] : [index]));
    let executed: ToolExecutionResult[] = [];
    if (allowedIndices.length > 0) {
      const allowedOptions =
        options?.['durableOperationKey'] === undefined
          ? options
          : {
              ...options,
              durableOperationKey: rebasedKey(
                options['durableOperationKey'] as DurableOperationKey,
                allowedIndices,
              ),
            };
      const outcome = await execute(
        allowedIndices.map((index) => calls[index]!),
        allowedOptions,
      );
      executed = outcome as ToolExecutionResult[];
    }

    const results = calls.map((_call, index) => {
      const refusal = refusals.get(index);
      if (refusal !== undefined) return refusal;
      return executed[allowedIndices.indexOf(index)]!;
    });
    return Array.isArray(callOrCalls) ? results : results[0]!;
  };
}
