import type { GenerateFunction } from '@lostgradient/operative';
import { createTool, createToolbox, type Toolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { waitForCondition } from '../../test';
import {
  approvalToolbox,
  as,
  chargesOnce,
  openBureau,
  type OpenedBureau,
  OWNER,
  readFrames,
  rpc,
  subscribeRequest,
  type SseFrame,
} from './management-fixtures.test-support.ts';
import { createTaskEventProjector, type TaskEventSource } from './tasks-events-operation.ts';
import { TASK_ARTIFACT_TEXT_LIMIT } from '../../task-registry.ts';

async function withBureau<T>(
  options: Parameters<typeof openBureau>[0],
  body: (opened: OpenedBureau) => Promise<T>,
): Promise<T> {
  const opened = await openBureau({ durableHistory: true, ...options });
  try {
    return await body(opened);
  } finally {
    await opened.dispose();
  }
}

const kinds = (frames: readonly SseFrame[]) => frames.map((frame) => frame.event);
const statuses = (frames: readonly SseFrame[]) =>
  frames.flatMap((frame) =>
    frame.event === 'task.status' || frame.event === 'task.snapshot'
      ? [(frame.data as { status: string }).status]
      : [],
  );

/** A model that parks the run on a human wait, then finishes once it is answered. */
function parksThenAnswers(): GenerateFunction {
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
              arguments: { signalName: 'human-response', prompt: 'PRIVATE-PROMPT?' },
            },
          ],
        }
      : { content: 'the answer', toolCalls: [] };
  };
}

async function parkedRun(opened: OpenedBureau, principal = OWNER.alice) {
  const run = await opened.bureau.createRun({ agentName: 'default', message: 'park', principal });
  await waitForCondition(
    () => opened.bureau.reviews.list().some((review) => review.runId === run.id),
    'the run never parked',
  );
  await waitForCondition(async () => {
    const page = await opened.bureau.eventHistory({ kind: 'run', id: run.id });
    return 'events' in page && page.events.some((event) => event.kind === 'review.requested');
  }, 'review.requested never reached the history');
  return run;
}

const humanWaitOptions = () => ({ generate: parksThenAnswers() }) as const;

describe('bureau.tasks.events', () => {
  it('requires ownership or bureau.tasks:read, and answers anyone else as a missing task', async () => {
    await withBureau(
      { generate: async () => ({ content: 'ok', toolCalls: [] }) },
      async (opened) => {
        const run = await opened.bureau.createRun({
          agentName: 'default',
          message: 'go',
          principal: OWNER.alice,
        });
        await waitForCondition(
          () => opened.bureau.getRun(run.id)?.status === 'completed',
          'finish',
        );

        const owner = await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
        );
        const reader = await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'tasks-reader-key'),
        );
        const stranger = await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'bob-key'),
        );
        const writer = await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'tasks-writer-key'),
        );
        const missing = await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: 'run-no-such-task' }, 'bob-key'),
        );

        expect([owner.status, reader.status]).toEqual([200, 200]);
        await owner.body?.cancel();
        await reader.body?.cancel();
        expect([stranger.status, writer.status, missing.status]).toEqual([404, 404, 404]);
        const strangerText = await stranger.text();
        const missingText = await missing.text();
        expect(strangerText.replaceAll(run.id, '<id>')).toBe(
          missingText.replaceAll('run-no-such-task', '<id>'),
        );
      },
    );
  });

  it('streams a finished task as a snapshot and its terminal status, with the answer once as one artifact', async () => {
    let calls = 0;
    const toolbox = createToolbox([
      createTool({
        name: 'echo',
        version: '1.0.0',
        description: 'echo',
        input: z.object({ text: z.string() }),
        async execute({ text }) {
          return { echoed: `${text}-SECRET-TOOL-RESULT` };
        },
      }),
    ]) as unknown as Toolbox;
    const generate: GenerateFunction = async () => {
      calls += 1;
      return calls === 1
        ? {
            content: 'STEP-CONTENT-SECRET',
            toolCalls: [{ id: 'c1', name: 'echo', arguments: { text: 'SECRET-TOOL-ARGUMENT' } }],
          }
        : { content: 'the final answer', toolCalls: [] };
    };
    await withBureau({ generate, toolbox }, async (opened) => {
      const run = await opened.bureau.createRun({
        agentName: 'default',
        message: 'go',
        principal: OWNER.alice,
      });
      await waitForCondition(() => opened.bureau.getRun(run.id)?.status === 'completed', 'finish');
      await waitForCondition(async () => {
        const page = await opened.bureau.eventHistory({ kind: 'run', id: run.id });
        return 'events' in page && page.events.some((event) => event.kind === 'run.completed');
      }, 'run.completed never reached the history');

      const frames = await readFrames(
        await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
        ),
      );

      expect(kinds(frames)).toEqual(['task.snapshot', 'task.status']);
      expect(frames[1]?.data).toMatchObject({
        taskId: run.id,
        status: 'completed',
        finishReason: 'stop-condition',
        artifact: { artifactId: `${run.id}:result`, text: 'the final answer', truncated: false },
      });
      const text = JSON.stringify(frames);
      for (const leaked of ['STEP-CONTENT-SECRET', 'SECRET-TOOL-ARGUMENT', 'SECRET-TOOL-RESULT']) {
        expect(text).not.toContain(leaked);
      }
      expect(text.match(/the final answer/g)).toHaveLength(1);
    });
  });

  it('shows a run parking as input-required, without the prompt, and resumes from any cursor it was given', async () => {
    await withBureau(humanWaitOptions(), async (opened) => {
      const run = await parkedRun(opened);
      const live = await opened.handler(
        subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
      );
      const reading = readFrames(live, {
        stop: (frames) => statuses(frames).includes('completed'),
      });

      const [review] = opened.bureau.reviews.list();
      const answered = await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'answer-1', answer: 'the human said so' },
        'alice-key',
      );
      expect(answered.error).toBeUndefined();
      const frames = await reading;

      expect(statuses(frames)).toEqual([
        'input-required',
        'input-required',
        'working',
        'completed',
      ]);
      expect(kinds(frames)).toEqual(['task.snapshot', 'task.status', 'task.status', 'task.status']);
      expect(JSON.stringify(frames)).not.toContain('PRIVATE-PROMPT');
      expect(JSON.stringify(frames)).not.toContain('the human said so');
      expect(review?.runId).toBe(run.id);

      // Every element's cursor resumes the stream just after it.
      const cursors = frames.slice(1).map((frame) => frame.id!);
      expect(new Set(cursors).size).toBe(cursors.length);
      const resumed = await readFrames(
        await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key', cursors[0]),
        ),
      );
      expect(resumed.map((frame) => frame.id)).toEqual(cursors.slice(1));
      expect(kinds(resumed)).toEqual(['task.status', 'task.status']);
      expect(statuses(resumed)).toEqual(['working', 'completed']);
    });
  });

  it('shows a task that finished with an approval still pending as input-required, as tasks.get does, until it is decided', async () => {
    const charges: number[] = [];
    await withBureau(
      { generate: chargesOnce, toolbox: approvalToolbox(charges), stopAtApproval: true },
      async (opened) => {
        const run = await opened.bureau.createRun({
          agentName: 'default',
          message: 'charge',
          principal: OWNER.alice,
        });
        await waitForCondition(
          () => opened.bureau.reviews.list().some((review) => review.runId === run.id),
          'the approval never became pending',
        );
        await waitForCondition(async () => {
          const page = await opened.bureau.eventHistory({ kind: 'run', id: run.id });
          return 'events' in page && page.events.some((event) => event.kind === 'review.requested');
        }, 'review.requested never reached the history');

        const live = await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
        );
        const reading = readFrames(live, { stop: (frames) => statuses(frames).length >= 2 });
        const task = await rpc(opened.handler, 'bureau.tasks.get', { taskId: run.id }, 'alice-key');
        const frames = await reading;

        // The stream and the task agree: waiting on an answer is not done.
        expect(task.result?.['status']).toBe('input-required');
        expect(statuses(frames).at(-1)).toBe('input-required');
        expect(statuses(frames)).not.toContain('completed');
        // The approval's tool arguments (`{ cents: 4242 }`) never reach the stream. Matched by the
        // key, not the number, which a clock reading or an id can contain by chance.
        expect(JSON.stringify(frames)).not.toContain('"cents"');
        expect(charges).toEqual([]);
      },
    );
  });

  it('closes the stream after the terminal status, so a resume past it ends at once', async () => {
    await withBureau(humanWaitOptions(), async (opened) => {
      const run = await parkedRun(opened);
      await rpc(
        opened.handler,
        'bureau.tasks.respond',
        { taskId: run.id, messageId: 'm1', answer: 'go' },
        'alice-key',
      );
      await waitForCondition(async () => {
        const page = await opened.bureau.eventHistory({ kind: 'run', id: run.id });
        return 'events' in page && page.events.some((event) => event.kind === 'run.completed');
      }, 'run.completed never reached the history');
      const all = await readFrames(
        await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
        ),
      );
      const last = all.at(-1)!;

      const after = await readFrames(
        await opened.handler(
          subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key', last.id),
        ),
      );

      expect(after).toEqual([]);
    });
  });

  it('answers an ephemeral Bureau, which keeps no durable history, as an unsupported capability', async () => {
    await withBureau({ durableHistory: false }, async (opened) => {
      const run = await opened.bureau.createRun({
        agentName: 'default',
        message: 'go',
        principal: OWNER.alice,
      });

      const response = await opened.handler(
        subscribeRequest('bureau.tasks.events', { taskId: run.id }, 'alice-key'),
      );

      expect(response.status).toBe(501);
    });
  });

  it('rejects a malformed cursor as InvalidParams', async () => {
    await withBureau(humanWaitOptions(), async (opened) => {
      const run = await parkedRun(opened);
      const response = await opened.handler(
        new Request(
          `http://localhost/v1/subscriptions/bureau.tasks.events?taskId=${run.id}&fromCursor=not-a-cursor`,
          { headers: { Accept: 'text/event-stream', ...as('alice-key') } },
        ),
      );
      expect(response.status).toBe(400);
    });
  });
});

describe('the task event projection', () => {
  const at = (kind: string, payload: unknown, cursor = '1'): TaskEventSource => ({
    kind,
    cursor,
    emittedAtMs: 10,
    payload,
  });

  it('drops a durable kind it does not list, and never passes a payload through', () => {
    const projector = createTaskEventProjector('run-1');
    for (const kind of [
      'step.completed',
      'schedule.completed',
      'run.tripwire',
      'session.created',
      'something.new',
    ]) {
      expect(projector.project(at(kind, { content: 'SECRET', steps: ['SECRET'] }))).toBeUndefined();
    }
    const completed = projector.project(
      at('run.completed', {
        finishReason: 'stop-condition',
        content: 'answer',
        steps: [{ content: 'SECRET-STEP' }],
        result: { steps: ['SECRET-STEP'] },
        usage: { total: 1 },
      }),
    );
    expect(JSON.stringify(completed)).not.toContain('SECRET-STEP');
    expect(Object.keys(completed ?? {}).toSorted()).toEqual([
      'artifact',
      'cursor',
      'emittedAtMs',
      'finishReason',
      'kind',
      'message',
      'status',
      'taskId',
    ]);
  });

  it('maps the finish reasons onto completed, failed and canceled', () => {
    const state = (payload: unknown, kind = 'run.completed') =>
      (createTaskEventProjector('run-1').project(at(kind, payload)) as { status: string }).status;

    expect(state({ finishReason: 'stop-condition', content: '' })).toBe('completed');
    expect(state({ finishReason: 'maximum-steps' })).toBe('failed');
    expect(state({ finishReason: 'error', error: 'boom' })).toBe('failed');
    expect(state({ finishReason: 'aborted' })).toBe('canceled');
    expect(state({ error: 'boom' }, 'run.error')).toBe('failed');
    expect(state({}, 'run.aborted')).toBe('canceled');
  });

  it('truncates a long answer to the artifact limit and says so', () => {
    const element = createTaskEventProjector('run-1').project(
      at('run.completed', {
        finishReason: 'stop-condition',
        content: 'x'.repeat(TASK_ARTIFACT_TEXT_LIMIT + 5),
      }),
    ) as { artifact: { text: string; truncated: boolean } };

    expect(element.artifact.text).toHaveLength(TASK_ARTIFACT_TEXT_LIMIT);
    expect(element.artifact.truncated).toBe(true);
  });

  it('holds a successful run open as input-required while a review is, and shows the success once the last is resolved', () => {
    const projector = createTaskEventProjector('run-1');
    const status = (element: unknown) => (element as { status: string } | undefined)?.status;

    expect(status(projector.project(at('review.requested', { reviewId: 'a' }, '1')))).toBe(
      'input-required',
    );
    expect(status(projector.project(at('review.requested', { reviewId: 'b' }, '2')))).toBe(
      'input-required',
    );
    expect(
      status(projector.project(at('run.completed', { finishReason: 'stop-condition' }, '3'))),
    ).toBe('input-required');
    expect(projector.ended).toBe(false);
    expect(status(projector.project(at('review.approved', { reviewId: 'a' }, '4')))).toBe(
      'input-required',
    );
    expect(projector.ended).toBe(false);
    expect(status(projector.project(at('review.denied', { reviewId: 'b' }, '5')))).toBe(
      'completed',
    );
    expect(projector.ended).toBe(true);
  });

  it('serves the answer of a run that completed while a review was open once the last review is resolved', () => {
    const projector = createTaskEventProjector('run-1');
    projector.project(at('review.requested', { reviewId: 'a' }, '1'));
    projector.project(
      at('run.completed', { finishReason: 'stop-condition', content: 'the held answer' }, '2'),
    );

    const done = projector.project(at('review.approved', { reviewId: 'a' }, '3'));

    expect(done).toMatchObject({
      status: 'completed',
      artifact: { artifactId: 'run-1:result', text: 'the held answer', truncated: false },
    });
  });

  it('starts from the task’s snapshot, so a retained review event cannot undo a settlement that was pruned', () => {
    const projector = createTaskEventProjector('run-1', {
      status: 'completed',
      finishReason: 'stop-condition',
      statusMessage: null,
      openWaits: [],
    });

    // Only the resolution survived the retention floor; the run.completed below it did not.
    const element = projector.project(at('review.approved', { reviewId: 'a' }, '9'));

    expect(element).toMatchObject({ status: 'completed', finishReason: 'stop-condition' });
    expect(projector.ended).toBe(true);
  });

  it('knows the reviews the snapshot says are open', () => {
    const projector = createTaskEventProjector('run-1', {
      status: 'input-required',
      finishReason: null,
      statusMessage: null,
      openWaits: [{ kind: 'human-wait', reviewId: 'a', signalName: 'answer' }],
    });

    const element = projector.project(
      at('run.completed', { finishReason: 'stop-condition', content: 'x' }, '3'),
    );

    expect(element).toMatchObject({ status: 'input-required' });
    expect(projector.ended).toBe(false);
  });

  it('shows a failed or canceled run as that, whatever review is open', () => {
    const failed = createTaskEventProjector('run-1');
    failed.project(at('review.requested', { reviewId: 'a' }, '1'));
    expect(
      (failed.project(at('run.error', { error: 'boom' }, '2')) as { status: string }).status,
    ).toBe('failed');
    expect(failed.ended).toBe(true);

    const canceled = createTaskEventProjector('run-1');
    canceled.project(at('review.requested', { reviewId: 'a' }, '1'));
    expect((canceled.project(at('run.aborted', {}, '2')) as { status: string }).status).toBe(
      'canceled',
    );
    expect(canceled.ended).toBe(true);
  });

  it('ends a failed run on its run.error with the finish reason the event carries (COR-1627)', () => {
    const limited = createTaskEventProjector('run-1');
    expect(
      limited.project(
        at(
          'run.error',
          { error: 'Agent run exceeded maximumSteps (2).', finishReason: 'maximum-steps' },
          '2',
        ),
      ),
    ).toMatchObject({
      status: 'failed',
      finishReason: 'maximum-steps',
      message: 'Agent run exceeded maximumSteps (2).',
    });
    expect(limited.ended).toBe(true);

    // A `run.error` recorded before the payload carried the reason, or one that is the only
    // end the history has, still ends the stream, with the reason unknown.
    const legacy = createTaskEventProjector('run-1');
    expect(legacy.project(at('run.error', { error: 'boom' }, '2'))).toMatchObject({
      status: 'failed',
      finishReason: null,
    });
    expect(legacy.ended).toBe(true);
  });

  it('serves a removal and ends, and a retention gap as one element', () => {
    const removed = createTaskEventProjector('run-1');
    expect(removed.project(at('run.removed', { runId: 'run-1' }))).toMatchObject({
      kind: 'task.removed',
    });
    expect(removed.ended).toBe(true);

    expect(
      createTaskEventProjector('run-1').project(
        at('history.gap', { requestedCursor: '3', firstRetainedCursor: '9' }, '8'),
      ),
    ).toMatchObject({
      kind: 'task.gap',
      requestedCursor: '3',
      firstRetainedCursor: '9',
      cursor: '8',
    });
  });
});
