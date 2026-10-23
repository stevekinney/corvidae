/**
 * What this client knows about one peer task: the latest snapshot, state, and message, folded
 * from the responses and stream events it has seen.
 *
 * @module a2a/peer-task-tracker
 */

import { TaskState, type Message, type StreamResponse, type Task } from '@a2a-js/sdk';

import type {
  A2APeerArtifact,
  A2APeerOutcome,
  A2APeerProvenance,
  A2APeerSendRequest,
  A2APeerStopState,
  A2APeerTaskState,
} from './peer-client-types.ts';
import {
  ingestArtifactUpdate,
  ingestIdentity,
  ingestMessageText,
  ingestStatus,
  ingestTask,
  type IngestedStatus,
} from './peer-ingest.ts';
import { isStopState } from './peer-parts.ts';

/** One event on a task stream or subscription. */
export type PeerStreamEvent = StreamResponse;

/** How a locally recorded cancellation ended. */
export interface LocalCancel {
  readonly confirmed: boolean;
  readonly error?: string | undefined;
}

function emptyTask(id: string, contextId: string): Task {
  return {
    id,
    contextId,
    status: { state: TaskState.TASK_STATE_WORKING, message: undefined, timestamp: undefined },
    artifacts: [],
    history: [],
    metadata: undefined,
  };
}

/** Whether `state` is one the task never leaves. */
export function isTerminalState(state: A2APeerTaskState): boolean {
  return (
    state === 'completed' || state === 'failed' || state === 'canceled' || state === 'rejected'
  );
}

/** Tracks one peer task for {@link startPeerTask}. */
export class PeerTaskTracker {
  private snapshot: Task | undefined;
  private artifacts: A2APeerArtifact[] = [];
  private lastMessage = '';
  private current: A2APeerTaskState = 'submitted';
  private cancellation: LocalCancel | undefined;
  private fresh: boolean;
  private headSeen = false;
  private stamp = '';
  private headStamp = '';

  /**
   * `awaitFollowUp` is true for a continuation, whose first response is a snapshot of the
   * state the task was in before the new message: a stop state counts only once the status differs from that snapshot.
   */
  constructor(
    private readonly peer: Omit<A2APeerProvenance, 'taskId'>,
    private readonly request: A2APeerSendRequest,
    private readonly artifactLimit: number,
    awaitFollowUp: boolean,
  ) {
    this.fresh = !awaitFollowUp;
  }

  /** The task's identifier on the peer. */
  taskId(): string {
    return this.snapshot?.id ?? '';
  }

  /** The task's context identifier. */
  contextId(): string {
    return this.snapshot?.contextId ?? this.request.contextId ?? '';
  }

  /** The peer and task. */
  provenance(): A2APeerProvenance {
    return { ...this.peer, taskId: this.taskId() };
  }

  /** The latest state, `canceled` once cancelled here. */
  state(): A2APeerTaskState {
    return this.cancellation === undefined ? this.current : 'canceled';
  }

  /** The latest state the peer reported, ignoring any cancellation made here. */
  remoteState(): A2APeerTaskState {
    return this.current;
  }

  /** Whether the task is cancelled here, or has stopped in a state that counts. */
  stopped(): boolean {
    return this.cancellation !== undefined || (this.fresh && isStopState(this.current));
  }

  /** Whether the task is in a state it never leaves. */
  isTerminal(): boolean {
    return isTerminalState(this.state());
  }

  /** Records that the first response has been applied. */
  markHeadSeen(): void {
    this.headSeen = true;
    this.headStamp = this.stamp;
  }

  /** Whether the task is cancelled here. */
  isCanceledLocally(): boolean {
    return this.cancellation !== undefined;
  }

  /** Records a cancellation made here. */
  cancelLocally(cancel: LocalCancel): void {
    this.cancellation = cancel;
    this.emit();
  }

  /** Forgets a local cancellation, because the peer reported a different terminal state. */
  clearLocalCancel(): void {
    this.cancellation = undefined;
    this.emit();
  }

  /** Applies a whole task, from `GetTask`, `CancelTask`, or a bare response. */
  applyTask(task: Task): void {
    const ingested = ingestTask(task, this.artifactLimit);
    // The snapshot keeps identity only; status, content, and history are bounded on the way in.
    this.snapshot = emptyTask(ingested.taskId, ingested.contextId);
    this.artifacts = ingested.artifacts;
    this.setStatus(ingested.status);
  }

  /** Applies one stream event. */
  apply(event: PeerStreamEvent): void {
    const payload = event.payload;
    if (payload === undefined) return;
    // A status event after the first response is new by definition; artifacts and messages do
    // not change whether the task is still waiting.
    if (this.headSeen && payload.$case === 'statusUpdate') this.fresh = true;
    switch (payload.$case) {
      case 'task':
        this.applyTask(payload.value);
        return;
      case 'message':
        this.applyMessage(payload.value);
        return;
      case 'statusUpdate': {
        const identity = ingestIdentity(payload.value.taskId, payload.value.contextId);
        this.snapshot ??= emptyTask(identity.taskId, identity.contextId);
        this.setStatus(ingestStatus(payload.value.status, this.artifactLimit));
        return;
      }
      case 'artifactUpdate':
        this.applyArtifact(payload.value);
        return;
    }
  }

  /** Where the task stopped, as the caller sees it. */
  outcome(): A2APeerOutcome {
    const canceled = this.cancellation;
    const state: A2APeerStopState = canceled === undefined ? stopStateOf(this.current) : 'canceled';
    return {
      untrusted: true,
      state,
      taskId: this.taskId(),
      contextId: this.contextId(),
      provenance: this.provenance(),
      message: this.lastMessage,
      artifacts: this.artifacts,
      ...(canceled === undefined
        ? {}
        : {
            cancelConfirmed: canceled.confirmed,
            ...(canceled.error === undefined ? {} : { cancelError: canceled.error }),
          }),
    };
  }

  private applyMessage(message: Message): void {
    this.lastMessage = ingestMessageText(message, this.artifactLimit);
    if (this.snapshot !== undefined) return;
    const identity = ingestIdentity(message.taskId, message.contextId);
    this.snapshot = emptyTask(identity.taskId, identity.contextId);
    this.current = 'completed';
    // A bare reply is the peer's whole answer, so it counts at once even to a continuation.
    this.fresh = true;
    this.emit();
  }

  private applyArtifact(update: {
    taskId: string;
    contextId: string;
    artifact: Task['artifacts'][number] | undefined;
    append: boolean;
  }): void {
    if (update.artifact === undefined) return;
    const identity = ingestIdentity(update.taskId, update.contextId);
    this.snapshot ??= emptyTask(identity.taskId, identity.contextId);
    this.artifacts = ingestArtifactUpdate(
      this.artifacts,
      update.artifact,
      update.append,
      this.artifactLimit,
    );
  }

  private setStatus(status: IngestedStatus): void {
    this.current = status.state;
    this.stamp = status.stamp;
    if (this.headSeen && this.stamp !== this.headStamp) this.fresh = true;
    if (status.text !== undefined) this.lastMessage = status.text;
    this.emit();
  }

  private emit(): void {
    this.request.onUpdate?.({
      state: this.state(),
      taskId: this.taskId(),
      contextId: this.contextId(),
      message: this.lastMessage,
    });
  }
}

function stopStateOf(state: A2APeerTaskState): A2APeerStopState {
  return state === 'submitted' || state === 'working' ? 'failed' : state;
}
