/**
 * `SendMessage` and `SendStreamingMessage` for a workflow agent: a message without a
 * `taskId` starts the workflow, and a message with one is delivered to the signal the
 * workflow waits for.
 *
 * @module a2a/workflow-agent-messages
 */

import {
  type Message,
  type SendMessageRequest,
  type StreamResponse,
  type Task,
  TaskState,
} from '@a2a-js/sdk';
import {
  ContentTypeNotSupportedError,
  RequestMalformedError,
  TaskNotFoundError,
  UnsupportedOperationError,
} from '@a2a-js/sdk/errors';
import type { PushNotificationStore, ServerCallContext } from '@a2a-js/sdk/server';

import type { Engine } from '../core/engine.ts';
import { encodeStorageKeyComponent } from '../storage/key-encoding.ts';
import { withStreamEventCursor } from './stream-cursors.ts';
import { type StoredWorkflowTask, taskEventCursor, type TaskEventLog } from './task-event-log.ts';
import type { WorkflowAgentInputMode } from './workflow-agent-card.ts';
import {
  isSettledTaskState,
  isTerminalTaskState,
  statusUpdateEvent,
  withStatus,
} from './workflow-task-projection.ts';
import { taskOwnerOf, type WorkflowTaskRuntime } from './workflow-task-runtime.ts';

/** The metadata key on a continuation message that names the signal to deliver. */
export const SIGNAL_NAME_METADATA_KEY = 'signalName';

export type WorkflowAgentMessaging = {
  sendMessage(params: SendMessageRequest, context: ServerCallContext): Promise<Task>;
  sendMessageStream(
    params: SendMessageRequest,
    context: ServerCallContext,
  ): AsyncGenerator<StreamResponse, void, undefined>;
  /** Follow a task from its stored snapshot: the snapshot, then each later event. */
  follow(
    stored: StoredWorkflowTask,
    context: ServerCallContext,
    historyLength: number | undefined,
  ): AsyncGenerator<StreamResponse, void, undefined>;
};

/** Apply `historyLength`: absent keeps every message, `0` or less keeps none. */
export function withHistoryLength(task: Task, historyLength: number | undefined): Task {
  if (historyLength === undefined) return task;
  return { ...task, history: historyLength <= 0 ? [] : task.history.slice(-historyLength) };
}

/**
 * The workflow input or signal payload a message carries: its first data part for
 * `'data'`, its text parts concatenated for `'text'`.
 *
 * @throws {RequestMalformedError} When the message has no part of that kind.
 */
export function payloadOf(message: Message, inputMode: WorkflowAgentInputMode): unknown {
  if (inputMode === 'data') {
    for (const part of message.parts) {
      if (part.content?.$case === 'data') return part.content.value ?? null;
    }
    throw new RequestMalformedError('This agent reads a data part, and the message has none.');
  }
  const texts: string[] = [];
  for (const part of message.parts) {
    if (part.content?.$case === 'text') texts.push(part.content.value);
  }
  if (texts.length === 0) {
    throw new RequestMalformedError('This agent reads text parts, and the message has none.');
  }
  return texts.join('');
}

function requireMessage(params: SendMessageRequest, inputModes: readonly string[]): Message {
  const message = params.message;
  if (message === undefined || message.messageId === '') {
    throw new RequestMalformedError('message.messageId is required.');
  }
  for (const part of message.parts) {
    if (part.mediaType !== '' && !inputModes.includes(part.mediaType)) {
      throw new ContentTypeNotSupportedError(
        `Media type '${part.mediaType}' is not supported; this agent accepts ${inputModes.join(', ')}.`,
      );
    }
  }
  return message;
}

/** The signal a continuation delivers to: the one wait, or the one `signalName` names. */
function signalFor(message: Message, waits: readonly string[]): string {
  if (waits.length === 0) {
    throw new RequestMalformedError(
      'The task is not waiting for input, so it accepts no message until it asks for one.',
    );
  }
  const named: unknown = message.metadata?.[SIGNAL_NAME_METADATA_KEY];
  if (waits.length === 1 && named === undefined) return waits[0] as string;
  if (typeof named !== 'string' || !waits.includes(named)) {
    throw new RequestMalformedError(
      `Name the signal to deliver in metadata.${SIGNAL_NAME_METADATA_KEY}: one of ${waits.map((w) => `'${w}'`).join(', ')}.`,
    );
  }
  return named;
}

/** The state a status-update event moves its task to; `undefined` for any other event. */
function statusStateOf(event: StreamResponse): TaskState | undefined {
  return event.payload?.$case === 'statusUpdate' ? event.payload.value.status?.state : undefined;
}

function foreignMessage(message: Message): RequestMalformedError {
  return new RequestMalformedError(
    `messageId '${message.messageId}' already started another caller's task; send the message with a new messageId.`,
  );
}

function taskEvent(task: Task): StreamResponse {
  return { payload: { $case: 'task', value: task } };
}

export function createWorkflowAgentMessaging(options: {
  readonly engine: Engine;
  readonly workflowType: string;
  readonly inputMode: WorkflowAgentInputMode;
  /** The card's `defaultInputModes`: a part naming any other media type is refused. */
  readonly inputModes: readonly string[];
  readonly log: TaskEventLog;
  readonly runtime: WorkflowTaskRuntime;
  readonly pushStore: PushNotificationStore;
  readonly now: () => number;
}): WorkflowAgentMessaging {
  const { engine, workflowType, inputMode, inputModes, log, runtime, pushStore, now } = options;

  async function installPushConfiguration(
    params: SendMessageRequest,
    taskId: string,
    context: ServerCallContext,
  ): Promise<void> {
    const config = params.configuration?.taskPushNotificationConfig;
    if (config === undefined) return;
    await pushStore.save(taskId, context, { ...config, taskId });
  }

  /** Start (or, for a retried message, find) the workflow and its task. */
  async function start(
    message: Message,
    params: SendMessageRequest,
    context: ServerCallContext,
  ): Promise<StoredWorkflowTask> {
    const input = payloadOf(message, inputMode);
    const user = encodeStorageKeyComponent(context.user?.userName ?? '');
    const handle = await engine.start(workflowType, input, {
      idempotencyKey: `${user}:${message.messageId}`,
    });
    const taskId = handle.id;
    const workflowState = await engine.get(taskId);
    const scope = runtime.scopeOf(context);
    // The engine's idempotency keys span every workflow type and caller scope, so a key
    // another agent or tenant used first names a run that is not this caller's task.
    if (workflowState?.type !== workflowType) throw foreignMessage(message);
    if ((await log.read(scope, taskId)) === undefined) {
      await installPushConfiguration(params, taskId, context);
      const contextId = message.contextId === '' ? taskId : message.contextId;
      const submitted: Task = {
        id: taskId,
        contextId,
        status: undefined,
        artifacts: [],
        history: [{ ...message, taskId, contextId }],
        metadata: undefined,
      };
      const status = {
        state: TaskState.TASK_STATE_SUBMITTED,
        message: undefined,
        timestamp: new Date(now()).toISOString(),
      };
      const task = withStatus(submitted, status);
      const created = await log.create(scope, taskOwnerOf(context), {
        task,
        events: [statusUpdateEvent(task, status)],
      });
      if (created === 'foreign') throw foreignMessage(message);
      await runtime.publish(created, context);
    }
    const stored = await runtime.reconcile(taskId, context);
    if (stored === undefined) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    return stored;
  }

  /** Check a continuation and deliver it to the signal the workflow waits for. */
  async function continueTask(
    message: Message,
    context: ServerCallContext,
  ): Promise<StoredWorkflowTask> {
    const taskId = message.taskId;
    const current = await runtime.reconcile(taskId, context);
    if (current === undefined) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    const { task } = current;
    if (message.contextId !== '' && message.contextId !== task.contextId) {
      throw new RequestMalformedError(
        `contextId '${message.contextId}' does not match task '${taskId}' context '${task.contextId}'.`,
      );
    }
    if (isTerminalTaskState(task.status?.state)) {
      throw new UnsupportedOperationError(
        `Task ${taskId} is in a terminal state and accepts no more messages.`,
      );
    }
    const state = await engine.get(taskId);
    const signalName = signalFor(message, state === null ? [] : runtime.liveWaits(state));
    const payload = payloadOf(message, inputMode);

    const generation = runtime.beginDelivery(taskId);
    try {
      await engine.signal(taskId, signalName, payload);
    } catch (error) {
      runtime.abandonDelivery(taskId);
      throw error;
    }
    runtime.recordDelivery(taskId, signalName, generation);
    const userMessage: Message = { ...message, taskId, contextId: task.contextId };
    const timestamp = new Date(now()).toISOString();
    const commit = await log.commit(runtime.scopeOf(context), taskId, (stored) => {
      const history = [...stored.task.history, userMessage];
      const withMessage = { ...stored.task, history };
      if (stored.task.status?.state !== TaskState.TASK_STATE_INPUT_REQUIRED) {
        return { task: withMessage, events: [] };
      }
      const status = { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp };
      const next = withStatus(withMessage, status);
      return { task: next, events: [statusUpdateEvent(next, status)] };
    });
    await runtime.publish(commit, context);
    const stored = await runtime.reconcile(taskId, context);
    if (stored === undefined) throw new TaskNotFoundError(`Task not found: ${taskId}`);
    return stored;
  }

  function accept(params: SendMessageRequest, context: ServerCallContext) {
    const message = requireMessage(params, inputModes);
    return message.taskId === '' ? start(message, params, context) : continueTask(message, context);
  }

  async function* follow(
    stored: StoredWorkflowTask,
    context: ServerCallContext,
    historyLength: number | undefined,
  ): AsyncGenerator<StreamResponse, void, undefined> {
    const { task, sequence } = stored;
    yield withStreamEventCursor(
      taskEvent(withHistoryLength(task, historyLength)),
      taskEventCursor(sequence),
    );
    if (isTerminalTaskState(task.status?.state)) return;
    for await (const entry of log.follow(runtime.scopeOf(context), task.id, sequence)) {
      yield withStreamEventCursor(entry.event, entry.cursor);
      if (isTerminalTaskState(statusStateOf(entry.event))) return;
    }
  }

  /** The task once it settles (terminal or waiting on the caller), or at once. */
  async function settled(
    stored: StoredWorkflowTask,
    context: ServerCallContext,
    returnImmediately: boolean,
  ): Promise<Task> {
    if (returnImmediately || isSettledTaskState(stored.task.status?.state)) return stored.task;
    const scope = runtime.scopeOf(context);
    for await (const entry of log.follow(scope, stored.task.id, stored.sequence)) {
      if (isSettledTaskState(statusStateOf(entry.event))) break;
    }
    const latest = await log.read(scope, stored.task.id);
    return latest?.task ?? stored.task;
  }

  return {
    async sendMessage(params, context) {
      const stored = await accept(params, context);
      const task = await settled(stored, context, params.configuration?.returnImmediately === true);
      return withHistoryLength(task, params.configuration?.historyLength);
    },
    async *sendMessageStream(params, context) {
      const stored = await accept(params, context);
      yield* follow(stored, context, params.configuration?.historyLength);
    },
    follow,
  };
}
