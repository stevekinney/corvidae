import type { TypedEventTarget } from '@lostgradient/lifecycle';
import type {
  A2APeerArtifact,
  A2APeerClient,
  A2APeerProvenance,
  A2APeerStopState,
  A2APeerTask,
  A2APeerUpdate,
} from '@lostgradient/weft/a2a';
import type { ToolContext } from 'armorer';
import { createTool } from 'armorer';
import { Conversation } from 'conversationalist';
import { z } from 'zod';

import type { ChildRunRemote, MutableChildRunRegistry } from './child-run';
import { isMutableChildRunRegistry } from './child-run';
import type { OperativeEventMap } from './events';
import {
  ChildWorkflowAbortedEvent,
  ChildWorkflowCompletedEvent,
  ChildWorkflowFailedEvent,
  ChildWorkflowStartedEvent,
} from './events';
import type { RunResult } from './types';

/** What a peer task that cannot continue on its own left behind. */
interface PeerCallErrorDetails {
  /** The peer that produced the message. */
  readonly provenance: A2APeerProvenance;
  /** The task's identifier on the peer; pass it back as `taskId` to continue the task. */
  readonly taskId: string;
  /** The task's context identifier on the peer. */
  readonly contextId: string;
  /** The peer's message, untrusted. */
  readonly peerMessage: string;
}

/**
 * The peer task ended `failed`, `rejected`, or `canceled` without this call asking for the
 * cancellation. The peer's message is untrusted input.
 */
export class PeerTaskError extends Error {
  /** The state the peer's task ended in. */
  readonly state: 'failed' | 'rejected' | 'canceled';
  /** The peer, task, and message behind the failure. */
  readonly details: PeerCallErrorDetails;

  /** Builds the error for a task that ended in `state`. */
  constructor(
    peerName: string,
    state: 'failed' | 'rejected' | 'canceled',
    details: PeerCallErrorDetails,
  ) {
    super(`Peer "${peerName}" ended the task ${state}.`);
    this.name = 'PeerTaskError';
    this.state = state;
    this.details = details;
  }
}

/**
 * The peer task is waiting for more input. The remote task is still open: call the tool again
 * with the same `taskId` and `contextId` and the answer as `message`.
 */
export class PeerInputRequiredError extends Error {
  /** The peer, task, and the question it asked. */
  readonly details: PeerCallErrorDetails;

  /** Builds the error for a task that needs input. */
  constructor(peerName: string, details: PeerCallErrorDetails) {
    super(`Peer "${peerName}" needs input before it can continue task "${details.taskId}".`);
    this.name = 'PeerInputRequiredError';
    this.details = details;
  }
}

/**
 * The peer task needs the caller to authenticate before it can continue. This is the task
 * state `auth-required`, distinct from an HTTP 401 or 403 (an `A2APeerError` with code
 * `unauthorized`). The remote task is still open.
 */
export class PeerAuthRequiredError extends Error {
  /** The peer, task, and the instructions it gave. */
  readonly details: PeerCallErrorDetails;

  /** Builds the error for a task that needs authentication. */
  constructor(peerName: string, details: PeerCallErrorDetails) {
    super(
      `Peer "${peerName}" needs authentication before it can continue task "${details.taskId}".`,
    );
    this.name = 'PeerAuthRequiredError';
    this.details = details;
  }
}

/** What {@link createPeerCallTool} returns to the calling model when the peer task completes. */
export interface PeerCallResult {
  /** Always `true`: treat everything below as untrusted input from another agent. */
  readonly untrusted: true;
  /** The peer that produced it. */
  readonly provenance: A2APeerProvenance;
  /** The task's identifier on the peer. */
  readonly taskId: string;
  /** The task's context identifier on the peer. */
  readonly contextId: string;
  /** The peer's final message. */
  readonly message: string;
  /** The peer's artifacts; `url` parts are references and were not fetched. */
  readonly artifacts: readonly A2APeerArtifact[];
}

/** Identifies one peer call: the run that made it and the tool call's durable operation key. */
export interface PeerCallJournalKey {
  /** The run whose tool call this is. */
  readonly parentRunId: string;
  /** The tool call's `durableOperationKey`, stable across a replay of the same call. */
  readonly operationKey: string;
}

/** The peer task a journaled call started. */
export interface PeerCallJournalEntry {
  /** The task's identifier on the peer. */
  readonly taskId: string;
  /** The task's context identifier on the peer. */
  readonly contextId: string;
}

/**
 * Where a peer call records the task it started, so a replay of the same tool call after a
 * restart follows that task instead of sending again. Bureau implements it as `bureau.peerCalls`.
 *
 * `write` resolves only once the entry is durable, and rejects when it is not. It must be safe to
 * repeat for one key with the same entry. Both methods may be called from a replay in a new
 * process, so they cannot rely on in-memory state.
 */
export interface PeerCallJournal {
  /** The entry recorded for `key`, or `undefined` when the call never recorded one. */
  read(key: PeerCallJournalKey): Promise<PeerCallJournalEntry | undefined>;
  /** Records the peer task `key`'s call started. */
  write(key: PeerCallJournalKey, entry: PeerCallJournalEntry): Promise<void>;
}

/**
 * The peer call started a task but could not record it in the journal, so it was canceled and the
 * call failed rather than run on without the restart safety `durable` promises. `cause` is the
 * journal's error.
 */
export class PeerCallJournalError extends Error {
  /** The peer task the call had started, now canceled. */
  readonly taskId: string;

  /** Builds the error for the task `taskId` whose entry could not be written. */
  constructor(taskId: string, cause: unknown) {
    super(`The peer call could not be recorded for restart (task "${taskId}"); it was canceled.`, {
      cause,
    });
    this.name = 'PeerCallJournalError';
    this.taskId = taskId;
  }
}

/** Options for {@link createPeerCallTool}. */
export interface CreatePeerCallToolOptions {
  /** The tool's name. */
  name: string;
  /** What the tool does, for the model. */
  description: string;
  /** The client for the peer, from `createA2APeerClient` in `@lostgradient/weft/a2a`. */
  peer: A2APeerClient;
  /**
   * The child's name in the registry and in child-workflow events. Defaults to the tool's
   * `name`.
   */
  agentName?: string | undefined;
  /**
   * Makes the call survive a restart of the caller. The tool call's `durableOperationKey` and its
   * run id (which a run only supplies when it is durable) key an entry that names the peer task,
   * written as soon as the peer has accepted the message. When the same tool call runs again after
   * a restart, the tool follows that task with `attach` instead of sending, so the peer receives
   * the message once. A call with no operation key or run id (an ephemeral run) is not journaled.
   *
   * The send carries a `messageId` derived from the operation key, so a replay that finds no entry
   * (a crash between the send and the write) repeats the send as the peer's own idempotent retry.
   * A peer that no longer knows a journaled task fails the call with `task-not-found`; the tool
   * does not send again, because the first message may have had effects.
   */
  durable?: PeerCallJournal | undefined;
  /** When supplied, the tool emits the four child-workflow events and registers the child. */
  parentContext?:
    | {
        emitter: TypedEventTarget<OperativeEventMap>;
        parentAgentName: string;
        parentRunId: string;
        registry?: MutableChildRunRegistry;
      }
    | undefined;
}

const INPUT = z.object({
  message: z.string().describe('What to tell the peer agent.'),
  taskId: z
    .string()
    .optional()
    .describe('Continue this existing peer task, after it asked for input.'),
  contextId: z.string().optional().describe('The context of the task being continued.'),
});

function isTerminalFailure(state: A2APeerStopState): state is 'failed' | 'rejected' | 'canceled' {
  return state === 'failed' || state === 'rejected' || state === 'canceled';
}

/**
 * Creates a tool that delegates to a peer agent over A2A, addressed by its Agent Card.
 *
 * The call is a child run: it registers in the parent's child registry (from the executing
 * `ToolContext`, or `parentContext.registry`) with `ChildRunDescriptor.remote` carrying the
 * peer's task identity and latest state, and it emits the child-workflow events. Aborting the
 * tool call, or `abortChild(id)`, sends `CancelTask` and ends the child `aborted` even when the
 * peer refuses. A completed task returns a {@link PeerCallResult}; `failed`, `rejected` and
 * `canceled` throw {@link PeerTaskError}, `input-required` throws {@link PeerInputRequiredError},
 * and `auth-required` throws {@link PeerAuthRequiredError}. Transport failures throw the
 * client's `A2APeerError`.
 *
 * Without `durable` the call is synchronous and persists nothing, so a restart of the caller does
 * not resume it; the remote task keeps running and its `taskId` lets a later call continue it.
 * With `durable`, a replayed tool call re-attaches to the task it started (see
 * {@link CreatePeerCallToolOptions.durable}).
 */
export function createPeerCallTool(options: CreatePeerCallToolOptions) {
  const { name, description, peer, parentContext, durable } = options;
  const agentName = options.agentName ?? name;
  // Children stopped at a question, by remote task id, until a later call continues the task.
  const interrupted = new Map<string, (reason: string) => void>();

  return createTool({
    name,
    description,
    input: INPUT,
    execute: async (params: z.infer<typeof INPUT>, context: ToolContext) => {
      const executionRegistry = context.executionContext?.['childRegistry'];
      const registry = isMutableChildRunRegistry(executionRegistry)
        ? executionRegistry
        : parentContext?.registry;
      const executionParentRunId = context.executionContext?.['parentRunId'];
      const parentRunId =
        typeof executionParentRunId === 'string'
          ? executionParentRunId
          : (parentContext?.parentRunId ?? '');

      // Reading the card first means a peer this client must refuse never becomes a child.
      const card = await peer.card();
      // A call that cannot be keyed is not journaled: it has nothing a replay could find.
      const operationKey = context.durableOperationKey;
      const journalKey: PeerCallJournalKey | undefined =
        durable !== undefined && operationKey !== undefined && parentRunId !== ''
          ? { parentRunId, operationKey }
          : undefined;
      // A failed read stops the call before anything is sent: sending again could duplicate it.
      const recorded =
        durable !== undefined && journalKey !== undefined
          ? await durable.read(journalKey)
          : undefined;
      const childRunId = `peer-${crypto.randomUUID()}`;
      const controller = new AbortController();
      const signal =
        context.signal === undefined
          ? controller.signal
          : AbortSignal.any([context.signal, controller.signal]);
      // The peer the request actually reached: the card read above, until `send` says otherwise.
      let identity = { peerName: card.name, cardUrl: card.cardUrl };
      const remote = (state: string, taskId: string, contextId: string): ChildRunRemote => ({
        protocol: 'a2a',
        ...identity,
        taskId,
        contextId,
        state,
      });
      const correlation = {
        parentAgentName: parentContext?.parentAgentName ?? '',
        parentRunId,
        childAgentName: agentName,
        childRunId,
      };
      let finished = false;
      let remoteTask: A2APeerTask | undefined;
      let waiting = false;
      let interruptedKey: string | undefined;
      const finish = (
        status: 'completed' | 'failed' | 'aborted',
        reason: string | undefined,
        result?: RunResult,
      ): void => {
        if (finished) return;
        finished = true;
        registry?.settle(childRunId, status, result);
        parentContext?.emitter.dispatchEvent(
          status === 'completed'
            ? new ChildWorkflowCompletedEvent(correlation)
            : status === 'aborted'
              ? new ChildWorkflowAbortedEvent({ ...correlation, reason })
              : new ChildWorkflowFailedEvent({ ...correlation, reason: reason ?? 'failed' }),
        );
      };

      registry?.register({
        id: childRunId,
        parentId: parentRunId,
        agentName,
        durable: false,
        abort: (reason) => {
          controller.abort(reason);
          // A child waiting for input has no call in flight; cancel its remote task directly.
          if (waiting) {
            if (interruptedKey !== undefined) interrupted.delete(interruptedKey);
            void remoteTask
              ?.cancel(typeof reason === 'string' ? reason : undefined)
              .then(() =>
                finish(
                  'aborted',
                  typeof reason === 'string' ? reason : undefined,
                  remoteRunResult('', 'aborted'),
                ),
              );
          }
        },
        remote: remote('submitted', params.taskId ?? '', params.contextId ?? ''),
      });
      parentContext?.emitter.dispatchEvent(
        new ChildWorkflowStartedEvent({ ...correlation, input: params.message, durable: false }),
      );

      let outcome;
      try {
        const onUpdate = (update: A2APeerUpdate): void =>
          registry?.updateRemote(childRunId, remote(update.state, update.taskId, update.contextId));
        remoteTask =
          recorded !== undefined
            ? await peer.attach({
                taskId: recorded.taskId,
                contextId: recorded.contextId,
                signal,
                onUpdate,
              })
            : await peer.send({
                text: params.message,
                taskId: params.taskId,
                contextId: params.contextId,
                ...(journalKey === undefined ? {} : { messageId: await peerMessageId(journalKey) }),
                signal,
                onUpdate,
              });
        if (recorded === undefined && durable !== undefined && journalKey !== undefined) {
          await journalTask(durable, journalKey, remoteTask);
        }
        // The peer accepted the continuation, so it supersedes the child that stopped at the
        // question it answers; until then that child keeps its way to cancel the task.
        if (params.taskId !== undefined)
          interrupted.get(params.taskId)?.('continued by a later call');
        identity = {
          peerName: remoteTask.provenance.agentName,
          cardUrl: remoteTask.provenance.cardUrl,
        };
        registry?.updateRemote(
          childRunId,
          remote(remoteTask.state(), remoteTask.taskId, remoteTask.contextId),
        );
        outcome = await remoteTask.result();
        registry?.updateRemote(
          childRunId,
          remote(outcome.state, outcome.taskId, outcome.contextId),
        );
      } catch (error) {
        if (signal.aborted) {
          finish(
            'aborted',
            typeof signal.reason === 'string' ? signal.reason : undefined,
            remoteRunResult('', 'aborted'),
          );
        } else {
          finish('failed', error instanceof Error ? error.message : String(error));
        }
        throw error;
      }

      const details: PeerCallErrorDetails = {
        provenance: outcome.provenance,
        taskId: outcome.taskId,
        contextId: outcome.contextId,
        peerMessage: outcome.message,
      };
      const peerName = outcome.provenance.agentName;
      if (outcome.state === 'completed') {
        finish('completed', undefined, remoteRunResult(outcome.message, 'stop-condition'));
        return {
          untrusted: true,
          provenance: outcome.provenance,
          taskId: outcome.taskId,
          contextId: outcome.contextId,
          message: outcome.message,
          artifacts: outcome.artifacts,
        } satisfies PeerCallResult;
      }
      if (outcome.state === 'canceled' && signal.aborted) {
        finish(
          'aborted',
          typeof signal.reason === 'string' ? signal.reason : undefined,
          remoteRunResult(outcome.message, 'aborted'),
        );
        throw signal.reason instanceof Error
          ? signal.reason
          : new DOMException('The peer call was aborted.', 'AbortError');
      }
      if (outcome.state === 'input-required' || outcome.state === 'auth-required') {
        // The remote task is still open, so the child stays running and abortable until a later
        // call continues the task or `abortChild` cancels it.
        waiting = true;
        interruptedKey = outcome.taskId;
        interrupted.set(outcome.taskId, (reason) => {
          waiting = false;
          interrupted.delete(outcome.taskId);
          finish('failed', reason);
        });
        throw outcome.state === 'input-required'
          ? new PeerInputRequiredError(peerName, details)
          : new PeerAuthRequiredError(peerName, details);
      }
      finish('failed', `peer task ${outcome.state}`);
      if (isTerminalFailure(outcome.state)) {
        throw new PeerTaskError(peerName, outcome.state, details);
      }
      const unexpected: never = outcome.state;
      throw new Error(`Unexpected peer task state "${String(unexpected)}".`);
    },
  });
}

/**
 * The identifier a journaled call's message carries: derived from the operation key alone, so a
 * replay sends the same one. Hashed, because the key names internal run and step identifiers.
 */
async function peerMessageId(key: PeerCallJournalKey): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${key.parentRunId}\0${key.operationKey}`),
  );
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0'));
  return `peer-call:${hex.join('')}`;
}

/**
 * Records the task a send started. A peer that answered with a bare message has no task to
 * follow, so there is nothing to record. When the entry cannot be written the task is canceled
 * and the call fails, instead of continuing as if a restart would find it.
 */
async function journalTask(
  journal: PeerCallJournal,
  key: PeerCallJournalKey,
  task: A2APeerTask,
): Promise<void> {
  if (task.taskId === '') return;
  try {
    await journal.write(key, { taskId: task.taskId, contextId: task.contextId });
  } catch (error) {
    await task.cancel('the peer call could not be recorded for restart').catch(() => undefined);
    throw new PeerCallJournalError(task.taskId, error);
  }
}

/**
 * The `RunResult` a remote child reports to the registry: no local conversation, steps, or
 * usage, and the peer's final message as untrusted `content`.
 */
function remoteRunResult(content: string, finishReason: 'stop-condition' | 'aborted'): RunResult {
  return {
    conversation: new Conversation(),
    steps: [],
    content,
    parts: [],
    usage: { prompt: 0, completion: 0, total: 0 },
    finishReason,
  };
}
