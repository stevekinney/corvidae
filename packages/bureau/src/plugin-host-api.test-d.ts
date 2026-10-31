// Type-level tripwire (COR-1878): `@lostgradient/interborough-plugin` cannot import Bureau, so
// `PluginHostApi` is a structural slice of it. If this file stops compiling, a Bureau change broke
// the slice a plugin's `afterStart` relies on: `agents.list`, `schedules.list`, `schedules.create`
// or `goals.create`.

import type { PluginHostApi } from '@lostgradient/interborough-plugin';

import type { AgentDefinitions } from './agent-catalog.ts';
import type { Bureau } from './types.ts';

declare const bureau: Bureau;
declare const typedBureau: Bureau<{ writer: AgentDefinitions[string] }>;

export const hostApi: PluginHostApi = bureau;
export const typedHostApi: PluginHostApi = typedBureau;
