// Type-level tripwire (COR-2130): a plugin that returns a contribution key by its old name fails
// type-checking, so a rename cannot be silently undone and a plugin written against the old
// contract is told at compile time. `PluginContributions` has no index signature, so an unknown key
// is an excess-property error.

import type { OperativeHookMap } from '@lostgradient/operative';

import type {
  PluginAgent,
  PluginContributions,
  PluginFormatter,
  PluginInterceptor,
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
