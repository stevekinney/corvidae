import { expect, test } from 'bun:test';
import { waitForCondition } from '../test';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const sentinel = 'PRIVATE-CONTEXT-HISTORY-b0ca';
const cases = [
  { operation: 'bureau.contexts.window', input: {} },
  { operation: 'bureau.contexts.rename', input: { title: 'renamed by caller' } },
  { operation: 'bureau.contexts.delete', input: {} },
  {
    operation: 'bureau.contexts.input',
    input: { input: { id: 'private-input', payload: 'new input' } },
  },
  {
    operation: 'bureau.contexts.steer',
    input: { commandId: 'private-steer', permissionMode: 'read-only' },
  },
  {
    operation: 'bureau.contexts.fork',
    input: { commandId: 'private-fork', throughMessageId: null },
  },
] as const;

for (const row of cases) {
  test(`${row.operation} preserves context privacy for all six actors`, async () => {
    const opened = await openWorkspacePrivacyBureau(
      row.operation === 'bureau.contexts.input'
        ? {}
        : { generate: async () => ({ content: sentinel, toolCalls: [] }) },
    );
    try {
      // Every mutation has its own settled context, keeping the authorization comparisons independent.
      for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
        const task = await opened.bureau.tasks.start('default', sentinel, {
          principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
        });
        if (row.operation !== 'bureau.contexts.input')
          await waitForCondition(
            () => opened.bureau.tasks.detail(task.id)?.status === 'completed',
            'context task finishes',
          );
        const result = await workspacePrivacyCall(opened, actor, row.operation, {
          ...row.input,
          contextId: task.contextId,
        });
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else if (actor === 'owner') expect(result.body?.error).toBeUndefined();
        else {
          expect(result.body?.error?.data?.httpStatus).toBe(404);
          const missing = await workspacePrivacyCall(opened, actor, row.operation, {
            ...row.input,
            contextId: 'unknown-context',
          });
          expect(JSON.stringify(result.body?.error).replaceAll(task.contextId, '<id>')).toBe(
            JSON.stringify(missing.body?.error).replaceAll('unknown-context', '<id>'),
          );
          expect(result.text).not.toContain(sentinel);
          const retained = await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.get', {
            contextId: task.contextId,
          });
          expect(retained.body?.error).toBeUndefined();
        }
      }
    } finally {
      await opened.dispose();
    }
  });
}
