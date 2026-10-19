import { describe, expect, it } from 'bun:test';

import * as weft from '../../index.ts';
import {
  UPGRADE_REFUSAL_REASON_PREFIX,
  WORKER_CONFLICT_REASONS,
} from './worker-conflict-reasons.ts';

describe('worker Conflict reasons', () => {
  it('pins the strings a client branches on', () => {
    expect(WORKER_CONFLICT_REASONS).toEqual({
      staleGeneration: 'stale-generation',
      versionNotReady: 'version-not-ready',
      versionReferenced: 'version-referenced',
      versionRouted: 'version-routed',
      overrideTokenRejected: 'override-token-rejected',
      workflowNotTerminal: 'workflow-not-terminal',
      noWorkerBinding: 'no-worker-binding',
      policyNotAutoUpgrade: 'policy-not-auto-upgrade',
      noRoutedDeployment: 'no-routed-deployment',
    });
    expect(UPGRADE_REFUSAL_REASON_PREFIX).toBe('upgrade-');
  });

  it('is exported from the package root for clients', () => {
    expect(weft.WORKER_CONFLICT_REASONS).toBe(WORKER_CONFLICT_REASONS);
    expect(weft.UPGRADE_REFUSAL_REASON_PREFIX).toBe(UPGRADE_REFUSAL_REASON_PREFIX);
  });
});
