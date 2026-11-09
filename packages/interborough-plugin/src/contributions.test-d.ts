// Type-level tripwire (COR-2130): a plugin that returns a contribution key by its old name fails
// type-checking, so a rename cannot be silently undone and a plugin written against the old
// contract is told at compile time. `PluginContributions` has no index signature, so an unknown key
// is an excess-property error.

import type { OperativeHookMap, OutputValidator, ToolCallValidator } from '@lostgradient/operative';
import type { InputDetector } from 'armorer';
import { z } from 'zod';

import type {
  PluginAgent,
  PluginContributions,
  PluginFormatter,
  PluginGuardrailFactory,
  PluginGuardrails,
  PluginInputGuardrail,
  PluginInterceptor,
  PluginMemoryGuardrail,
  PluginOutputGuardrail,
  PluginPanel,
  PluginReaction,
  PluginScorer,
  PluginToolGuardrail,
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
type InterceptorPoints = Exclude<keyof PluginInterceptor, 'name'>;

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

declare const detector: PluginInputGuardrail;
declare const validator: PluginOutputGuardrail;
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

declare const toolValidator: PluginToolGuardrail;

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

declare const bareDetector: InputDetector;
declare const bareValidator: OutputValidator;
declare const bareToolValidator: ToolCallValidator;

// COR-2118 — every guardrail a plugin contributes says what it guards.
// @ts-expect-error -- an input detector without a description
export const undescribedInput: PluginGuardrails = { input: [bareDetector] };

// @ts-expect-error -- an output validator without a description
export const undescribedOutput: PluginGuardrails = { output: [bareValidator] };

// @ts-expect-error -- a tool-call validator without a description
export const undescribedTool: PluginGuardrails = { tools: [bareToolValidator] };

// @ts-expect-error -- a memory guardrail without a description
export const undescribedMemory: PluginGuardrails = { memory: [bareDetector] };

// COR-2118 — a factory an agent configures joins any family but memory, bare or with an action.
const thresholdFactory: PluginGuardrailFactory<OutputValidator, { readonly threshold: number }> = {
  name: 'grounding',
  description: 'Flags claims the conversation does not support.',
  configuration: z.object({ threshold: z.number().default(0.8) }),
  create: ({ threshold }) => ({
    name: 'grounding',
    validate: () => Promise.resolve({ valid: threshold > 0, confidence: 1, category: 'x' }),
  }),
};

declare const detectorFactory: PluginGuardrailFactory<InputDetector>;
declare const toolFactory: PluginGuardrailFactory<ToolCallValidator>;

export const factories: PluginGuardrails = {
  input: [detectorFactory, { guardrail: detectorFactory, action: 'tripwire' }],
  output: [thresholdFactory, { guardrail: thresholdFactory, action: 'redact' }],
  tools: [toolFactory],
};

// @ts-expect-error -- a factory's description is required
export const undescribedFactory: PluginGuardrailFactory<InputDetector> = {
  name: 'x',
  configuration: z.object({}),
  create: () => bareDetector,
};

// @ts-expect-error -- memory guardrails guard the host, so no agent configures one
export const memoryFactory: PluginGuardrails = { memory: [detectorFactory] };
