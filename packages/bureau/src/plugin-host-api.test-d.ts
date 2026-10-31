// Type-level tripwire (COR-1878): `@lostgradient/interborough-plugin` cannot import Bureau, so
// `PluginHostApi` is a structural slice of it. If this file stops compiling, a Bureau change broke
// the slice a plugin's `afterStart` relies on: `agents.list`, `schedules.list`, `schedules.create`
// or `goals.create`. `PluginHostApi` declares those calls as function-typed properties, so their
// parameters are checked strictly: a request type that gains a required field fails here.

import type { PluginHostApi } from '@lostgradient/interborough-plugin';

import type { Bureau } from './types.ts';

declare const bureau: Bureau;

// The default `Bureau`, whose agent names are plain strings, is what a host hands a plugin. A
// `Bureau` typed with literal agent names narrows `agentName` and so is not a `PluginHostApi`.
export const hostApi: PluginHostApi = bureau;

// A host whose `goals.create` requires a field `PluginGoalRequest` lacks is not a `PluginHostApi`.
declare const strictGoals: Omit<PluginHostApi, 'goals'> & {
  goals: {
    create: (request: { agentName: string; requiredExtra: string }) => Promise<{ outcome: string }>;
  };
};
// @ts-expect-error -- a required request field the plugin cannot supply breaks the slice
export const strictGoalsHost: PluginHostApi = strictGoals;

// The same for `schedules.create`.
declare const strictSchedules: Omit<PluginHostApi, 'schedules'> & {
  schedules: Omit<PluginHostApi['schedules'], 'create'> & {
    create: (definition: {
      agentName: string;
      requiredExtra: string;
    }) => ReturnType<PluginHostApi['schedules']['create']>;
  };
};
// @ts-expect-error -- a required definition field the plugin cannot supply breaks the slice
export const strictSchedulesHost: PluginHostApi = strictSchedules;
