import { type ToolPolicy, withActiveSkillToolPolicy } from '@lostgradient/operative';
import type { AnyToolbox, Tool, ToolCallInput, ToolExecutionResult } from 'armorer';

const toolPolicies = new WeakMap<object, () => ToolPolicy | undefined>();

/**
 * COR-1700 — records the live active-skill policy that narrows `toolbox`, so a tool added to it
 * later is narrowed by the same policy. Returns `toolbox`. A layer that gates a toolbox by the
 * active skills records the policy on what it returns; a layer that forgets leaves the tools
 * added afterwards outside the gate.
 */
export function recordToolPolicy<T extends AnyToolbox>(
  toolbox: T,
  policy: () => ToolPolicy | undefined,
): T {
  toolPolicies.set(toolbox, policy);
  return toolbox;
}

/** COR-1700 — the policy {@link recordToolPolicy} recorded for `toolbox`, if any. */
export function toolPolicyOf(toolbox: AnyToolbox): (() => ToolPolicy | undefined) | undefined {
  return toolPolicies.get(toolbox);
}

/**
 * COR-1700 — the same class as COR-321: a toolbox is not just the list of tools it holds. A host's
 * toolbox can carry behavior that lives on the toolbox itself, such as `withToolboxIdempotency`'s
 * cache, the active-skill gate, a default request context, and approval settings. A rebuild from
 * `toJSON()` configurations, which is what armorer's `combineToolboxes` does, keeps the tools and
 * silently drops all of that. Adding Bureau's own tools by rebuilding therefore turned a durable
 * Bureau's idempotency, skill narrowing, and request-context binding off.
 *
 * `withAddedTools` adds tools without rebuilding: it answers for the additions itself and hands
 * everything else, and every call to a tool `base` owns, to `base` untouched, so each wrapper the
 * base carries stays in force. `additions` is a plain toolbox that holds only the added tools. A
 * name both hold is `base`'s, so a host tool never loses its place to a Bureau tool. The listing
 * and conversion members (`tools`, `getTool`, `getAvailable`, `toJSON`, the provider formats) cover
 * both; `inspect()` is a debugging summary of `base` alone.
 */
export function withAddedTools(base: AnyToolbox, additions: AnyToolbox): AnyToolbox {
  const policy = toolPolicyOf(base);
  if (policy !== undefined) {
    // The active skills narrow the added tools exactly as they narrow the base's, and a run whose
    // skill policy cannot be verified is offered none of them.
    return recordToolPolicy(
      composeAddedTools(base, withActiveSkillToolPolicy(additions, policy)),
      policy,
    );
  }
  return composeAddedTools(base, additions);
}

function composeAddedTools(base: AnyToolbox, additions: AnyToolbox): AnyToolbox {
  const ownedByBase = (name: string): boolean => base.getTool(name) !== undefined;
  const addedTools = (): readonly Tool[] =>
    additions.tools().filter((tool) => !ownedByBase(tool.name));
  const isAdded = (call: ToolCallInput): boolean =>
    !ownedByBase(call.name) && additions.getTool(call.name) !== undefined;

  /** A batch with calls for both: one batch for `base`, one call per addition, in call order. */
  const executeMixed = async (
    batch: ToolCallInput[],
    options: Parameters<AnyToolbox['execute']>[1],
  ): Promise<ToolExecutionResult[]> => {
    // The caller owns the array and may reuse it once this yields, so read a copy after the await.
    const input = [...batch];
    const baseResults = await base.execute(
      input.filter((call) => !isAdded(call)),
      options,
    );
    let nextBase = 0;
    return await Promise.all(
      input.map((call) =>
        isAdded(call)
          ? additions.execute(call, options)
          : Promise.resolve(baseResults[nextBase++]!),
      ),
    );
  };

  // Not `async`: a call that is all `base`'s or all additions' goes straight to the toolbox that
  // owns it, with no extra promise between the caller and the result. A run's park and its step
  // events are ordered by the ticks a tool call takes, so this adds none.
  const execute = (
    input: ToolCallInput | ToolCallInput[],
    options?: Parameters<AnyToolbox['execute']>[1],
  ): Promise<ToolExecutionResult | ToolExecutionResult[]> => {
    if (!Array.isArray(input)) {
      return isAdded(input) ? additions.execute(input, options) : base.execute(input, options);
    }
    const added = input.filter(isAdded).length;
    if (added === 0) return base.execute(input, options);
    if (added === input.length) {
      return Promise.all(input.map((call) => additions.execute(call, options)));
    }
    return executeMixed(input, options);
  };

  const concatenated = async <T>(read: (toolbox: AnyToolbox) => Promise<T[]>): Promise<T[]> => [
    ...(await read(base)),
    ...(await read(additions)),
  ];

  return new Proxy(base, {
    get(target, property, receiver) {
      switch (property) {
        case 'tools':
          return () => [...target.tools(), ...addedTools()];
        case 'getTool':
          return (nameOrId: string) => target.getTool(nameOrId) ?? additions.getTool(nameOrId);
        case 'getAvailable':
          return async () => [...(await target.getAvailable()), ...addedTools()];
        case 'getMissingTools':
          return (names: string[]) =>
            names.filter(
              (name) => target.getTool(name) === undefined && additions.getTool(name) === undefined,
            );
        case 'hasAllTools':
          return (names: string[]) =>
            names.every(
              (name) => target.getTool(name) !== undefined || additions.getTool(name) !== undefined,
            );
        case 'execute':
          return execute;
        case 'extend':
          // `extend()` clones the base, and a clone that forgot the additions would lose them.
          return (...entries: unknown[]) =>
            withAddedTools(
              (target.extend as (...arguments_: unknown[]) => AnyToolbox).apply(target, entries),
              additions,
            );
        case 'toJSON':
          return (options?: { format: 'configuration' | 'json-schema' }) => {
            const own = (target.toJSON as (options?: unknown) => unknown)(options);
            const added = (additions.toJSON as (options?: unknown) => unknown)(options);
            return Array.isArray(own) && Array.isArray(added) ? [...own, ...added] : own;
          };
        case 'toOpenAITools':
          return () => concatenated((toolbox) => toolbox.toOpenAITools());
        case 'toAnthropicTools':
          return () => concatenated((toolbox) => toolbox.toAnthropicTools());
        case 'toGeminiTools':
          return () => concatenated((toolbox) => toolbox.toGeminiTools());
        case 'toProvider':
          return (...arguments_: Parameters<AnyToolbox['toProvider']>) =>
            concatenated((toolbox) => toolbox.toProvider(...arguments_) as Promise<unknown[]>);
        default:
          return Reflect.get(target, property, receiver) as unknown;
      }
    },
  });
}
