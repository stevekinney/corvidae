import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import { faultForInputOutcome } from './contexts-input-operation.ts';
import {
  answering,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management-fixtures.test-support.ts';

async function withBureau<T>(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau(options);
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

/** A session whose run is still going, so it can take input. */
async function liveSession(opened: OpenedBureau, principal: string = OWNER.alice) {
  const run = await opened.bureau.createRun({ agentName: 'default', message: 'work', principal });
  await waitForCondition(
    () => opened.bureau.tasks.detail(run.id)?.status === 'running',
    'run started',
  );
  return run;
}

const send = (
  opened: OpenedBureau,
  contextId: string,
  key: string,
  input: { id: string; payload: unknown } = { id: 'input-1', payload: 'and one more thing' },
): Promise<RpcBody> => rpc(opened.handler, 'bureau.contexts.input', { contextId, input }, key);

describe('bureau.contexts.input', () => {
  it('admits an input to the caller’s own live context with steer delivery', async () => {
    await withBureau({}, async (opened) => {
      const run = await liveSession(opened);

      const body = await send(opened, run.sessionId, 'alice-key');

      expect(body.error).toBeUndefined();
      expect(body.result).toMatchObject({
        outcome: 'admitted',
        receipt: {
          id: 'input-1',
          sessionId: run.sessionId,
          deliveryMode: 'steer',
          state: 'accepted',
        },
      });
    });
  });

  it('answers an exact retry as a replay of the same input', async () => {
    await withBureau({}, async (opened) => {
      const run = await liveSession(opened);

      const first = await send(opened, run.sessionId, 'alice-key');
      const retry = await send(opened, run.sessionId, 'alice-key');

      expect(retry.result).toMatchObject({ outcome: 'replayed' });
      expect(retry.result?.['receipt']).toEqual(first.result?.['receipt']);
    });
  });

  it('answers a different input under a used id as a Conflict with reason input-conflict', async () => {
    await withBureau({}, async (opened) => {
      const run = await liveSession(opened);
      await send(opened, run.sessionId, 'alice-key');

      const body = await send(opened, run.sessionId, 'alice-key', {
        id: 'input-1',
        payload: 'something else',
      });

      expect(body.error?.data).toMatchObject({
        httpStatus: 409,
        weftCode: 'Conflict',
        reason: 'input-conflict',
      });
      expect(JSON.stringify(body)).not.toContain('originalReceipt');
    });
  });

  it('answers a context that has ended as a Conflict with reason session-terminal', async () => {
    await withBureau({ generate: answering() }, async (opened) => {
      const run = await opened.bureau.createRun({
        agentName: 'default',
        message: 'done soon',
        principal: OWNER.alice,
      });
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'completed',
        'finish',
      );

      const body = await send(opened, run.sessionId, 'alice-key');

      expect(body.error?.data).toMatchObject({
        httpStatus: 409,
        weftCode: 'Conflict',
        reason: 'session-terminal',
      });
    });
  });

  it('answers a payload no run could read as InvalidParams on the payload', async () => {
    await withBureau({}, async (opened) => {
      const run = await liveSession(opened);

      const body = await send(opened, run.sessionId, 'alice-key', {
        id: 'input-1',
        payload: [{ type: 'not-a-content-part' }],
      });

      expect(body.error?.data).toMatchObject({
        httpStatus: 400,
        issues: [{ path: ['input', 'payload'] }],
      });
    });
  });

  it('refuses an unknown key, so a caller cannot name a principal or a delivery mode', async () => {
    await withBureau({}, async (opened) => {
      const run = await liveSession(opened);

      const body = await rpc(
        opened.handler,
        'bureau.contexts.input',
        {
          contextId: run.sessionId,
          input: { id: 'input-1', payload: 'hi', principal: OWNER.bob, deliveryMode: 'queue' },
        },
        'alice-key',
      );

      expect(body.error?.data?.httpStatus).toBe(400);
    });
  });
});

describe('bureau.contexts.input access', () => {
  it('answers another owner’s context, an operator’s non-owned one, and a missing one alike', async () => {
    await withBureau({}, async (opened) => {
      const run = await liveSession(opened);

      const stranger = await send(opened, run.sessionId, 'bob-key');
      const operator = await send(opened, run.sessionId, 'contexts-writer-key');
      const wrongScope = await send(opened, run.sessionId, 'tasks-writer-key');
      const missing = await send(opened, 'no-such-context', 'bob-key');

      for (const body of [stranger, operator, wrongScope]) {
        expect(body.error?.data?.httpStatus).toBe(404);
        expect(JSON.stringify(body).replaceAll(run.sessionId, '<id>')).toBe(
          JSON.stringify(missing).replaceAll('no-such-context', '<id>'),
        );
      }
    });
  });

  it('admits nothing for a caller that is refused, and the owner’s next input is the first', async () => {
    await withBureau({}, async (opened) => {
      const run = await liveSession(opened);
      await send(opened, run.sessionId, 'bob-key');

      const owner = await send(opened, run.sessionId, 'alice-key');

      expect(owner.result).toMatchObject({
        outcome: 'admitted',
        receipt: { admissionSequence: 0 },
      });
    });
  });

  it('lets each principal send to its own context under the same input id', async () => {
    await withBureau({}, async (opened) => {
      const alice = await liveSession(opened, OWNER.alice);
      const bob = await liveSession(opened, OWNER.bob);

      const first = await send(opened, alice.sessionId, 'alice-key');
      const second = await send(opened, bob.sessionId, 'bob-key');

      expect(first.result).toMatchObject({ outcome: 'admitted' });
      expect(second.result).toMatchObject({ outcome: 'admitted' });
    });
  });
});

describe('the fault each remaining outcome answers with', () => {
  it('maps unsupported-capability and backlog-exhausted to named faults with a stable reason', () => {
    expect(
      faultForInputOutcome(
        { outcome: 'unsupported-capability', reason: 'durable-mailbox-unavailable' },
        'context-1',
      ),
    ).toMatchObject({
      code: 'Unavailable',
      data: { reason: 'unsupported-capability' },
    });
    expect(
      faultForInputOutcome(
        { outcome: 'backlog-exhausted', scope: 'session', limit: 8 },
        'context-1',
      ),
    ).toMatchObject({
      code: 'Unavailable',
      data: { reason: 'backlog-exhausted' },
    });
    expect(faultForInputOutcome({ outcome: 'not-found' }, 'context-1')).toMatchObject({
      code: 'NotFound',
      data: { resource: 'context', identifier: 'context-1' },
    });
  });
});
