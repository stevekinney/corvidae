// Type-level tripwire (COR-2136): a plugin written against the old descriptor and setup-result
// member names fails type-checking, so a rename cannot be silently undone.

import type { PluginDescriptor, PluginSetupContext, PluginSetupResult } from './index.ts';

const base = { name: 'x', title: 'X', version: '1.0.0', description: 'x' } as const;

export const renamed: PluginDescriptor = { ...base, enabled: false };

export const staleEnabledByDefault: PluginDescriptor = {
  ...base,
  // @ts-expect-error -- `enabledByDefault` was renamed `enabled`
  enabledByDefault: false,
};

export const renamedStart: PluginSetupResult = { start: () => undefined };

// @ts-expect-error -- `afterStart` was renamed `start`
export const staleAfterStart: PluginSetupResult = { afterStart: () => undefined };

// COR-2180: a descriptor's `hooks` take the declared shape, and a stale or malformed one fails.
export const withHooks: PluginDescriptor = {
  ...base,
  hooks: [
    {
      name: 'Post settled runs',
      events: ['run.settled'],
      reaction: 'post-message',
      configuration: { channel: 'ops' },
      scope: { kind: 'agent', id: 'writer' },
    },
    { name: 'Post started runs', events: ['run.started'], reaction: 'post-message' },
  ],
};

export const hookWithoutReaction: PluginDescriptor = {
  ...base,
  // @ts-expect-error -- a hook names the reaction it runs
  hooks: [{ name: 'Post', events: ['run.settled'] }],
};

export const hookWithoutEvents: PluginDescriptor = {
  ...base,
  // @ts-expect-error -- a hook lists the events it fires on
  hooks: [{ name: 'Post', reaction: 'post-message' }],
};

export const hookWithUnknownScopeKind: PluginDescriptor = {
  ...base,
  hooks: [
    {
      name: 'Post',
      events: ['run.settled'],
      reaction: 'post-message',
      // @ts-expect-error -- a hook is scoped to an agent, a workflow or a schedule
      scope: { kind: 'planet', id: 'earth' },
    },
  ],
};

export const readApprovals = (context: PluginSetupContext) => context.approvals;

// @ts-expect-error -- `toolApprovalHooks` was renamed `approvals`
export const staleApprovals = (context: PluginSetupContext) => context.toolApprovalHooks;
