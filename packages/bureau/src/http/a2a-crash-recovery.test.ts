/**
 * The regression guard for retried A2A commands (COR-903): for each kind of command, a crash
 * between the effect and `ledger.complete`, followed by a restart that leaves no in-memory state
 * (a new handler, and a Bureau that holds no run), is retried to the receipt of what was done.
 * A second table holds the boundary validation: a malformed command is refused before the ledger
 * is touched.
 */
import { Message, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createDefaultRuntimeServices, createManualRuntimeServices } from '@lostgradient/lifecycle';
import { createAgent, type GenerateFunction } from '@lostgradient/operative';
import { MemoryStorage, principalFromApiKey, textValueStore } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createCommandLedger } from '../command-ledger.ts';
import { waitForCondition } from '../test';
import { rejectionOf } from '../testing/promise-outcome.test-support.ts';
import { createBureauAgentCard } from './a2a-agent-card.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
  type A2ASendLedger,
  type A2ASendResult,
  BureauA2AUser,
  createBureauA2ARequestHandler,
} from './a2a-request-handler.ts';
import { createA2ATaskRecords } from './a2a-task-record.ts';
import { buildBureauHandlerHost } from './create-bureau-handler.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';
import { respondToTask } from './management/tasks-respond-operation.ts';

const PAST = { deadline: '2000-01-01T00:00:00Z' };

/** Parks on a human wait, then answers; the first run of a task that needs an answer. */
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
              arguments: { signalName: 'human-response', prompt: 'Which?' },
            },
          ],
        }
      : { content: 'done', toolCalls: [] };
  };
}

/** Holds its first step until released, so a task stays working while input is sent to it. */
function gated(): { generate: GenerateFunction; release: () => void } {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  return {
    release: () => release(),
    generate: async () => {
      calls += 1;
      if (calls === 1) await gate;
      return { content: `reply ${calls}`, toolCalls: [] };
    },
  };
}

function userMessage(messageId: string, text: string, taskId = '', receipts?: object): Message {
  return Message.fromJSON({
    messageId,
    taskId,
    role: 'ROLE_USER',
    parts: [{ text }],
    ...(receipts === undefined ? {} : { metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: receipts } }),
  });
}

type Service = {
  send: (message: Message) => Promise<any>;
  /** Sends a message and waits until the task settles or waits on its requester. */
  start: (message: Message) => Promise<any>;
  crashNextComplete: () => void;
  restart: () => void;
  /** A restart after the durable events were pruned: the run holds no history to read a reply from. */
  restartPruned: () => void;
  /** A restart whose Bureau answers `locateRunCreationReceipt` as given, for a state a test cannot reach. */
  restartLocating: (locate: () => Promise<unknown>) => void;
  claims: () => number;
  /** The Bureau's clock; a task settled at its origin is `ageMilliseconds` old after it moves. */
  runtime: ReturnType<typeof createManualRuntimeServices>;
  /**
   * Retires the tasks that settled before the clock last moved by `TASK_AGE_MILLISECONDS`, and
   * only those: the Bureau has no method that deletes one run.
   */
  retireEarlierTasks: () => Promise<void>;
  records: ReturnType<typeof createA2ATaskRecords>;
  bureau: Awaited<ReturnType<typeof openBureau>>['bureau'];
};

/** How much later than the task a test retires, the task a crashed command then creates is made. */
const TASK_AGE_MILLISECONDS = 30_000;

async function withService(
  generate: GenerateFunction,
  body: (service: Service) => Promise<void>,
): Promise<void> {
  const bureauRuntime = createManualRuntimeServices();
  const opened = await openBureau({
    agents: { asker: createAgent({ name: 'asker', generate }) },
    publish: ['asker'],
    humanInput: true,
    bureauOptions: {
      runtime: bureauRuntime,
      taskRetention: { olderThan: 2 * TASK_AGE_MILLISECONDS },
      runCreationTerminalRetentionMs: 1000,
    },
  });
  try {
    const base = createDefaultRuntimeServices();
    const inner = createCommandLedger<A2ASendClaim, A2ASendResult>({
      kv: textValueStore(new MemoryStorage()),
      keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
      clock: base.clock,
      nextConflictId: () => base.identifiers.next('conflict'),
    });
    let crash = false;
    let claims = 0;
    const ledger: A2ASendLedger = {
      ...inner,
      async claim(...input) {
        claims += 1;
        return inner.claim(...input);
      },
      async complete(entry, result) {
        if (crash) {
          crash = false;
          throw new Error('the process died before the receipt was written');
        }
        return inner.complete(entry, result);
      },
    };
    const records = createA2ATaskRecords(textValueStore(new MemoryStorage()));
    const host = buildBureauHandlerHost(opened.bureau, ['asker']);
    const card = createBureauAgentCard({
      catalogName: 'asker',
      displayName: undefined,
      description: undefined,
      definitionRevision: 1,
      skillDescriptors: undefined,
      security: undefined,
      durableHistory: true,
      pushNotifications: false,
    });
    /** A handler over the durable state only: the Bureau it reads holds no run of its own. */
    const build = (restarted: boolean, pruned = false, locate?: () => Promise<unknown>) =>
      createBureauA2ARequestHandler({
        publicUrl: 'http://localhost',
        agentName: 'asker',
        card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
        bureau: restarted
          ? Object.create(opened.bureau, {
              getRun: { value: () => undefined },
              ...(locate === undefined ? {} : { locateRunCreationReceipt: { value: locate } }),
              ...(pruned
                ? { eventHistory: { value: async () => ({ events: [], hasMore: false }) } }
                : {}),
            })
          : opened.bureau,
        records,
        ledger,
        runtime: base,
        respond: (principal, input) => respondToTask(host, principal, input),
      });
    let handler = build(false);
    const principal = principalFromApiKey({ subject: 'alice', scopes: [] });
    const context = () =>
      new ServerCallContext({
        user: new BureauA2AUser(principal),
        requestedVersion: '1.0',
        requestedExtensions: [COMMAND_RECEIPTS_EXTENSION_URI],
      });
    const call = (message: Message, immediately: boolean) =>
      handler.sendMessage(
        {
          tenant: '',
          message,
          configuration: immediately ? ({ returnImmediately: true } as never) : undefined,
          metadata: undefined,
        },
        context(),
      );
    await body({
      send: (message) => call(message, true),
      start: (message) => call(message, false),
      crashNextComplete: () => {
        crash = true;
      },
      restart: () => {
        handler = build(true);
      },
      restartLocating: (locate) => {
        handler = build(true, false, locate);
      },
      restartPruned: () => {
        handler = build(true, true);
      },
      claims: () => claims,
      runtime: bureauRuntime,
      retireEarlierTasks: async () => {
        await bureauRuntime.advance(TASK_AGE_MILLISECONDS + 1);
        await opened.bureau.runDurableMaintenance();
        await opened.bureau.runDurableMaintenance();
      },
      records,
      bureau: opened.bureau,
    });
  } finally {
    await opened.dispose();
  }
}

const receiptOf = (task: any) => task.metadata?.[COMMAND_RECEIPTS_EXTENSION_URI];

describe('a command retried after a crash before its receipt, on a process that holds nothing', () => {
  it('create: finds its one task and reports what happened to it', async () => {
    await withService(
      async () => ({ content: 'done', toolCalls: [] }),
      async (service) => {
        const message = userMessage('m-create', 'go', '', {});
        service.crashNextComplete();
        await rejectionOf(service.send(message));
        service.restart();
        const retried = await service.send(message);

        const listed = await service.bureau.tasks.enumerate({
          agentName: 'asker',
          limit: 50,
          offset: 0,
        });
        expect(listed.tasks.map((task) => task.id)).toEqual([retried.id]);
        expect(['applied', 'observed']).toContain(receiptOf(retried).receipt.state);
        const mine = retried.history.filter((entry: Message) => entry.messageId === 'm-create');
        expect(mine).toHaveLength(1);
      },
    );
  });

  it('create with references: finds its task though a referenced task was removed since', async () => {
    await withService(
      async () => ({ content: 'done', toolCalls: [] }),
      async (service) => {
        const referenced = await service.start(userMessage('m-referenced', 'first'));
        await service.runtime.advance(TASK_AGE_MILLISECONDS);
        const message = Message.fromJSON({
          messageId: 'm-create-reference',
          taskId: '',
          role: 'ROLE_USER',
          parts: [{ text: 'second' }],
          referenceTaskIds: [referenced.id],
        });
        service.crashNextComplete();
        await rejectionOf(service.send(message));
        await service.retireEarlierTasks();
        service.restart();
        // The run exists, so the retry is owed it: recovering the creation precedes any recheck of
        // what the message referenced.
        const retried = await service.send(message);

        const listed = await service.bureau.tasks.enumerate({
          agentName: 'asker',
          limit: 50,
          offset: 0,
        });
        expect(listed.tasks.map((task) => task.id)).toEqual([retried.id]);
        expect(retried.id).not.toBe(referenced.id);
      },
    );
  });

  it('create past its deadline: finds its one expired task', async () => {
    await withService(
      async () => ({ content: 'done', toolCalls: [] }),
      async (service) => {
        const message = userMessage('m-late', 'too late', '', PAST);
        service.crashNextComplete();
        await rejectionOf(service.send(message));
        service.restart();
        const retried = await service.send(message);

        expect(retried.status.state).toBe(TaskState.TASK_STATE_FAILED);
        expect(receiptOf(retried).receipt).toMatchObject({
          state: 'expired',
          reason: 'deadline-exceeded',
        });
        const listed = await service.bureau.tasks.enumerate({
          agentName: 'asker',
          limit: 50,
          offset: 0,
        });
        expect(listed.tasks.map((task) => task.id)).toEqual([retried.id]);
      },
    );
  });

  it('create with references, its run-creation receipt not started: the checks decide', async () => {
    await withService(
      async () => ({ content: 'done', toolCalls: [] }),
      async (service) => {
        const referenced = await service.start(userMessage('m-referenced', 'first'));
        await service.runtime.advance(TASK_AGE_MILLISECONDS);
        const message = Message.fromJSON({
          messageId: 'm-pending-receipt',
          taskId: '',
          role: 'ROLE_USER',
          parts: [{ text: 'second' }],
          referenceTaskIds: [referenced.id],
        });
        service.crashNextComplete();
        await rejectionOf(service.send(message));
        await service.retireEarlierTasks();
        // A receipt still `pending` names a run that never started, so there is no run to finish.
        service.restartLocating(async () => ({
          status: 'pending',
          receipt: { runId: 'run-never-started', status: 'pending' },
          sessionId: 'context-never-started',
        }));

        const error = await rejectionOf(service.send(message));

        expect(String(error)).toContain('referenceTaskIds');
      },
    );
  });

  it('create with references, its receipt unlocatable: the checks decide', async () => {
    await withService(
      async () => ({ content: 'done', toolCalls: [] }),
      async (service) => {
        const referenced = await service.start(userMessage('m-referenced', 'first'));
        await service.runtime.advance(TASK_AGE_MILLISECONDS);
        const message = Message.fromJSON({
          messageId: 'm-unlocatable',
          taskId: '',
          role: 'ROLE_USER',
          parts: [{ text: 'second' }],
          referenceTaskIds: [referenced.id],
        });
        service.crashNextComplete();
        await rejectionOf(service.send(message));
        await service.retireEarlierTasks();
        service.restartLocating(async () => {
          throw new Error('no receipts here');
        });

        const error = await rejectionOf(service.send(message));

        expect(String(error)).toContain('referenceTaskIds');
      },
    );
  });

  it('create past its deadline with references: finds its expired task though a referenced task was removed', async () => {
    await withService(
      async () => ({ content: 'done', toolCalls: [] }),
      async (service) => {
        const referenced = await service.start(userMessage('m-referenced', 'first'));
        await service.runtime.advance(TASK_AGE_MILLISECONDS);
        const message = Message.fromJSON({
          messageId: 'm-late-reference',
          taskId: '',
          role: 'ROLE_USER',
          parts: [{ text: 'too late' }],
          referenceTaskIds: [referenced.id],
          metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: PAST },
        });
        service.crashNextComplete();
        await rejectionOf(service.send(message));
        await service.retireEarlierTasks();
        service.restart();
        const retried = await service.send(message);

        expect(retried.status.state).toBe(TaskState.TASK_STATE_FAILED);
        expect(receiptOf(retried).receipt.state).toBe('expired');
      },
    );
  });

  it('answer: completes by its claim, whatever revision the first process reported', async () => {
    await withService(parksThenAnswers(), async (service) => {
      const parked = await service.start(userMessage('m-start', 'start'));
      expect(parked.status.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      const revision = receiptOf(parked).revision;
      const answer = userMessage('m-answer', 'blue', parked.id, { expectedRevision: revision });
      service.crashNextComplete();
      await rejectionOf(service.send(answer));
      await waitForCondition(async () => {
        const view = await service.bureau.tasks.get(parked.id);
        return view?.status === 'completed';
      }, 'the answered task never completed');
      service.restart();
      const retried = await service.send(answer);

      expect(retried.id).toBe(parked.id);
      expect(receiptOf(retried).receipt.state).toBe('applied');
      const mine = retried.history.filter((entry: Message) => entry.messageId === 'm-answer');
      expect(mine).toHaveLength(1);
    });
  });

  it('an expectedRevision read on one process is honoured on another', async () => {
    await withService(parksThenAnswers(), async (service) => {
      const parked = await service.start(userMessage('m-start', 'start'));
      const revision = receiptOf(parked).revision;
      service.restart();
      const read = await service.send(
        userMessage('m-answer', 'blue', parked.id, { expectedRevision: revision }),
      );
      expect(receiptOf(read).receipt.state).toBe('applied');
    });
  });

  it('input: reports the mailbox’s receipt as it stands now, not as it stood at admission', async () => {
    const run = gated();
    await withService(run.generate, async (service) => {
      const started = await service.send(userMessage('m-start', 'start'));
      const input = userMessage('m-input', 'also this', started.id, {});
      service.crashNextComplete();
      await rejectionOf(service.send(input));
      service.restart();
      const queued = await service.send(input);
      expect(['accepted', 'applied']).toContain(receiptOf(queued).receipt.state);

      run.release();
      let state = '';
      await waitForCondition(async () => {
        const again = await service.send(input);
        state = receiptOf(again).receipt.state;
        return state === 'applied';
      }, 'the input’s receipt never reported it applied');
      expect(state).toBe('applied');
    });
  });
});

describe('a completed task’s reply, after a restart that pruned its history', () => {
  it('is read back from the A2A record, not from events that are gone', async () => {
    await withService(
      async () => ({ content: 'the retained reply', toolCalls: [] }),
      async (service) => {
        const first = await service.start(userMessage('m-retained', 'ask'));
        expect(JSON.stringify(first.history)).toContain('the retained reply');
        await waitForCondition(async () => {
          const view = await service.bureau.tasks.get(first.id);
          return view?.status === 'completed';
        }, 'the task never completed');
        // The record holds the reply once the task settled, on the instance that ran it.
        await waitForCondition(async () => {
          const held = await service.records.read(first.id);
          return held?.replyRecorded === true;
        }, 'the reply was never recorded');
        service.restartPruned();

        const read = await service.send(userMessage('m-retained', 'ask'));

        expect(read.id).toBe(first.id);
        expect(JSON.stringify(read.history)).toContain('the retained reply');
      },
    );
  });
});

describe('the boundary refuses a malformed command before the ledger is touched', () => {
  const withMetadata = (taskId: string, metadata: object, parts: object[] = [{ text: 'blue' }]) =>
    Message.fromJSON({ messageId: 'm-bad', taskId, role: 'ROLE_USER', parts, metadata });
  const receipts = (fields: object) => ({ [COMMAND_RECEIPTS_EXTENSION_URI]: fields });

  const cases: ReadonlyArray<{
    name: string;
    message: (taskId: string) => Message;
    pattern: RegExp;
    parked: boolean;
  }> = [
    {
      name: 'an unknown decision',
      message: (id) => withMetadata(id, {}, [{ data: { decision: 'maybe' } }]),
      pattern: /decision must be/,
      parked: true,
    },
    {
      name: 'a reject without a reason',
      message: (id) => withMetadata(id, {}, [{ data: { decision: 'reject' } }]),
      pattern: /requires a reason/,
      parked: true,
    },
    {
      name: 'an answer that says nothing',
      message: (id) => withMetadata(id, {}, []),
      pattern: /at least one part/,
      parked: true,
    },
    {
      name: 'a callId that is not a string',
      message: (id) => withMetadata(id, { callId: 7 }),
      pattern: /callId must be a string/,
      parked: true,
    },
    {
      name: 'a malformed deadline',
      message: (id) => withMetadata(id, receipts({ deadline: '2026-13-01T00:00:00Z' })),
      pattern: /RFC 3339/,
      parked: true,
    },
    {
      name: 'an empty expectedRevision',
      message: (id) => withMetadata(id, receipts({ expectedRevision: '' })),
      pattern: /expectedRevision/,
      parked: true,
    },
    {
      name: 'a field the receipts namespace does not have',
      message: (id) => withMetadata(id, receipts({ surprise: true })),
      pattern: /no field 'surprise'/,
      parked: true,
    },
    {
      name: 'a delivery mode that does not exist',
      message: (id) => withMetadata(id, { deliveryMode: 'shout' }),
      pattern: /deliveryMode/,
      parked: false,
    },
    {
      name: 'an input with no text',
      message: (id) => withMetadata(id, {}, [{ data: { a: 1 } }]),
      pattern: /needs a text part/,
      parked: false,
    },
  ];

  for (const entry of cases) {
    it(entry.name, async () => {
      const run = gated();
      await withService(entry.parked ? parksThenAnswers() : run.generate, async (service) => {
        const started = await (entry.parked ? service.start : service.send)(
          userMessage('m-start', 'start'),
        );
        const before = service.claims();
        const refused = await rejectionOf(service.send(entry.message(started.id)));
        expect((refused as Error).message).toMatch(entry.pattern);
        expect(service.claims()).toBe(before);
        run.release();
      });
    });
  }
});
