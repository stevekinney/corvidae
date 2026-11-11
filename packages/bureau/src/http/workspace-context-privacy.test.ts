import { expect, test } from 'bun:test';
import { workspaceConformanceLedger } from './workspace-conformance-ledger.test-support.ts';
import { waitForCondition } from '../test';
import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './workspace-privacy-fixtures.test-support.ts';

const sentinel = 'PRIVATE-CONTEXT-HISTORY-b0ca';
const witnesses = workspaceConformanceLedger('workspace-context-privacy.test.ts');
const cases = [
  { operation: 'bureau.contexts.window', input: {} },
  { operation: 'bureau.contexts.rename', input: { title: sentinel } },
  { operation: 'bureau.contexts.delete', input: {} },
  { operation: 'bureau.contexts.retract', input: { inputId: 'private-input' } },
  { operation: 'bureau.contexts.forgetgrants', input: { tools: ['private-tool'] } },
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
  // COR-2296: the answer each actor is asked to regenerate is its context's one reply, named below.
  { operation: 'bureau.contexts.regenerate', input: { commandId: 'private-regenerate' } },
] as const;

/** The answer of a context's one-step task: the reply `bureau.contexts.regenerate` replaces. */
const answerOf = (taskId: string): string => `${taskId}:step:0`;

for (const row of cases) {
  test(`${row.operation} preserves context privacy for all six actors`, async () => {
    const opened = await openWorkspacePrivacyBureau(
      row.operation === 'bureau.contexts.input' || row.operation === 'bureau.contexts.retract'
        ? {}
        : { generate: async () => ({ content: sentinel, toolCalls: [] }) },
    );
    try {
      // Every mutation has its own settled context, keeping the authorization comparisons independent.
      for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
        const task = await opened.bureau.tasks.start('default', sentinel, {
          principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
        });
        if (
          row.operation !== 'bureau.contexts.input' &&
          row.operation !== 'bureau.contexts.retract'
        )
          await waitForCondition(
            () => opened.bureau.tasks.detail(task.id)?.status === 'completed',
            'context task finishes',
          );
        if (row.operation === 'bureau.contexts.regenerate')
          await waitForCondition(async () => {
            const record = await opened.bureau.internals.taskRegistry.record(task.id);
            const session = await opened.bureau.contexts.get(task.contextId);
            return (
              record?.settled !== undefined &&
              session?.conversationHistory.ids.at(-1) === answerOf(task.id)
            );
          }, 'the answer to regenerate is stored');
        if (row.operation === 'bureau.contexts.retract') {
          const queued = await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.input', {
            contextId: task.contextId,
            input: { id: `private-input-${actor}`, payload: sentinel },
          });
          expect(queued.body?.error).toBeUndefined();
        }
        if (row.operation === 'bureau.contexts.forgetgrants')
          await opened.bureau.internals.sessionStore!.update(task.contextId, (session) =>
            session === undefined
              ? undefined
              : { ...session, metadata: { ...session.metadata, approvalGrants: ['private-tool'] } },
          );
        const result = await workspacePrivacyCall(opened, actor, row.operation, {
          ...row.input,
          ...(row.operation === 'bureau.contexts.retract'
            ? { inputId: `private-input-${actor}` }
            : {}),
          ...(row.operation === 'bureau.contexts.regenerate'
            ? { messageId: answerOf(task.id) }
            : {}),
          contextId: task.contextId,
        });
        witnesses.observeWire(row.operation, actor, result);
        if (actor === 'foreign' || actor === 'removed') expect(result.status).toBe(403);
        else if (actor === 'owner') {
          expect(result.body?.error).toBeUndefined();
          if (row.operation === 'bureau.contexts.retract')
            expect(result.body?.result?.['outcome']).toBe('retracted');
          if (row.operation === 'bureau.contexts.forgetgrants')
            expect(result.body?.result?.['forgotten']).toEqual(['private-tool']);
        } else {
          expect(result.body?.error?.data?.httpStatus).toBe(404);
          const missing = await workspacePrivacyCall(opened, actor, row.operation, {
            ...row.input,
            ...(row.operation === 'bureau.contexts.retract'
              ? { inputId: `private-input-${actor}` }
              : {}),
            ...(row.operation === 'bureau.contexts.regenerate'
              ? { messageId: answerOf(task.id) }
              : {}),
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
          if (row.operation === 'bureau.contexts.forgetgrants') {
            const session = await opened.bureau.contexts.get(task.contextId);
            expect(session?.metadata['approvalGrants']).toEqual(['private-tool']);
          }
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
