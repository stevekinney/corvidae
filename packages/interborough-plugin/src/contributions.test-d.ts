// Type-level tripwire (COR-2130): a plugin that returns a contribution key by its old name fails
// type-checking, so a rename cannot be silently undone and a plugin written against the old
// contract is told at compile time. `PluginContributions` has no index signature, so an unknown key
// is an excess-property error.

import type {
  PluginContributions,
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
