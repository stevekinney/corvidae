import { expect, test } from 'bun:test';
import { workspaceConformanceLedger } from './workspace-conformance-ledger.test-support.ts';
import { subscribeRequest } from './management/management-fixtures.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

// These are valid wire inputs. Every workspace user, including an administrator, must be
// refused before deployment state or a diagnostic count can be returned or changed.
const witnesses = workspaceConformanceLedger('workspace-deployment-privacy.test.ts');
const cases = [
  { operation: 'bureau.diagnostics.get', input: {} },
  { operation: 'bureau.workflows.internal.get', input: { id: 'agent-run' } },
  {
    operation: 'bureau.decisions.decide',
    input: {
      commandId: 'private-decision',
      kind: 'boolean',
      question: 'PRIVATE-DEPLOYMENT-QUESTION',
    },
  },
  { operation: 'bureau.deployments.get', input: { deploymentName: 'private-deployment' } },
  {
    operation: 'bureau.deployments.ramp',
    input: {
      deploymentName: 'private-deployment',
      buildId: 'private-build',
      rampBasisPoints: 100,
      expectedGeneration: 0,
    },
  },
  {
    operation: 'bureau.deployments.promote',
    input: { deploymentName: 'private-deployment', expectedGeneration: 0 },
  },
  {
    operation: 'bureau.deployments.rollback',
    input: { deploymentName: 'private-deployment', expectedGeneration: 0 },
  },
] as const;

for (const row of cases) {
  test(`${row.operation} refuses every workspace user despite legacy operator scopes`, async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
        const result = await workspacePrivacyCall(opened, actor, row.operation, row.input);
        witnesses.observeWire(row.operation, actor, result);
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else expect(result.body?.error?.data?.httpStatus).toBe(403);
        expect(result.text).not.toContain('PRIVATE-DEPLOYMENT-QUESTION');
      }
    } finally {
      await opened.dispose();
    }
  });
}

test('bureau.events refuses the deployment-wide event feed to every workspace user', async () => {
  const opened = await openWorkspacePrivacyBureau();
  try {
    for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
      const response = await opened.handler(
        subscribeRequest(
          'bureau.events',
          { bureauId: 'management-bureau' },
          WORKSPACE_PRIVACY_ACTORS[actor].key,
        ),
      );
      await witnesses.observeStream('bureau.events', actor, response);
      expect(response.status).toBe(403);
    }
  } finally {
    await opened.dispose();
  }
});

test('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
});
