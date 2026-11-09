// Type-level tripwire (COR-2130): a plugin that returns a contribution key by its old name fails
// type-checking, so a rename cannot be silently undone and a plugin written against the old
// contract is told at compile time. `PluginContributions` has no index signature, so an unknown key
// is an excess-property error.

import type { OutputValidator } from '@lostgradient/operative';
import type { InputDetector } from 'armorer';

import type {
  PluginAgent,
  PluginContributions,
  PluginFormatter,
  PluginGuardrails,
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
