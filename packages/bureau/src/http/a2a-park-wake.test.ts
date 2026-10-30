/**
 * COR-1754 — a blocking A2A `SendMessage` is woken by what its task does, not by the handler's
 * safety-net poll. Every row here runs with that poll held: it is armed and never fires, so a send
 * that returns was woken by an event. The run does nothing until the handler is waiting (its poll
 * is armed), so the event is always one the send was listening for, never one it read on arrival.
 */
import { type Message as A2AMessage, Message, type Task, TaskState } from '@a2a-js/sdk';
import type { RuntimeTimers } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  stopWhen,
} from '@lostgradient/operative';
import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { describe, expect, it } from 'bun:test';

import { A2UI_EXTENSION_URI } from '../a2ui/catalogs.ts';
import type { Bureau } from '../types.ts';
import { COMMAND_RECEIPTS_EXTENSION_URI } from './a2a-command-receipts.ts';
import { attachHandler } from './a2a-input-form.test-support.ts';
import {
  approvalToolbox,
  chargesOnce,
  openBureau,
} from './management/management-fixtures.test-support.ts';

/** The handler's safety-net poll (`SETTLE_POLL_MS` in `a2a-request-handler.ts`). */
const SETTLE_POLL_MILLISECONDS = 1_000;
/** The longest delay a timer takes, so a held poll never comes due. */
const NEVER_MILLISECONDS = 2_147_483_647;
/** The key under which the Weft handler stores a request's abort signal in the call context. */
const REQUEST_SIGNAL_STATE_KEY = 'weft.a2a.requestSignal';

const parksOnHumanInput: GenerateFunction = async () => ({
  content: '',
  toolCalls: [
    {
      id: 'wait-1',
      name: 'requestHumanInput',
      arguments: { signalName: 'deploy', prompt: 'Where should this deploy?' },
    },
  ],
});

/** A run that stays working until it is aborted. */
const holdsUntilAborted: GenerateFunction = ({ signal }: GenerateContext) =>
  new Promise((_resolve, reject) => {
    signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

/** What a row waits for the handler to do before its run moves. */
type Gates = {
  /** Resolves once the handler is waiting on its safety-net poll. */
  readonly armed: Promise<void>;
};

type Row = {
  readonly name: string;
  /** The run: it starts when the handler is waiting. */
  readonly generate: (gates: Gates) => GenerateFunction;
  readonly tools?: boolean;
  /** What the test does to the task once the handler is waiting, if the run does not act alone. */
  readonly act?: (fixture: Fixture) => Promise<void> | void;
  readonly state: TaskState;
};

type Fixture = Awaited<ReturnType<typeof openFixture>>;

/** The run starts when the handler is waiting. */
function afterArmed(generate: GenerateFunction): (gates: Gates) => GenerateFunction {
  return (gates) => async (context) => {
    await gates.armed;
    return generate(context);
  };
}

async function openFixture(
  row: Pick<Row, 'generate' | 'tools'>,
  wrap?: { bureau?: (bureau: Bureau) => Bureau },
) {
  const armed = Promise.withResolvers<void>();
  const held: ReturnType<RuntimeTimers['setTimeout']>[] = [];
  let realTimers: RuntimeTimers | undefined;
  const charges: number[] = [];
  const generate = row.generate({ armed: armed.promise });
  const opened = await openBureau({
    agents: {
      asker: createAgent({
        name: 'asker',
        generate,
        maximumSteps: 100,
        ...(row.tools === true
          ? {
              toolbox: approvalToolbox(charges),
              stopWhen: stopWhen.some(stopWhen.pendingApproval(), stopWhen.noToolCalls()),
            }
          : {}),
      }),
    },
    a2aAgents: ['asker'],
  });
  const fixture = attachHandler(opened, {
    timers: (timers) => {
      realTimers = timers;
      return {
        ...timers,
        setTimeout: (callback, milliseconds) => {
          if (milliseconds !== SETTLE_POLL_MILLISECONDS)
            return timers.setTimeout(callback, milliseconds);
          armed.resolve();
          const handle = timers.setTimeout(() => undefined, NEVER_MILLISECONDS);
          held.push(handle);
          return handle;
        },
      };
    },
    ...(wrap?.bureau === undefined ? {} : { bureau: wrap.bureau }),
  });
  return {
    ...fixture,
    opened,
    armed: armed.promise,
    dispose: async () => {
      for (const handle of held) realTimers?.clearTimeout(handle);
      await opened.dispose();
    },
  };
}

function startMessage(extra: Record<string, unknown> = {}): A2AMessage {
  return Message.fromJSON({
    messageId: `m-${crypto.randomUUID()}`,
    role: 'ROLE_USER',
    parts: [{ text: 'go' }],
    ...extra,
  });
}

function blockingSend(fixture: Fixture, message: A2AMessage, context = fixture.context()) {
  return fixture.handler.sendMessage(
    { tenant: '', message, configuration: undefined, metadata: undefined },
    context,
  );
}

function taskOf(result: Task | A2AMessage): Task {
  if (!('status' in result)) throw new Error('expected a task');
  return result;
}

/** The id of the one task the Bureau holds. */
async function onlyTaskId(fixture: Fixture): Promise<string> {
  const page = await fixture.bureau.internals.taskRegistry.enumerate({
    limit: 10,
    offset: 0,
  });
  const [task] = page.tasks;
  if (task === undefined || page.tasks.length !== 1) throw new Error('expected exactly one task');
  return task.id;
}

describe('a blocking SendMessage whose safety-net poll never fires', () => {
  const rows: readonly Row[] = [
    {
      name: 'returns input-required when the run parks on durable human input',
      generate: afterArmed(parksOnHumanInput),
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
    },
    {
      name: 'returns input-required when the run parks on a tool approval',
      generate: afterArmed(chargesOnce),
      tools: true,
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
    },
    {
      name: 'returns completed when the run completes',
      generate: afterArmed(async () => ({ content: 'done', toolCalls: [] })),
      state: TaskState.TASK_STATE_COMPLETED,
    },
    {
      name: 'returns failed when the run fails',
      generate: afterArmed(async () => {
        throw new Error('the model failed');
      }),
      state: TaskState.TASK_STATE_FAILED,
    },
    {
      name: 'returns canceled when the task is canceled',
      generate: (gates) => async (context) => {
        await gates.armed;
        return holdsUntilAborted(context);
      },
      act: async (fixture) => {
        await fixture.bureau.tasks.cancel(await onlyTaskId(fixture));
      },
      state: TaskState.TASK_STATE_CANCELED,
    },
  ];

  it.each(rows)('$name', async (row) => {
    const fixture = await openFixture(row);
    try {
      const sent = blockingSend(fixture, startMessage());
      if (row.act !== undefined) {
        await fixture.armed;
        await row.act(fixture);
      }

      expect(taskOf(await sent).status?.state).toBe(row.state);
    } finally {
      await fixture.dispose();
    }
  });

  it('returns the working task when the caller aborts while it waits', async () => {
    const fixture = await openFixture({ generate: () => holdsUntilAborted });
    try {
      const controller = new AbortController();
      const context = fixture.context();
      context.state.set(REQUEST_SIGNAL_STATE_KEY, controller.signal);
      const sent = blockingSend(fixture, startMessage(), context);
      await fixture.armed;

      controller.abort();

      expect(taskOf(await sent).status?.state).toBe(TaskState.TASK_STATE_WORKING);
    } finally {
      await fixture.dispose();
    }
  });

  it('answers TIMEOUT when the command’s deadline overtakes the park, and the task goes on', async () => {
    const fixture = await openFixture({ generate: () => holdsUntilAborted });
    try {
      const deadline = new Date(Date.now() + 50).toISOString();
      const message = startMessage({
        metadata: { [COMMAND_RECEIPTS_EXTENSION_URI]: { deadline } },
      });

      const sent = blockingSend(
        fixture,
        message,
        fixture.context([A2UI_EXTENSION_URI, COMMAND_RECEIPTS_EXTENSION_URI]),
      );

      expect(await rejectionOf(sent)).toMatchObject({ name: 'CommandTimeoutError' });
      const view = await fixture.bureau.internals.taskRegistry.get(await onlyTaskId(fixture));
      expect(view?.status).toBe('working');
    } finally {
      await fixture.dispose();
    }
  });

  it('reads the task again at once when a park lands while the task is being read', async () => {
    const parked = Promise.withResolvers<void>();
    let listening = false;
    let reads = 0;
    const fixture = await openFixture(
      {
        generate: () => async (context) => {
          await parked.promise;
          return parksOnHumanInput(context);
        },
      },
      {
        bureau: (bureau) => {
          const registry = bureau.internals.taskRegistry;
          const stand = Object.create(registry, {
            onChanged: {
              value: (...args: Parameters<typeof registry.onChanged>) => {
                listening = true;
                return registry.onChanged(...args);
              },
            },
            get: {
              value: async (id: string) => {
                const view = await registry.get(id);
                if (!listening || reads > 0 || view === undefined) return view;
                reads += 1;
                // The task parks after this read began, and is announced before it returns the
                // stale view: the handler must read it again rather than wait for the poll.
                parked.resolve();
                await waitUntil(async () => {
                  const current = await registry.get(id);
                  return current?.status === 'input-required';
                });
                await registry.announceChanged(id);
                return view;
              },
            },
          });
          return Object.create(bureau, {
            internals: {
              value: Object.create(bureau.internals, { taskRegistry: { value: stand } }),
            },
          });
        },
      },
    );
    try {
      const sent = await blockingSend(fixture, startMessage());

      expect(taskOf(sent).status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
      expect(reads).toBe(1);
    } finally {
      await fixture.dispose();
    }
  });

  it('announces a park nobody is listening for without error', async () => {
    const fixture = await openFixture({ generate: afterArmed(parksOnHumanInput) });
    try {
      const parked = taskOf(await blockingSend(fixture, startMessage()));
      const registry = fixture.bureau.internals.taskRegistry;

      expect(await registry.announceChanged(parked.id)).toBeUndefined();
      expect(await registry.announceChanged('no-such-task')).toBeUndefined();
    } finally {
      await fixture.dispose();
    }
  });
});
