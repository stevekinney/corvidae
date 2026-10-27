import type { GenerateFunction } from '@lostgradient/operative';
import { createOperationHandler, createOperationHandlerAuthenticator } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { waitForCondition } from '../../test';
import type { ResolveReviewInput } from '../../types.ts';
import { digestCommandPayload } from '../../command-ledger.ts';
import { BUREAU_SCOPES } from '../bureau-scopes.ts';
import {
  BUREAU_HANDLER_OPERATIONS,
  type BureauHandlerSource,
  buildBureauHandlerHost,
  createBureauHandler,
} from '../create-bureau-handler.ts';
import {
  approvalToolbox,
  authentication,
  chargesOnce,
  openBureau,
  type OpenedBureau,
  OWNER,
  rpc,
} from './management-fixtures.test-support.ts';
import { TASKS_RESPOND_OPERATION_VERSION } from './tasks-respond-operation.ts';

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

/** A model that parks the run on a human wait, then finishes once it is answered. */
function parksThenAnswers(signalName = 'human-response'): GenerateFunction {
  let calls = 0;
  return async () => {
    calls += 1;
    return calls === 1
      ? {
          content: '',
          toolCalls: [
            {
              id: 'wait-1',
              name: 'requestHumanInput',
              arguments: { signalName, prompt: 'Which?' },
            },
          ],
        }
      : { content: 'resolved', toolCalls: [] };
  };
}

async function parkedRun(opened: OpenedBureau, principal = OWNER.alice) {
  const run = await opened.bureau.tasks.start('default', 'park', { principal });
  await waitForCondition(
    () => opened.bureau.reviews.list().some((review) => review.runId === run.id),
    'the run never parked',
  );
  return run;
}

/** The same Bureau, with every `reviews.resolve` it receives recorded. */
function recording(opened: OpenedBureau) {
  const resolved: ResolveReviewInput[] = [];
  /** The resolutions the Bureau accepted: what was delivered to a run. */
  const delivered: ResolveReviewInput[] = [];
  const source = Object.create(opened.bureau, {
    reviews: {
      value: {
        ...opened.bureau.reviews,
        resolve: async (input: ResolveReviewInput) => {
          resolved.push(input);
          const result = await opened.bureau.reviews.resolve(input);
          delivered.push(input);
          return result;
        },
      },
    },
  }) as BureauHandlerSource;
  return { resolved, delivered, handler: createBureauHandler(source, { authentication }) };
}

async function parkedApproval(opened: OpenedBureau, principal = OWNER.alice) {
  const run = await opened.bureau.tasks.start('default', 'charge', { principal });
  await waitForCondition(
    () => opened.bureau.reviews.list().some((review) => review.runId === run.id),
    'the approval never became pending',
  );
  return run;
}

describe('bureau.tasks.respond answering a human wait', () => {
  it('answers with text, delivered to the run as the signal payload, and the run finishes', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);
      const { resolved, handler } = recording(opened);

      const body = await rpc(
        handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: 'the human said so' },
        'alice-key',
      );

      expect(body.result).toMatchObject({
        taskId: run.id,
        messageId: 'm1',
        kind: 'human-wait',
        decision: 'approve',
        receipt: 'applied',
      });
      expect(resolved).toHaveLength(1);
      expect(resolved[0]).toMatchObject({
        decision: 'approve',
        principal: OWNER.alice,
        payload: 'the human said so',
      });
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'completed',
        'finish',
      );
    });
  });

  it('joins the parts of an answer with a newline', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);
      const { resolved, handler } = recording(opened);

      await rpc(
        handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: ['first part', 'second part'] },
        'alice-key',
      );

      expect(resolved[0]?.payload).toBe('first part\nsecond part');
    });
  });

  it('addresses a wait by signalName, and answers a signal the task is not waiting on as a conflict', async () => {
    await withBureau({ generate: parksThenAnswers('ask-name') }, async (opened) => {
      const run = await parkedRun(opened);

      const wrong = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: 'x', signalName: 'other-signal' },
        'alice-key',
      );
      const right = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm2', answer: 'x', signalName: 'ask-name' },
        'alice-key',
      );

      expect(wrong.error?.data?.httpStatus).toBe(409);
      expect(right.result).toMatchObject({ receipt: 'applied', kind: 'human-wait' });
    });
  });

  it('denies and rejects a human wait with the decision, and rejection requires a reason', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);

      const noReason = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', decision: 'reject' },
        'alice-key',
      );
      const rejected = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm2', decision: 'reject', reason: 'not now' },
        'alice-key',
      );

      expect(noReason.error?.data?.httpStatus).toBe(400);
      expect(rejected.result).toMatchObject({
        decision: 'reject',
        receipt: 'applied',
        kind: 'human-wait',
      });
    });
  });

  it('applies one of two different commands that answer one wait at once, and delivers only its text', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);
      const { delivered, handler } = recording(opened);

      const [first, second] = await Promise.all([
        rpc(
          handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'a', answer: 'FIRST' },
          'alice-key',
        ),
        rpc(
          handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'b', answer: 'SECOND' },
          'alice-key',
        ),
      ]);

      const applied = [first, second].filter((body) => body.result?.['receipt'] === 'applied');
      const refused = [first, second].filter((body) => body.error?.data?.httpStatus === 409);
      expect(applied).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(delivered).toHaveLength(1);
      const winner = applied[0] === first ? 'FIRST' : 'SECOND';
      expect(delivered[0]?.payload).toBe(winner);
    });
  });

  it('returns the original receipt for an exact retry without resolving anything twice', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);
      const { resolved, handler } = recording(opened);
      const params = { taskId: run.id, messageId: 'm1', answer: 'once' };

      const first = await rpc(handler, 'bureau.tasks.respond', params, 'alice-key');
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'completed',
        'finish',
      );
      const retry = await rpc(handler, 'bureau.tasks.respond', params, 'alice-key');

      expect(first.result).toBeDefined();
      expect(retry.result).toEqual(first.result);
      expect(resolved).toHaveLength(1);
    });
  });

  it('answers a retry that spells the same command in another way with the same receipt', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);
      const first = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: ['one', 'two'] },
        'alice-key',
      );
      const retry = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: 'one\ntwo' },
        'alice-key',
      );

      expect(retry.result).toEqual(first.result);
    });
  });

  it('refuses the same messageId with a different command as a conflict', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);
      await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: 'first' },
        'alice-key',
      );

      const reused = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: 'something else' },
        'alice-key',
      );

      expect(reused.error?.data?.httpStatus).toBe(409);
      expect(JSON.stringify(reused)).toContain('m1');
    });
  });

  it('answers a task that is not awaiting input as a conflict, and claims nothing', async () => {
    await withBureau({}, async (opened) => {
      const run = await opened.bureau.tasks.start('default', 'busy', { principal: OWNER.alice });
      await waitForCondition(
        () => opened.bureau.tasks.detail(run.id)?.status === 'running',
        'running',
      );
      const { resolved, handler } = recording(opened);

      const body = await rpc(
        handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: 'hello?' },
        'alice-key',
      );

      expect(body.error?.data?.httpStatus).toBe(409);
      expect(resolved).toEqual([]);
    });
  });

  it('lets a caller holding bureau.tasks:write answer another owner’s human wait', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);
      const { resolved, handler } = recording(opened);

      const body = await rpc(
        handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: 'from the operator' },
        'tasks-writer-key',
      );

      expect(body.result).toMatchObject({ receipt: 'applied', kind: 'human-wait' });
      expect(resolved[0]?.principal).toBe('api-key:tasks-writer');
    });
  });

  it('answers a caller without the scope, and one holding only bureau.tasks:read, as a missing task', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);
      const { resolved, handler } = recording(opened);
      const params = { taskId: run.id, messageId: 'm1', answer: 'let me in' };

      const stranger = await rpc(handler, 'bureau.tasks.respond', params, 'bob-key');
      const reader = await rpc(handler, 'bureau.tasks.respond', params, 'tasks-reader-key');
      const missing = await rpc(
        handler,
        'bureau.tasks.respond',
        { ...params, taskId: 'run-no-such-task' },
        'bob-key',
      );

      expect(stranger.error?.data?.httpStatus).toBe(404);
      expect(reader.error?.data?.httpStatus).toBe(404);
      expect(JSON.stringify(stranger).replaceAll(run.id, '<id>')).toBe(
        JSON.stringify(missing).replaceAll('run-no-such-task', '<id>'),
      );
      expect(resolved).toEqual([]);
    });
  });

  it('rejects a request that sends both an answer and a decision, or neither, or names both a signal and a call', async () => {
    await withBureau({ generate: parksThenAnswers() }, async (opened) => {
      const run = await parkedRun(opened);
      const send = (extra: Record<string, unknown>) =>
        rpc(
          opened.handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'm', ...extra },
          'alice-key',
        );

      for (const params of [
        { answer: 'x', decision: 'approve' },
        {},
        { decision: 'approve', signalName: 's', callId: 'c' },
        { answer: 'x', callId: 'c' },
        { answer: '' },
        { answer: [] },
        { answer: 'x', principal: 'api-key:mallory' },
      ]) {
        const refused = await send(params);
        expect([params, refused.error?.data?.httpStatus]).toEqual([params, 400]);
      }
    });
  });
});

describe('bureau.tasks.respond deciding a tool approval', () => {
  it('approves it, which runs the tool, and the run finishes', async () => {
    const charges: number[] = [];
    await withBureau(
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
      async (opened) => {
        const run = await parkedApproval(opened);

        const body = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'approve-1', decision: 'approve' },
          'alice-key',
        );

        expect(body.result).toMatchObject({
          kind: 'tool-approval',
          decision: 'approve',
          receipt: 'applied',
        });
        expect(charges).toEqual([4242]);
      },
    );
  });

  it('denies it, and the tool does not run', async () => {
    const charges: number[] = [];
    await withBureau(
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
      async (opened) => {
        const run = await parkedApproval(opened);

        const body = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'deny-1', decision: 'deny' },
          'alice-key',
        );

        expect(body.result).toMatchObject({
          kind: 'tool-approval',
          decision: 'deny',
          receipt: 'applied',
        });
        expect(charges).toEqual([]);
      },
    );
  });

  it('rejects it with a reason, which comes back as feedback', async () => {
    const charges: number[] = [];
    await withBureau(
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
      async (opened) => {
        const run = await parkedApproval(opened);

        const body = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'reject-1', decision: 'reject', reason: 'wrong card' },
          'alice-key',
        );

        expect(body.result).toMatchObject({
          decision: 'reject',
          receipt: 'applied',
          feedback: 'wrong card',
        });
        expect(charges).toEqual([]);
      },
    );
  });

  it('addresses an approval by callId, and a call the task is not waiting on is a conflict', async () => {
    const charges: number[] = [];
    await withBureau(
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
      async (opened) => {
        const run = await parkedApproval(opened);

        const wrong = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'm1', decision: 'approve', callId: 'other-call' },
          'alice-key',
        );
        const right = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'm2', decision: 'approve', callId: 'charge-1' },
          'alice-key',
        );

        expect(wrong.error?.data?.httpStatus).toBe(409);
        expect(right.result).toMatchObject({ kind: 'tool-approval', receipt: 'applied' });
        expect(charges).toEqual([4242]);
      },
    );
  });

  it('refuses an answer addressed to a tool approval, which takes a decision', async () => {
    const charges: number[] = [];
    await withBureau(
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
      async (opened) => {
        const run = await parkedApproval(opened);

        const body = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'm1', answer: 'sure, go ahead' },
          'alice-key',
        );

        expect(body.error?.data?.httpStatus).toBe(422);
        expect(charges).toEqual([]);
      },
    );
  });

  it('answers another owner’s approval decision as a missing task, even with bureau.tasks:write', async () => {
    const charges: number[] = [];
    await withBureau(
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
      async (opened) => {
        const run = await parkedApproval(opened);
        const params = { taskId: run.id, messageId: 'm1', decision: 'approve' };

        const writer = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          params,
          'tasks-writer-key',
        );
        const missing = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          { ...params, taskId: 'run-no-such-task' },
          'tasks-writer-key',
        );

        expect(writer.error?.data?.httpStatus).toBe(404);
        expect(JSON.stringify(writer).replaceAll(run.id, '<id>')).toBe(
          JSON.stringify(missing).replaceAll('run-no-such-task', '<id>'),
        );
        expect(charges).toEqual([]);
        expect(opened.bureau.reviews.list().some((review) => review.runId === run.id)).toBe(true);
      },
    );
  });

  it('finishes a retry whose earlier attempt resolved the review but never recorded its receipt', async () => {
    const charges: number[] = [];
    await withBureau(
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
      async (opened) => {
        const run = await parkedApproval(opened);
        const [review] = opened.bureau.reviews.list();
        const host = buildBureauHandlerHost(opened.bureau, []);
        const handler = createOperationHandler({
          operations: BUREAU_HANDLER_OPERATIONS,
          host,
          authenticate: createOperationHandlerAuthenticator(authentication, {
            additionalScopes: BUREAU_SCOPES,
          }),
        });
        // The earlier attempt: it claimed the command and resolved the review, then died.
        await host.respondLedger.claim(
          {
            callerId: OWNER.alice,
            target: run.id,
            requestId: 'late-1',
            operationVersion: TASKS_RESPOND_OPERATION_VERSION,
          },
          digestCommandPayload({ decision: 'approve' }),
          { reviewId: review!.id },
        );
        await opened.bureau.reviews.resolve({
          id: review!.id,
          decision: 'approve',
          principal: OWNER.alice,
        });
        expect(charges).toEqual([4242]);

        const body = await rpc(
          handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'late-1', decision: 'approve' },
          'alice-key',
        );

        // The retry completes the claim as applied, and the card is charged once.
        expect(body.result).toMatchObject({
          reviewId: review!.id,
          decision: 'approve',
          receipt: 'applied',
        });
        expect(charges).toEqual([4242]);
      },
    );
  });

  it('answers a command for an approval decided elsewhere as a conflict, never a second charge', async () => {
    const charges: number[] = [];
    await withBureau(
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
      async (opened) => {
        const run = await parkedApproval(opened);
        const [review] = opened.bureau.reviews.list();
        await opened.bureau.reviews.resolve({
          id: review!.id,
          decision: 'approve',
          principal: OWNER.alice,
        });

        const body = await rpc(
          opened.handler,
          'bureau.tasks.respond',
          { taskId: run.id, messageId: 'late-2', decision: 'approve' },
          'alice-key',
        );

        expect(body.error?.data?.httpStatus).toBe(409);
        expect(charges).toEqual([4242]);
      },
    );
  });
});
