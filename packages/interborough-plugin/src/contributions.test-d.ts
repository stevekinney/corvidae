// Type-level tripwire (COR-2130): a plugin that returns a contribution key by its old name fails
// type-checking, so a rename cannot be silently undone and a plugin written against the old
// contract is told at compile time. `PluginContributions` has no index signature, so an unknown key
// is an excess-property error.

import type { OperativeHookMap, OutputValidator, ToolCallValidator } from '@lostgradient/operative';
import type { InputDetector } from 'armorer';

import type {
  PluginAgent,
  PluginContributions,
  PluginFormatter,
  PluginGuardrails,
  PluginInterceptor,
  PluginMemoryGuardrail,
  PluginPanel,
  PluginReaction,
  PluginScorer,
  PluginTrigger,
} from './index.ts';

declare const trigger: PluginTrigger;

// The new key is accepted.
export const renamed: PluginContributions = { triggers: [trigger] };

// @ts-expect-error -- `triggerKinds` was renamed `triggers`
export const staleTriggerKinds: PluginContributions = { triggerKinds: [trigger] };

declare const reaction: PluginReaction;

export const renamedReactions: PluginContributions = { reactions: [reaction] };

// @ts-expect-error -- `hookActionKinds` was renamed `reactions`
export const staleHookActionKinds: PluginContributions = { hookActionKinds: [reaction] };

declare const scorer: PluginScorer;

export const renamedScorers: PluginContributions = { scorers: [scorer] };

// @ts-expect-error -- `evalJudges` was renamed `scorers`
export const staleEvalJudges: PluginContributions = { evalJudges: [scorer] };

declare const panel: PluginPanel;

export const renamedPanels: PluginContributions = { panels: [panel] };

// @ts-expect-error -- `mcpApps` was renamed `panels`
export const staleMcpApps: PluginContributions = { mcpApps: [panel] };

declare const formatter: PluginFormatter;

export const renamedFormatters: PluginContributions = { formatters: [formatter] };

// @ts-expect-error -- `eventFormatters` was renamed `formatters`
export const staleEventFormatters: PluginContributions = { eventFormatters: [formatter] };

declare const agent: PluginAgent;

export const renamedAgents: PluginContributions = { agents: [agent] };

// @ts-expect-error -- `codeAgents` was renamed `agents`
export const staleCodeAgents: PluginContributions = { codeAgents: [agent] };

// Type-level tripwire (COR-2125): `PluginInterceptor` has one member for every point of Operative's
// hook map and no other, so a point added to the map cannot be left out of the contract again.
// `OperativeHookMap` inherits an index signature from `HookMap`, which makes `keyof` of it
// `string | number`; the mapped type below keeps only the keys it declares.
type DeclaredHookPoints = keyof {
  [
    K in keyof OperativeHookMap as string extends K ? never : number extends K ? never : K
  ]: OperativeHookMap[K];
};
type InterceptorPoints = Exclude<keyof PluginInterceptor, 'name' | 'appliesTo'>;

/** Resolves to `true` only when `A` and `B` are the same union of keys. */
type SameKeys<A extends PropertyKey, B extends PropertyKey> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : { missingFromFirst: Exclude<B, A> }
  : { missingFromSecond: Exclude<A, B> };

export const everyHookPointIsExposed: SameKeys<InterceptorPoints, DeclaredHookPoints> = true;

// The control: the comparison fails for a map that has a key the interceptor lacks.
type PointsWithANewOne = DeclaredHookPoints | 'extraPoint';
// @ts-expect-error -- `extraPoint` is not a member of `PluginInterceptor`
export const aMissingPointIsCaught: SameKeys<InterceptorPoints, PointsWithANewOne> = true;

// COR-2127 — an interceptor applies to the agents that list it, or to every agent.
export const everyAgentInterceptor: PluginInterceptor = { name: 'audit', appliesTo: 'every-agent' };
// @ts-expect-error -- `appliesTo` names no other scope
export const unknownScope: PluginInterceptor = { name: 'audit', appliesTo: 'some-agents' };

declare const detector: InputDetector;
declare const validator: OutputValidator;
declare const memoryGuardrail: PluginMemoryGuardrail;

export const renamedGuardrails: PluginContributions = {
  guardrails: { input: [detector], output: [validator], memory: [memoryGuardrail] },
};

// A memory guardrail's gates are admission, recall or both, and an input detector is a memory
// guardrail that declares none.
export const gatedMemory: PluginGuardrails = {
  memory: [
    detector,
    { ...detector, gates: ['recall'] },
    { ...detector, gates: ['admission', 'recall'] },
  ],
};

// @ts-expect-error -- `inputDetectors` was renamed `guardrails.input`
export const staleInputDetectors: PluginGuardrails = { inputDetectors: [detector] };

// @ts-expect-error -- `outputValidators` was renamed `guardrails.output`
export const staleOutputValidators: PluginGuardrails = { outputValidators: [validator] };

// @ts-expect-error -- `memoryDetectors` moved to `guardrails.memory`
export const staleMemoryDetectors: PluginContributions = { memoryDetectors: [detector] };

// @ts-expect-error -- a memory gate is `admission` or `recall`
export const unknownGate: PluginGuardrails = { memory: [{ ...detector, gates: ['write'] }] };

declare const toolValidator: ToolCallValidator;

// COR-2104 — a tool-call validator joins `guardrails.tools`, and an input or output entry may carry
// an action of its own.
export const withActions: PluginGuardrails = {
  input: [detector, { guardrail: detector, action: 'warn' }, { guardrail: detector }],
  output: [validator, { guardrail: validator, action: 'redact' }],
  tools: [toolValidator, { ...toolValidator, action: 'tripwire' }],
};

// @ts-expect-error -- `redact` is an output action, not an input one
export const inputRedact: PluginGuardrails = { input: [{ guardrail: detector, action: 'redact' }] };

export const outputSanitize: PluginGuardrails = {
  // @ts-expect-error -- `sanitize` is an input action, not an output one
  output: [{ guardrail: validator, action: 'sanitize' }],
};

// @ts-expect-error -- a tool-call validator's action is `block`, `warn` or `tripwire`
export const toolRedact: PluginGuardrails = { tools: [{ ...toolValidator, action: 'redact' }] };
