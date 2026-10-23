/**
 * One task on an A2A peer: sends the first message, follows the task by streaming (with
 * `SubscribeToTask` reconnects) or by polling `GetTask`, and cancels it.
 *
 * @module a2a/peer-task
 */

import { Role, type Message, type SendMessageRequest, type Task } from '@a2a-js/sdk';
import type { Client, RequestOptions } from '@a2a-js/sdk/client';

import type {
  A2APeerOutcome,
  A2APeerProvenance,
  A2APeerSendRequest,
  A2APeerTask,
  A2APeerTaskState,
} from './peer-client-types.ts';
import { A2APeerError } from './peer-client-types.ts';
import { isTerminalState, PeerTaskTracker, type PeerStreamEvent } from './peer-task-tracker.ts';

/** The bounds and collaborators one peer task runs with. */
export interface PeerTaskContext {
  /** The SDK client for the selected interface. */
  readonly client: Client;
  /** Whether to stream (the card advertised it) or poll. */
  readonly streaming: boolean;
  /** The peer's identity, without a task id. */
  readonly peer: Omit<A2APeerProvenance, 'taskId'>;
  /** Request options (extension headers) for every call; `signal` is added per call. */
  readonly requestOptions: RequestOptions;
  /** Media types the client accepts back. */
  readonly acceptedOutputModes: readonly string[];
  /** Attempts per request, including the first. */
  readonly attempts: number;
  /** Delay before the first retry; doubles per attempt. */
  readonly baseDelayMs: number;
  /** The longest delay between retries or polls. */
  readonly maxDelayMs: number;
  /** Delay before the first `GetTask` poll; doubles to `maxDelayMs`. */
  readonly pollIntervalMs: number;
  /** How long `result()` may wait for the task to stop. */
  readonly taskTimeoutMs: number;
  /** The most artifact content kept per artifact. */
  readonly artifactLimit: number;
  /** Waits `ms`, resolving early when `signal` aborts. */
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Turns anything an SDK call threw into an {@link A2APeerError}. */
  readonly classify: (error: unknown) => A2APeerError;
}

type EventStream = AsyncGenerator<PeerStreamEvent, void, undefined>;

function userMessage(text: string, taskId: string, contextId: string): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId,
    taskId,
    role: Role.ROLE_USER,
    parts: [
      {
        content: { $case: 'text', value: text },
        metadata: undefined,
        filename: '',
        mediaType: 'text/plain',
      },
    ],
    metadata: undefined,
    extensions: [],
    referenceTaskIds: [],
  };
}

function isTask(value: Message | Task): value is Task {
  return 'status' in value;
}

class PeerTaskRun implements A2APeerTask {
  private readonly follow = new AbortController();
  private stream: EventStream | undefined;
  private reconnects = 0;
  private pollDelay: number;
  private timedOut = false;
  private settled: Promise<A2APeerOutcome> | undefined;
  private cancelling: Promise<A2APeerOutcome> | undefined;
  private readonly context: PeerTaskContext;
  private readonly tracker: PeerTaskTracker;

  constructor(context: PeerTaskContext, tracker: PeerTaskTracker) {
    this.context = context;
    this.tracker = tracker;
    this.pollDelay = context.pollIntervalMs;
  }

  get taskId(): string {
    return this.tracker.taskId();
  }

  get contextId(): string {
    return this.tracker.contextId();
  }

  get provenance(): A2APeerProvenance {
    return this.tracker.provenance();
  }

  state(): A2APeerTaskState {
    return this.tracker.state();
  }

  /** The first request: a streaming peer opens its stream here, a polling peer answers at once. */
  async open(request: SendMessageRequest): Promise<void> {
    if (this.context.streaming) {
      const first = await this.withRetry(async () => {
        const opened = this.context.client.sendMessageStream(request, this.callOptions());
        const head = await opened.next();
        if (head.done === true) {
          throw new A2APeerError('protocol', 'The peer closed the stream without a response.');
        }
        return { opened, head: head.value };
      });
      this.stream = first.opened;
      this.tracker.apply(first.head);
    } else {
      const response = await this.withRetry(() =>
        this.context.client.sendMessage(request, this.callOptions()),
      );
      if (isTask(response)) this.tracker.applyTask(response);
      else this.tracker.apply({ payload: { $case: 'message', value: response } });
    }
    this.tracker.markHeadSeen();
  }

  result(): Promise<A2APeerOutcome> {
    this.settled ??= this.settle();
    return this.settled;
  }

  cancel(reason?: string): Promise<A2APeerOutcome> {
    this.cancelling ??= this.doCancel(reason);
    return this.cancelling;
  }

  private callOptions(): RequestOptions {
    return { ...this.context.requestOptions, signal: this.follow.signal };
  }

  private backoff(attempt: number): number {
    return Math.min(this.context.baseDelayMs * 2 ** (attempt - 1), this.context.maxDelayMs);
  }

  private async withRetry<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        const classified = this.context.classify(error);
        const exhausted = attempt >= this.context.attempts || signal?.aborted === true;
        if (!classified.retryable || exhausted) throw classified;
        await this.context.sleep(this.backoff(attempt), signal);
      }
    }
  }

  private closeStream(): void {
    const open = this.stream;
    this.stream = undefined;
    open?.return().catch(() => undefined);
  }

  private async settle(): Promise<A2APeerOutcome> {
    const timer = setTimeout(() => {
      this.timedOut = true;
      this.follow.abort();
    }, this.context.taskTimeoutMs);
    try {
      await this.followTask();
      if (this.timedOut) return await this.failOnTimeout();
      return this.cancelling === undefined ? this.tracker.outcome() : await this.cancelling;
    } finally {
      clearTimeout(timer);
      this.closeStream();
    }
  }

  private async failOnTimeout(): Promise<never> {
    if (!this.tracker.stopped()) await this.cancel('task timeout');
    throw new A2APeerError(
      'timeout',
      `The peer task did not stop within ${this.context.taskTimeoutMs} ms; it was canceled.`,
    );
  }

  private async followTask(): Promise<void> {
    const aborted = new Promise<'aborted'>((resolve) => {
      if (this.follow.signal.aborted) resolve('aborted');
      else this.follow.signal.addEventListener('abort', () => resolve('aborted'), { once: true });
    });
    while (!this.tracker.stopped() && !this.follow.signal.aborted) {
      try {
        await this.step(aborted);
      } catch (error) {
        this.recoverFromStepError(error);
      }
    }
  }

  private async step(aborted: Promise<'aborted'>): Promise<void> {
    if (this.stream !== undefined) return this.readStream(aborted);
    if (this.canResubscribe()) return this.resubscribe();
    return this.poll();
  }

  private canResubscribe(): boolean {
    return this.context.streaming && this.reconnects < this.context.attempts && this.taskId !== '';
  }

  private async readStream(aborted: Promise<'aborted'>): Promise<void> {
    const next = await Promise.race([this.stream?.next(), aborted]);
    if (next === 'aborted') return this.closeStream();
    if (next === undefined || next.done === true) {
      this.stream = undefined;
      return;
    }
    // A resubscribed stream opens with a snapshot of the task; only a later event is progress,
    // so a stream that opens and closes with nothing new keeps spending attempts.
    if (next.value.payload?.$case !== 'task') this.reconnects = 0;
    this.tracker.apply(next.value);
  }

  private async resubscribe(): Promise<void> {
    this.reconnects += 1;
    if (this.reconnects > 1) {
      await this.context.sleep(this.backoff(this.reconnects - 1), this.follow.signal);
    }
    if (this.follow.signal.aborted) return;
    this.stream = this.context.client.resubscribeTask(
      { tenant: '', id: this.taskId },
      this.callOptions(),
    );
  }

  private async poll(): Promise<void> {
    await this.context.sleep(this.pollDelay, this.follow.signal);
    this.pollDelay = Math.min(this.pollDelay * 2, this.context.maxDelayMs);
    if (this.follow.signal.aborted) return;
    const task = await this.withRetry(() => this.getTask(this.callOptions()), this.follow.signal);
    this.tracker.applyTask(task);
  }

  private getTask(options: RequestOptions): Promise<Task> {
    return this.context.client.getTask(
      { tenant: '', id: this.taskId, historyLength: undefined },
      options,
    );
  }

  /** A broken stream is replaced; anything else ends the wait. */
  private recoverFromStepError(error: unknown): void {
    if (this.follow.signal.aborted) return;
    const classified = this.context.classify(error);
    const recoverable = classified.retryable || classified.code === 'protocol';
    if (this.stream === undefined || !recoverable) throw classified;
    this.closeStream();
  }

  private async doCancel(reason?: string): Promise<A2APeerOutcome> {
    if (this.tracker.isCanceledLocally() || this.tracker.isTerminal()) {
      return this.tracker.outcome();
    }
    this.follow.abort();
    this.closeStream();
    if (this.taskId === '') {
      this.tracker.cancelLocally({ confirmed: false, error: 'the peer has not named the task' });
      return this.tracker.outcome();
    }
    try {
      await this.sendCancel(reason);
    } catch (error) {
      await this.recoverFromCancelError(this.context.classify(error));
    }
    return this.tracker.outcome();
  }

  private async sendCancel(reason: string | undefined): Promise<void> {
    const task = await this.withRetry(() =>
      this.context.client.cancelTask(
        {
          tenant: '',
          id: this.taskId,
          metadata: reason === undefined ? undefined : { reason },
        },
        this.context.requestOptions,
      ),
    );
    this.tracker.applyTask(task);
    if (this.tracker.state() === 'canceled') this.tracker.cancelLocally({ confirmed: true });
    else if (!this.tracker.isTerminal()) {
      this.tracker.cancelLocally({
        confirmed: false,
        error: `the peer left the task ${this.tracker.state()}`,
      });
    }
  }

  private async recoverFromCancelError(error: A2APeerError): Promise<void> {
    this.tracker.cancelLocally({ confirmed: false, error: error.message });
    if (error.code !== 'task-not-cancelable') return;
    // The task may have finished first; report the state it is really in.
    try {
      this.tracker.applyTask(await this.getTask(this.context.requestOptions));
      const remote = this.tracker.remoteState();
      if (isTerminalState(remote) && remote !== 'canceled') this.tracker.clearLocalCancel();
    } catch {
      // Keep the local cancellation.
    }
  }
}

/**
 * Sends `request` to the peer and resolves with the task once the peer has named it. The
 * message identifier is fixed before the first attempt, so retrying a send that may have reached
 * the peer is the retry the A2A spec describes, not a second message.
 */
export async function startPeerTask(
  context: PeerTaskContext,
  input: A2APeerSendRequest,
): Promise<A2APeerTask> {
  // The caller owns `input` and may change it while the first request is in flight.
  const request = { ...input };
  if (typeof request.text !== 'string') {
    throw new TypeError('A2APeerSendRequest.text must be a string.');
  }
  const tracker = new PeerTaskTracker(
    context.peer,
    request,
    context.artifactLimit,
    request.taskId !== undefined,
  );
  const run = new PeerTaskRun(context, tracker);
  await run.open({
    tenant: '',
    message: userMessage(request.text, request.taskId ?? '', request.contextId ?? ''),
    configuration: {
      acceptedOutputModes: [...context.acceptedOutputModes],
      taskPushNotificationConfig: undefined,
      historyLength: 0,
      returnImmediately: !context.streaming,
    },
    metadata: undefined,
  });
  const signal = request.signal;
  if (signal !== undefined) {
    const onAbort = (): void => {
      void run.cancel(typeof signal.reason === 'string' ? signal.reason : undefined);
    };
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }
  return run;
}
