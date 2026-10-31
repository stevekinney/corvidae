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
  string | ((call: ToolCall, index: number) => string | undefined) | undefined;

/** The refusal for `toolName`, shaped like Armorer's own policy denial. */
function refusalFor(call: ToolCallInput, toolName: string): ToolExecutionResult {
  const callId =
    call.id !== undefined && call.id.length > 0 ? call.id : createToolCall(toolName, {}).id;
  const message = `Tool "${toolName}" is not available: the active skills' allowed-tools exclude it.`;
  return {
    callId,
    outcome: 'error',
    content: message,
    toolCallId: callId,
    ...(call.providerCallId === undefined ? {} : { providerCallId: call.providerCallId }),
    toolName,
    result: undefined,
    error: { code: SKILL_TOOL_DENIED_CODE, category: 'permission', retryable: false, message },
    errorMessage: message,
    errorCategory: 'permission',
  };
}

/** The tools a call reaches: its name, and the ids of the one tool or every candidate. */
interface CallTarget {
  readonly name: string;
  readonly ids: readonly string[];
}

/**
 * The tools a call reaches in `target`: by name or id first (a `plugin__tool` name included),
 * then by Armorer's fuzzy resolution over every registered tool name, which a toolbox with
 * `resolution` enabled applies itself. `undefined` for a name nothing resolves to.
 */
function callTarget(
  target: AnyToolbox,
  registeredNames: readonly string[],
  name: string,
): CallTarget | undefined {
  const direct = registeredTargetOf(target, name);
  if (direct !== undefined) return direct;
  const resolved = resolveFuzzyToolName(name, [...registeredNames]).resolved;
  return resolved === null ? undefined : registeredTargetOf(target, resolved);
}

/**
 * The tools a reference points at, including when the toolbox will not run it. A name that several
 * tools share (two namespaces, or two versions) is ambiguous to the toolbox; the gate refuses it
 * only when every candidate is hidden, and otherwise leaves the ambiguity to the toolbox.
 */
function registeredTargetOf(target: AnyToolbox, reference: string): CallTarget | undefined {
  const resolution = target.resolveTool(reference);
  if (resolution.ok) return { name: resolution.tool.name, ids: [resolution.tool.id] };
  const [candidate] = resolution.candidates;
  const tool = candidate === undefined ? undefined : target.getTool(candidate);
  return tool === undefined ? undefined : { name: tool.name, ids: resolution.candidates };
}

/** Re-bases a function key's index onto the original batch, so a refusal never shifts a key. */
function rebasedKey(
  key: DurableOperationKey,
  originalIndices: readonly number[],
): DurableOperationKey {
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
  visibleTools: () => ReadonlyArray<{ readonly id: string }>,
): (callOrCalls: ToolCallInput | ToolCallInput[], options?: ExecuteOptions) => Promise<unknown> {
  return async (callOrCalls, options) => {
    // By id, so a skill that allows `a:search` hides `b:search` though both are named `search`.
    const visible = new Set(visibleTools().map((tool) => tool.id));
    // Unique, as Armorer's own resolution runs over the keys of its name map: a name registered
    // under two versions or namespaces would otherwise be ambiguous here and pass through.
    const registered = [...new Set(target.tools().map((tool) => tool.name))];
    const calls = Array.isArray(callOrCalls) ? callOrCalls : [callOrCalls];

    const refusals = new Map<number, ToolExecutionResult>();
    calls.forEach((call, index) => {
      const reached = callTarget(target, registered, call.name);
      if (reached !== undefined && !reached.ids.some((id) => visible.has(id))) {
        refusals.set(index, refusalFor(call, reached.name));
      }
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
