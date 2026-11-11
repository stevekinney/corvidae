// Type-level tripwire (COR-1878): `@lostgradient/interborough-plugin` cannot import Bureau, so
// `PluginHost` is a structural slice of it. If this file stops compiling, a Bureau change broke
// the slice a plugin's `start` relies on: `agents.list`, `schedules.list`, `schedules.create`
// or `goals.create`. `PluginHost` declares those calls as function-typed properties, so their
// parameters are checked strictly: a request type that gains a required field fails here.

import type { PluginHost } from '@lostgradient/interborough-plugin';

import type { Bureau } from './bureau-types/facade.ts';

declare const bureau: Bureau;

// The default `Bureau`, whose agent names are plain strings, is what a host hands a plugin. A
// `Bureau` typed with literal agent names narrows `agentName` and so is not a `PluginHost`.
export const hostApi: PluginHost = bureau;

// A host whose `goals.create` requires a field `PluginGoalRequest` lacks is not a `PluginHost`.
declare const strictGoals: Omit<PluginHost, 'goals'> & {
  goals: {
    create: (request: { agentName: string; requiredExtra: string }) => Promise<{ outcome: string }>;
  };
};
// @ts-expect-error -- a required request field the plugin cannot supply breaks the slice
export const strictGoalsHost: PluginHost = strictGoals;

// The same for `schedules.create`.
declare const strictSchedules: Omit<PluginHost, 'schedules'> & {
  schedules: Omit<PluginHost['schedules'], 'create'> & {
    create: (definition: {
      agentName: string;
      requiredExtra: string;
    }) => ReturnType<PluginHost['schedules']['create']>;
  };
};
// @ts-expect-error -- a required definition field the plugin cannot supply breaks the slice
export const strictSchedulesHost: PluginHost = strictSchedules;
