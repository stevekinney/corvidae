import type { CleanupOutcome, OutputChannel } from '../protocol/messages.ts';
import {
  MAXIMUM_TERMINAL_DIMENSION,
  MINIMUM_TERMINAL_DIMENSION,
} from '../protocol/protocol-constants.ts';
import { OperationQueue } from './operation-queue.ts';
import { OutputBudget } from './output-budget.ts';
import { openSource, type OpenSource } from './output-source.ts';
import { deriveAuthority } from './session-authority.ts';
import { resolveSessionBudgets } from './session-budgets.ts';
import type { CancelTimer, SessionClock } from './session-clock.ts';
import type {
  AttachmentAuthority,
  AttachmentListener,
  AttachmentRejection,
  AttachRequest,
  AttachResult,
  CleanupState,
  CloseCause,
  ConnectionState,
  InputFailureReason,
  InputReceipt,
  OperationKind,
  OperationResultReason,
  ProcessBackend,
  ProcessState,
  SessionAttachment,
  SessionBudgets,
  SessionClosedSummary,
  SessionOptions,
  SessionProfile,
  SessionSnapshot,
  TerminalDimensions,
} from './session-types.ts';
import { attempt, combineOutcomes, settleWithin, type Settling } from './settle.ts';

type QueuedOperation =
  | { readonly sequence: number; readonly kind: 'input'; readonly bytes: Uint8Array }
  | {
      readonly sequence: number;
      readonly kind: 'resize';
      readonly columns: number;
      readonly rows: number;
    };

type OperationRequest =
  | { readonly kind: 'input'; readonly bytes: Uint8Array }
  | { readonly kind: 'resize'; readonly columns: number; readonly rows: number };

/** Mutable state of the one attachment a session ever issues. */
type AttachmentRuntime = {
  readonly authority: AttachmentAuthority;
  readonly listener: AttachmentListener;
  readonly queue: OperationQueue<QueuedOperation>;
  readonly output: OutputBudget;
  revoked: boolean;
  /** Set when the listener threw or rejected. A failed listener is never called again. */
  listenerFailed: boolean;
  inputBytes: number;
  nextSequence: number;
  pumping: boolean;
  inFlight: { readonly operation: QueuedOperation; readonly settling: Settling<void> } | undefined;
  cancelLiveness: CancelTimer;
  releaseControl: (() => void) | undefined;
};

type OperationOutcome = Extract<
  Parameters<AttachmentListener>[0],
  { readonly type: 'operationResult' }
>;

/** Closes that wait for accepted output to be parsed; every other cause freezes the attachment first. */
const NATURAL_CAUSES: ReadonlySet<CloseCause> = new Set(['process-exit', 'source-complete']);

function isDimension(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MINIMUM_TERMINAL_DIMENSION &&
    value <= MAXIMUM_TERMINAL_DIMENSION
  );
}

function byteLengthOf(operation: QueuedOperation): number {
  return operation.kind === 'input' ? operation.bytes.length : 0;
}

/**
 * One terminal session: a single ownership slot with one process, one output budget and at most
 * one attachment, ever. State is three independent axes (process, connection, cleanup) plus a
 * quarantine flag, so exit, disconnect and cleanup can race without any of them overwriting another.
 *
 * Lifetime in v1 is deliberately simple. The first attachment is issued a generation. When it is
 * revoked for any reason, whether stop, disconnect, liveness expiry, overflow, a backend failure or
 * a thrown callback, the session freezes input, runs the owner's cleanup policy and closes. It never
 * issues a second generation, replays input or respawns the process; a replacement is a new session
 * with a new identity, admitted by a `SessionSlot` only after this one's cleanup is complete.
 */
export class Session {
  readonly sessionId: string;
  readonly profile: SessionProfile;
  readonly dimensions: TerminalDimensions;
  /** Resolves once, with the same value every time, after drain and cleanup are both known. */
  readonly closed: Promise<SessionClosedSummary>;
  readonly #clock: SessionClock;
  readonly #budgets: SessionBudgets;
  readonly #backend: ProcessBackend | undefined;
  readonly #sources: readonly OpenSource[];
  readonly #issueGeneration: () => number;
  readonly #resolveClosed: (summary: SessionClosedSummary) => void;
  #process: ProcessState = { kind: 'starting' };
  #connection: ConnectionState = { kind: 'detached' };
  #cleanup: CleanupState = { kind: 'idle' };
  #quarantined = false;
  #finalized = false;
  #closeCause: CloseCause | undefined;
  #attachment: AttachmentRuntime | undefined;
  #started: Promise<void> | undefined;
  #startSettled: Promise<unknown> | undefined;
  #sourcesStarted = false;
  #sourcesEnded = 0;
  #droppedBytes = 0;
  #drainWaiter: (() => void) | undefined;

  constructor(options: SessionOptions) {
    if (options.sessionId.length === 0) throw new TypeError('sessionId must not be empty');
    if (options.profile.profileId.length === 0) throw new TypeError('profileId must not be empty');
    if (!isDimension(options.dimensions.columns) || !isDimension(options.dimensions.rows)) {
      throw new RangeError(
        `dimensions must be integers from ${MINIMUM_TERMINAL_DIMENSION} to ${MAXIMUM_TERMINAL_DIMENSION}`,
      );
    }
    this.sessionId = options.sessionId;
    this.profile = Object.freeze({ ...options.profile });
    this.dimensions = Object.freeze({ ...options.dimensions });
    this.#clock = options.clock;
    this.#budgets = resolveSessionBudgets(options.budgets);
    this.#backend = options.backend;
    this.#issueGeneration = options.issueGeneration ?? (() => 1);
    this.#sources = options.sources.map(openSource);
    let resolveClosed!: (summary: SessionClosedSummary) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  /** The three state axes, quarantine and ownership, as they are right now. */
  get snapshot(): SessionSnapshot {
    return {
      sessionIdentity: this.sessionId,
      process: this.#process,
      connection: this.#connection,
      cleanup: this.#cleanup,
      quarantined: this.#quarantined,
      closed: this.#finalized,
      ownership: {
        process: this.#backend === undefined ? 'none' : 'owned',
        sources: this.#sources.map((source) => source.ownership),
        view: this.#connection.kind === 'attached' ? 'bound' : 'unbound',
      },
    };
  }

  /**
   * Launch the backend. The process is `starting` until it resolves, and input is disabled
   * throughout. A session with no backend is running at once. Calling it again returns the same
   * promise, and a session closed before it ran never launches anything.
   */
  start(): Promise<void> {
    this.#started ??= this.#launch();
    return this.#started;
  }

  async #launch(): Promise<void> {
    const backend = this.#backend;
    if (this.#closeCause !== undefined) return;
    if (backend === undefined) {
      this.#markRunning();
      return;
    }
    const launched = attempt(() => backend.start());
    this.#startSettled = launched;
    const succeeded = await launched;
    if (this.#closeCause !== undefined) return;
    if (!succeeded) {
      this.#process = { kind: 'failed', reason: 'start-rejected' };
      this.#beginClose('start-failed');
      return;
    }
    this.#markRunning();
  }

  #markRunning(): void {
    this.#process = { kind: 'running' };
    this.#startSources();
  }

  /**
   * Take the one attachment. It is refused immediately, never queued, when the request presents a
   * generation (v1 has no resume), the slot is quarantined, the session is closing or closed, or an
   * attachment already holds it. A refusal never disturbs the attachment that holds the slot.
   */
  attach(request: AttachRequest): AttachResult {
    const refusal = this.#attachRefusal(request);
    if (refusal !== undefined) return { accepted: false, reason: refusal };
    const authority = deriveAuthority(this.#issueGeneration(), this.#backend, request);
    const attachment: AttachmentRuntime = {
      authority,
      listener: request.listener,
      queue: new OperationQueue(
        this.#budgets.operationQueueLimit,
        this.#budgets.reservedControlCapacity,
      ),
      output: new OutputBudget(this.#budgets.outputQueueBytes),
      revoked: false,
      listenerFailed: false,
      inputBytes: 0,
      nextSequence: 1,
      pumping: false,
      inFlight: undefined,
      cancelLiveness: this.#armLiveness(),
      releaseControl: undefined,
    };
    this.#attachment = attachment;
    this.#connection = { kind: 'attached', generation: authority.generation };
    this.#startSources();
    return { accepted: true, authority, attachment: this.#handleFor(attachment) };
  }

  #attachRefusal(request: AttachRequest): AttachmentRejection | undefined {
    if (request.resumeGeneration !== undefined) return 'stale-generation';
    if (this.#quarantined) return 'quarantined';
    if (this.#closeCause !== undefined) return 'session-closed';
    if (this.#attachment !== undefined) return 'concurrent-attachment';
    return undefined;
  }

  #armLiveness(): CancelTimer {
    return this.#clock.schedule(
      () => this.#beginClose('liveness-expired'),
      this.#budgets.livenessDeadlineMilliseconds,
    );
  }

  /**
   * Record the process exit. It is reported at most once, may arrive before trailing output, and
   * disables input at once. A close already under way keeps its cause; the exit is still recorded so
   * no later event overwrites the observed outcome. Returns whether this call recorded it.
   */
  reportProcessExit(exitCode: number | null, signal: string | null): boolean {
    if (this.#finalized || this.#process.kind === 'exited' || this.#process.kind === 'failed') {
      return false;
    }
    this.#process = { kind: 'exited', exitCode, signal };
    this.#emit({ type: 'processExit', exitCode, signal });
    this.#cancelQueued('process-exited');
    this.#beginClose('process-exit');
    return true;
  }

  /** Host-initiated stop: revoke, clean up, close. Repeating it returns the same promise. */
  stop(): Promise<SessionClosedSummary> {
    this.#beginClose('host-stop');
    return this.closed;
  }

  /** Host-initiated disposal. Equivalent to `stop`, and idempotent with it in either order. */
  dispose(): Promise<SessionClosedSummary> {
    this.#beginClose('host-dispose');
    return this.closed;
  }

  /** The host withdrew authorization: freeze input and clean up, as for any other revocation. */
  revokeAuthorization(): Promise<SessionClosedSummary> {
    this.#beginClose('authorization-revoked');
    return this.closed;
  }

  #handleFor(attachment: AttachmentRuntime): SessionAttachment {
    const live = (): boolean => !attachment.revoked && !this.#finalized;
    const submit = (
      operation: OperationRequest,
      options: { readonly sequence?: number } | undefined,
    ): InputReceipt => this.#submit(attachment, operation, options?.sequence);
    return {
      generation: attachment.authority.generation,
      authority: attachment.authority,
      write: (bytes, options) => submit({ kind: 'input', bytes }, options),
      reply: (bytes, options) => submit({ kind: 'input', bytes }, options),
      resize: (columns, rows, options) => submit({ kind: 'resize', columns, rows }, options),
      outputParsed: (chunkId) => {
        const released = attachment.output.release(chunkId);
        this.#checkDrain();
        return released;
      },
      outputParsedThrough: (cumulativeBytes) => {
        const released = attachment.output.releaseThrough(cumulativeBytes);
        this.#checkDrain();
        return released;
      },
      heartbeat: () => {
        if (!live()) return false;
        attachment.cancelLiveness();
        attachment.cancelLiveness = this.#armLiveness();
        return true;
      },
      stop: () => {
        if (attachment.authority.capabilities.readOnly) {
          return { accepted: false, reason: 'read-only' };
        }
        this.#beginClose('attachment-stop');
        return { accepted: true, closed: this.closed };
      },
      detach: () => {
        this.#beginClose('disconnect');
        return this.closed;
      },
      protocolViolation: () => {
        this.#beginClose('protocol-failure');
        return this.closed;
      },
    };
  }

  /**
   * Accept input or a resize into the host FIFO, or refuse it with a typed reason. Acceptance
   * means only that it was queued; whether it is later submitted, canceled or of unknown
   * delivery is reported as an event, and nothing here is ever retried.
   */
  #submit(
    attachment: AttachmentRuntime,
    operation: OperationRequest,
    requestedSequence: number | undefined,
  ): InputReceipt {
    const sequence = requestedSequence ?? attachment.nextSequence++;
    const refuse = (reason: InputFailureReason): InputReceipt => ({
      disposition: 'failed',
      sequence,
      reason,
    });
    if (attachment.revoked || this.#finalized) return refuse('stale-generation');
    const { capabilities } = attachment.authority;
    if (!(operation.kind === 'input' ? capabilities.input : capabilities.resize)) {
      return refuse(capabilities.readOnly ? 'read-only' : 'unsupported');
    }
    if (this.#process.kind !== 'running') return refuse('input-disabled');
    if (
      operation.kind === 'resize' &&
      !(isDimension(operation.columns) && isDimension(operation.rows))
    ) {
      return refuse('invalid-dimensions');
    }
    const byteLength = operation.kind === 'input' ? operation.bytes.length : 0;
    if (attachment.inputBytes + byteLength > this.#budgets.inputQueueBytes) {
      return refuse('input-overflow');
    }
    const queued: QueuedOperation =
      operation.kind === 'input'
        ? { sequence, kind: 'input', bytes: operation.bytes.slice() }
        : { sequence, ...operation };
    if (!attachment.queue.offerUser(queued)) return refuse('fifo-full');
    attachment.inputBytes += byteLength;
    void this.#pump(attachment);
    return { disposition: 'accepted', sequence };
  }

  /** Submit queued operations to the backend one at a time, each bounded by the acknowledgement deadline. */
  async #pump(attachment: AttachmentRuntime): Promise<void> {
    if (attachment.pumping) return;
    attachment.pumping = true;
    // Only an attachment whose capabilities allow input or resize can queue anything, and only a backend grants those.
    const backend = this.#backend as ProcessBackend;
    for (;;) {
      const operation = attachment.queue.take();
      if (operation === undefined) break;
      const settling = settleWithin(
        this.#clock,
        this.#budgets.inputAcknowledgementDeadlineMilliseconds,
        () =>
          operation.kind === 'input'
            ? backend.write(operation.bytes)
            : backend.resize?.(operation.columns, operation.rows),
      );
      attachment.inFlight = { operation, settling };
      const settled = await settling.outcome;
      if (this.#finalized) return;
      attachment.inFlight = undefined;
      attachment.inputBytes -= byteLengthOf(operation);
      if (settled.kind === 'value') continue;
      const failed = settled.kind === 'rejected';
      this.#emit(
        this.#operationResult(
          operation,
          failed ? 'failed' : 'unknown',
          failed ? 'backend-failed' : 'acknowledgement-deadline',
        ),
      );
      this.#beginClose(failed ? 'backend-failed' : 'delivery-unknown');
    }
    attachment.pumping = false;
  }

  #operationResult(
    operation: { readonly sequence: number; readonly kind: OperationKind },
    disposition: OperationOutcome['disposition'],
    reason: OperationResultReason,
  ): OperationOutcome {
    return {
      type: 'operationResult',
      sequence: operation.sequence,
      kind: operation.kind,
      disposition,
      reason,
    };
  }

  /** Cancel every operation not yet submitted, each with an explicit result. Submitted ones cannot be retracted. */
  #cancelQueued(reason: OperationResultReason): void {
    const attachment = this.#attachment;
    if (attachment === undefined) return;
    for (const operation of attachment.queue.drain()) {
      attachment.inputBytes -= byteLengthOf(operation);
      this.#emit(this.#operationResult(operation, 'canceled', reason));
    }
  }

  #startSources(): void {
    const attachment = this.#attachment;
    if (
      attachment === undefined ||
      attachment.revoked ||
      this.#sourcesStarted ||
      this.#process.kind !== 'running'
    ) {
      return;
    }
    this.#sourcesStarted = true;
    for (const source of this.#sources) {
      try {
        source.start({
          chunk: (bytes) => this.#ingest(source.channel, bytes),
          end: () => this.#sourceEnded(source.channel),
          failed: () => this.#beginClose('source-failed'),
        });
      } catch {
        this.#beginClose('source-failed');
        return;
      }
    }
  }

  /**
   * Accept one output chunk from a source. Capacity is reserved before delivery and held until
   * the consumer reports that chunk parsed. A chunk that does not fit is never dropped silently: it
   * fails the session visibly, revoking the generation, because a source that cannot be paused cannot
   * be allowed to outrun its consumer.
   */
  #ingest(channel: OutputChannel, bytes: Uint8Array): void {
    const attachment = this.#attachment;
    if (this.#finalized || attachment === undefined) return;
    if (attachment.revoked) {
      this.#droppedBytes += bytes.length;
      return;
    }
    const chunkId = attachment.output.reserve(bytes.length);
    if (chunkId === undefined) {
      this.#droppedBytes += bytes.length;
      this.#beginClose('output-overflow');
      return;
    }
    this.#emit({
      type: 'output',
      generation: attachment.authority.generation,
      chunkId,
      channel,
      bytes,
    });
  }

  #sourceEnded(channel: OutputChannel): void {
    this.#sourcesEnded += 1;
    this.#emit({ type: 'sourceComplete', channel });
    if (this.#backend === undefined && this.#sourcesEnded === this.#sources.length) {
      this.#beginClose('source-complete');
    }
    this.#checkDrain();
  }

  /**
   * Deliver an event to the attachment. A throw or a rejection from the listener fails the
   * attachment: it is revoked and cleaned up, and the listener is not called again.
   */
  #emit(event: Parameters<AttachmentListener>[0]): void {
    const attachment = this.#attachment;
    if (attachment === undefined || attachment.listenerFailed || this.#finalized) return;
    const fail = (): void => {
      attachment.listenerFailed = true;
      this.#beginClose('callback-failed');
    };
    try {
      attachment.listener(event)?.then(undefined, fail);
    } catch {
      fail();
    }
  }

  /**
   * Start closing, once. The first cause wins and is recorded; a later one can only hurry things
   * up, by freezing the attachment and ending a drain wait. A cause that is not a natural end revokes
   * authority synchronously, so input is frozen before any await.
   */
  #beginClose(cause: CloseCause): void {
    const first = this.#closeCause === undefined;
    if (first) {
      this.#closeCause = cause;
      if (this.#process.kind === 'starting') {
        this.#process = { kind: 'failed', reason: 'closed-during-startup' };
      }
    }
    if (!NATURAL_CAUSES.has(cause)) {
      this.#revoke(cause);
      this.#drainWaiter?.();
    }
    if (first) void this.#finish(cause);
  }

  /** Revoke the attachment's authority: freeze input, cancel unsent operations, stop liveness. Idempotent. */
  #revoke(cause: CloseCause): void {
    const attachment = this.#attachment;
    if (attachment === undefined || attachment.revoked) return;
    attachment.revoked = true;
    attachment.cancelLiveness();
    attachment.releaseControl = attachment.queue.admitControl();
    const { generation } = attachment.authority;
    this.#connection = { kind: 'revoked', generation };
    this.#cancelQueued('revoked');
    this.#emit({ type: 'attachmentRevoked', generation, cause });
  }

  #drainComplete(): boolean {
    const attachment = this.#attachment;
    return (
      attachment === undefined ||
      (attachment.output.pendingBytes === 0 &&
        (!this.#sourcesStarted || this.#sourcesEnded === this.#sources.length))
    );
  }

  #checkDrain(): void {
    if (this.#drainWaiter !== undefined && this.#drainComplete()) this.#drainWaiter();
  }

  /** Wait, for a natural close only, until accepted output is parsed, the sources end, or the deadline passes. */
  #waitForDrain(cause: CloseCause): Promise<void> {
    const attachment = this.#attachment;
    if (
      !NATURAL_CAUSES.has(cause) ||
      attachment === undefined ||
      attachment.revoked ||
      this.#drainComplete()
    ) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const cancelDeadline = this.#clock.schedule(
        () => this.#drainWaiter?.(),
        this.#budgets.cleanupDeadlineMilliseconds,
      );
      this.#drainWaiter = () => {
        cancelDeadline();
        this.#drainWaiter = undefined;
        resolve();
      };
    });
  }

  async #finish(cause: CloseCause): Promise<void> {
    await this.#waitForDrain(cause);
    this.#revoke(cause);
    this.#cleanup = { kind: 'running' };
    const released = await this.#runCleanup();
    // An output overflow dropped bytes the session had no way to pause, so the owned scope was not
    // drained cleanly however the release itself went: it quarantines the slot.
    const outcome =
      cause === 'output-overflow' ? combineOutcomes([released, 'incomplete']) : released;
    this.#cleanup = { kind: 'finished', outcome };
    this.#quarantined = outcome !== 'complete';
    this.#finalize(cause, outcome);
  }

  /** The owner's cleanup policy: release every source and the backend, each bounded by the cleanup deadline. */
  async #runCleanup(): Promise<CleanupOutcome> {
    const deadline = this.#budgets.cleanupDeadlineMilliseconds;
    const steps = this.#sources.map((source) => source.release(this.#clock, deadline));
    const backend = this.#backend;
    if (backend !== undefined) steps.push(this.#releaseBackend(backend, deadline));
    return combineOutcomes(await Promise.all(steps));
  }

  async #releaseBackend(backend: ProcessBackend, deadline: number): Promise<CleanupOutcome> {
    const settled = await settleWithin(this.#clock, deadline, async () => {
      // A launch still in flight must finish before its process can be cleaned up.
      await this.#startSettled;
      return backend.cleanup();
    }).outcome;
    if (settled.kind === 'value') return settled.value;
    return settled.kind === 'timeout' ? 'unknown' : 'incomplete';
  }

  #finalize(cause: CloseCause, cleanup: CleanupOutcome): void {
    const attachment = this.#attachment;
    if (attachment?.inFlight !== undefined) {
      this.#emit(
        this.#operationResult(
          attachment.inFlight.operation,
          'unknown',
          'closed-before-acknowledgement',
        ),
      );
      attachment.inFlight.settling.cancel();
    }
    attachment?.releaseControl?.();
    const unavailableBytes = (attachment?.output.pendingBytes ?? 0) + this.#droppedBytes;
    const summary: SessionClosedSummary = {
      sessionIdentity: this.sessionId,
      cause,
      process: this.#process,
      cleanup,
      drain: { state: unavailableBytes === 0 ? 'drained' : 'truncated', unavailableBytes },
      quarantined: this.#quarantined,
    };
    this.#emit({ type: 'sessionClosed', summary });
    this.#finalized = true;
    this.#resolveClosed(summary);
  }
}
