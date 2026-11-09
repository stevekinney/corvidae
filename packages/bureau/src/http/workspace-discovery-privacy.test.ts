import { expect, test } from 'bun:test';
import { workspaceConformanceLedger } from './workspace-conformance-ledger.test-support.ts';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const witnesses = workspaceConformanceLedger('workspace-discovery-privacy.test.ts');
const cases = [
  { operation: 'weft.system.principal', input: {} },
  { operation: 'bureau.deployment.get', input: {} },
  { operation: 'bureau.events.catalog', input: {} },
  {
    operation: 'bureau.events.format',
    input: {
      events: [
        {
          kind: 'run.settled',
          bureauId: 'management-bureau',
          emittedAtMs: 1,
          payload: { runId: 'caller-provided-run' },
        },
      ],
    },
  },
  { operation: 'bureau.plugins.contributions', input: {} },
  { operation: 'bureau.skills.list', input: {} },
] as const;

for (const row of cases) {
  test(`${row.operation} exposes shared metadata without another actor's execution state`, async () => {
    const opened = await openWorkspacePrivacyBureau();
    try {
      const task = await opened.bureau.tasks.start('default', 'PRIVATE-DISCOVERY-INPUT-1bdd', {
        principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
      });
      const ownerContext = await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.get', {
        contextId: task.contextId,
      });
      expect(ownerContext.text).toContain('PRIVATE-DISCOVERY-INPUT-1bdd');
      if (row.operation !== 'weft.system.principal')
        witnesses.confirmPrivateSource(row.operation, ownerContext);
      for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
        const result = await workspacePrivacyCall(opened, actor, row.operation, row.input);
        witnesses.observeWire(row.operation, actor, result);
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else {
          expect(result.body?.error).toBeUndefined();
          expect(result.text).not.toContain(task.id);
          expect(result.text).not.toContain('PRIVATE-DISCOVERY-INPUT-1bdd');
          if (row.operation === 'weft.system.principal')
            expect(result.body?.result?.['workspace']).toMatchObject({
              owner: WORKSPACE_PRIVACY_ACTORS[actor].owner,
            });
        }
      }
    } finally {
      await opened.dispose();
    }
  });
}

test('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
});
