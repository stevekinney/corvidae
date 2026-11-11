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

export const readApprovals = (context: PluginSetupContext) => context.approvals;

// @ts-expect-error -- `toolApprovalHooks` was renamed `approvals`
export const staleApprovals = (context: PluginSetupContext) => context.toolApprovalHooks;
