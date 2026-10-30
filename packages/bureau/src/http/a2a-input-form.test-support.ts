/**
 * The Bureau, A2A handler and agent the COR-1487 input-form tests share.
 */
import { Message, type Task, TaskState } from '@a2a-js/sdk';
import { ServerCallContext } from '@a2a-js/sdk/server';
import { createDefaultRuntimeServices, type RuntimeTimers } from '@lostgradient/lifecycle';
import {
  createAgent,
  type GenerateContext,
  type GenerateFunction,
  type HumanInputSchema,
} from '@lostgradient/operative';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { principalFromApiKey } from '@lostgradient/weft';
import { expect } from 'bun:test';

import { A2UI_EXTENSION_URI } from '../a2ui/catalogs.ts';
import { createCommandLedger } from '../command-ledger.ts';
import type { TaskView } from '../task-registry.ts';
import type { Bureau } from '../types.ts';
import { createBureauAgentCard } from './a2a-agent-card.ts';
import {
  A2A_SEND_LEDGER_KEY_PREFIX,
  type A2ASendClaim,
  type A2ASendResult,
  BureauA2AUser,
  createBureauA2ARequestHandler,
} from './a2a-request-handler.ts';
import { createA2ATaskRecords } from './a2a-task-record.ts';
import { buildBureauHandlerHost } from './create-bureau-handler.ts';
import { openBureau } from './management/management-fixtures.test-support.ts';
import { respondToTask } from './management/tasks-respond-operation.ts';

export const deploySchema: HumanInputSchema = {
  type: 'object',
  properties: {
    environment: { type: 'string', enum: ['staging', 'production'] },
    replicas: { type: 'integer' },
  },
  required: ['environment'],
  additionalProperties: false,
};

export type Seen = { resumed: string[] };

export function parksThenAnswers(
  seen: Seen,
  signals: readonly string[] = ['deploy'],
): GenerateFunction {
  let calls = 0;
  return async (context: GenerateContext) => {
    calls += 1;
    const signal = signals[calls - 1];
    if (signal !== undefined) {
      return {
        content: '',
        toolCalls: [
          {
            id: `wait-${calls}`,
            name: 'requestHumanInput',
            arguments: { signalName: signal, prompt: 'Where should this deploy?' },
          },
        ],
      };
    }
    seen.resumed.push(JSON.stringify(context.conversation.current));
    return { content: 'done', toolCalls: [] };
  };
}

export async function statusOf(
  bureau: { internals: { taskRegistry: { get(id: string): Promise<TaskView | undefined> } } },
  id: string,
): Promise<string | undefined> {
  const view = await bureau.internals.taskRegistry.get(id);
  return view?.status;
}

export function userMessage(
  messageId: string,
  taskId: string,
  part: Record<string, unknown>,
): Message {
  return Message.fromJSON({ messageId, taskId, role: 'ROLE_USER', parts: [part] });
}

/**
 * The A2A request handler and the calls a test makes through it, over a Bureau that publishes the
 * agent `asker`. `wrap.timers` may wrap the runtime's timers, to hold the blocking send's
 * safety-net poll.
 */
export function attachHandler(
  opened: Awaited<ReturnType<typeof openBureau>>,
  wrap: {
    readonly timers?: (timers: RuntimeTimers) => RuntimeTimers;
    /** The Bureau the request handler is given, when a test stands between it and the real one. */
    readonly bureau?: (bureau: Bureau) => Bureau;
  } = {},
) {
  const bureau = opened.bureau;
  const runtime = createDefaultRuntimeServices();
  const host = buildBureauHandlerHost(bureau, ['asker']);
  const card = createBureauAgentCard({
    catalogName: 'asker',
    displayName: undefined,
    description: undefined,
    definitionRevision: 1,
    skillDescriptors: undefined,
    security: undefined,
    durableHistory: false,
    pushNotifications: false,
  });
  const handler = createBureauA2ARequestHandler({
    publicUrl: 'http://localhost',
    timers: wrap.timers?.(runtime.timers) ?? runtime.timers,
    agentName: 'asker',
    card: () => ({ ...card, supportedInterfaces: [], signatures: [] }),
    bureau: wrap.bureau?.(bureau) ?? bureau,
    records: createA2ATaskRecords(textValueStore(new MemoryStorage())),
    ledger: createCommandLedger<A2ASendClaim, A2ASendResult>({
      kv: textValueStore(new MemoryStorage()),
      keyPrefix: A2A_SEND_LEDGER_KEY_PREFIX,
      clock: runtime.clock,
      nextConflictId: () => runtime.identifiers.next('conflict'),
    }),
    respond: (principal, input) => respondToTask(host, principal, input),
  });
  const principal = principalFromApiKey({ subject: 'alice', scopes: [] });
  const context = (requestedExtensions: string[] = [A2UI_EXTENSION_URI]) =>
    new ServerCallContext({
      user: new BureauA2AUser(principal),
      requestedVersion: '1.0',
      requestedExtensions,
    });
  const read = (id: string, extensions: string[]) =>
    handler.getTask({ tenant: '', id, historyLength: undefined }, context(extensions));
  const send = (message: Message) =>
    handler.sendMessage(
      { tenant: '', message, configuration: undefined, metadata: undefined },
      context(),
    );
  const start = async (): Promise<Task> => {
    const parked = await send(
      Message.fromJSON({ messageId: 'm-start', role: 'ROLE_USER', parts: [{ text: 'deploy' }] }),
    );
    if (!('status' in parked)) throw new Error('expected a task');
    expect(parked.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    return parked;
  };
  return { bureau, host, principal, handler, send, start, read, context };
}

export async function open(
  schema: HumanInputSchema | undefined,
  signals: readonly string[] = ['deploy'],
  formSignals: readonly string[] = signals,
) {
  const seen: Seen = { resumed: [] };
  const opened = await openBureau({
    agents: {
      asker: createAgent({
        name: 'asker',
        generate: parksThenAnswers(seen, signals),
        maximumSteps: 100,
      }),
    },
    a2aAgents: ['asker'],
    // The schema is configured the way a host configures it: on the Bureau option, per signal.
    ...(schema === undefined
      ? {}
      : {
          humanInput: {
            inputSchemas: Object.fromEntries(formSignals.map((signal) => [signal, schema])),
          },
        }),
  });
  const fixture = attachHandler(opened);
  return { opened, ...fixture, seen };
}
