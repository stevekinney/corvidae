/**
 * COR-2009 — Settings › A2A, Recent calls: each remote call that starts a task is kept as an
 * `a2a.call` audit record with when it came, who made it (the principal, and the name the caller
 * gave itself) and which agent answered, read back through `bureau.audit.query` like every other
 * record, so it pages, exports and expires with the audit trail.
 */
import { describe, expect, it } from 'bun:test';

import { A2A_CALL_AUDIT_TYPE, CALLER_NAME_METADATA_KEY } from './a2a-request-handler.ts';
import { answering, message, send, sendForTask, withA2A } from './a2a-mount.test-support.ts';

describe('an A2A call', () => {
  it('is recorded once per task it starts, naming the caller and the agent that answered', async () => {
    await withA2A(
      { assistant: answering('hi'), 'tool-runner': answering('done') },
      async (opened) => {
        const first = await sendForTask(opened, 'tool-runner', {
          message: message('Refund order 4471', {
            metadata: { [CALLER_NAME_METADATA_KEY]: ' planner ' },
          }),
        });
        const retried = message('Summarize', {
          metadata: { [CALLER_NAME_METADATA_KEY]: 'planner' },
        });
        const second = await sendForTask(opened, 'assistant', { message: retried });
        // An exact retry of the same send answers the same task and records no second call.
        const repeated = await sendForTask(opened, 'assistant', { message: retried });
        expect(repeated.id).toBe(second.id);
        const unnamed = await sendForTask(opened, 'assistant', { message: message('Hello') });

        const page = await opened.bureau.audit.query({ type: A2A_CALL_AUDIT_TYPE });
        expect(
          page.records.map((record) => ({
            resource: record.resource,
            principal: record.principal,
            detail: record.detail,
          })),
        ).toEqual([
          {
            resource: first.id,
            principal: 'api-key:alice',
            detail: { agentName: 'tool-runner', taskId: first.id, callerName: 'planner' },
          },
          {
            resource: second.id,
            principal: 'api-key:alice',
            detail: { agentName: 'assistant', taskId: second.id, callerName: 'planner' },
          },
          {
            resource: unnamed.id,
            principal: 'api-key:alice',
            detail: { agentName: 'assistant', taskId: unnamed.id },
          },
        ]);
        for (const record of page.records) expect(Date.parse(record.timestamp)).not.toBeNaN();
      },
    );
  });

  it('is not recorded for a send that starts no task', async () => {
    await withA2A({ assistant: answering('hi') }, async (opened) => {
      const refused = await send(opened, 'assistant', {
        message: { messageId: 'empty', role: 'ROLE_USER', parts: [] },
      });
      expect(refused.body.error).toBeDefined();
      const page = await opened.bureau.audit.query({ type: A2A_CALL_AUDIT_TYPE });
      expect(page.records).toEqual([]);
    });
  });
});
