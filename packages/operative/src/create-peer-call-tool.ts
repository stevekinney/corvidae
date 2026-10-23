import type { TypedEventTarget } from '@lostgradient/lifecycle';
import type {
  A2APeerArtifact,
  A2APeerClient,
  A2APeerProvenance,
  A2APeerStopState,
  A2APeerTask,
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
 * The call is synchronous: nothing is persisted, so a restart of the caller does not resume it
 * and no restart safety is claimed. The remote task keeps running; its `taskId` lets a later
 * call continue it.
 */
export function createPeerCallTool(options: CreatePeerCallToolOptions) {
  const { name, description, peer, parentContext } = options;
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
        remoteTask = await peer.send({
          text: params.message,
          taskId: params.taskId,
          contextId: params.contextId,
          signal,
          onUpdate: (update) =>
            registry?.updateRemote(
              childRunId,
              remote(update.state, update.taskId, update.contextId),
            ),
        });
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
