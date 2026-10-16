import { channelPermitted } from '../protocol/endpoint-support.ts';
import { isSessionIdentifier } from '../protocol/message-fields.ts';
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
  OutputSource,
  ProcessBackend,
  ProcessState,
  SessionAttachment,
  SessionBudgets,
  SessionClosedSummary,
  SessionOptions,
  SessionProfile,
  SessionSnapshot,
  StartFailureCode,
  TerminalDimensions,
} from './session-types.ts';
import { attempt, combineOutcomes, settleWithin, type Settling } from './settle.ts';
import { SourceAcquisitionError } from './source-acquisition-error.ts';

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
  /** The backend reported the write in flight is held by a child that is not reading. */
  inputHeld: boolean;
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
  /** Why the backend refused to start, when it said so with one of the startup failure codes. */
  #startFailureCode: StartFailureCode | undefined;
  /** True from the moment `backend.start()` is invoked until its promise settles. */
  #startPending = false;
  /** The backend reported its exit before `start()` settled, so its sources still have to be read and drained. */
  #exitedDuringStartup = false;
  /** Listener deliveries that returned a promise and have not settled yet. */
  readonly #deliveries = new Set<Promise<void>>();
  /** A listener threw or rejected at some point before finalization. */
  #callbackFailed = false;
  /** Output ever overflowed the budget, whatever cause closed the session first. */
  #overflowed = false;
  #sourcesStarted = false;
  #sourcesEnded = 0;
  #droppedBytes = 0;
  #drainWaiter: (() => void) | undefined;
  /** Pull-based sources waiting for the output budget to have room; each returns true once it is settled. */
  #roomWaiters: (() => boolean)[] = [];

  constructor(options: SessionOptions) {
    // The wire schema requires a canonical UUID, so any other identity could never be addressed by a client.
    if (!isSessionIdentifier(options.sessionId)) {
      throw new TypeError('sessionId must be a canonical lowercase UUID');
    }
    if (options.profile.profileId.length === 0) throw new TypeError('profileId must not be empty');
    if (!isDimension(options.dimensions.columns) || !isDimension(options.dimensions.rows)) {
      throw new RangeError(
        `dimensions must be integers from ${MINIMUM_TERMINAL_DIMENSION} to ${MAXIMUM_TERMINAL_DIMENSION}`,
      );
    }
    // Checked before any source is opened or the backend can launch: a source on a channel the
    // mode never carries could never be delivered, and by then a resource would be held.
    const mode = options.backend?.mode ?? 'output-only';
    for (const source of options.sources) {
      if (!channelPermitted(mode, source.channel)) {
        throw new TypeError(
          `a ${mode} session cannot carry a source on the ${source.channel} channel`,
        );
      }
    }
    this.sessionId = options.sessionId;
    this.profile = Object.freeze({ ...options.profile });
    this.dimensions = Object.freeze({ ...options.dimensions });
    this.#clock = options.clock;
    this.#budgets = resolveSessionBudgets(options.budgets);
    this.#backend = options.backend;
    this.#issueGeneration = options.issueGeneration ?? (() => 1);
    this.#sources = this.#openSources(options.sources);
    let resolveClosed!: (summary: SessionClosedSummary) => void;
    this.closed = new Promise((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
  }

  /**
   * Open every source; if one cannot be opened, release those already acquired and throw an error
   * that carries the outcome of that release, so the owner of the slot can quarantine on an
   * incomplete or unknown one instead of losing it.
   */
  #openSources(definitions: readonly OutputSource[]): readonly OpenSource[] {
    const opened: OpenSource[] = [];
    try {
      for (const definition of definitions) opened.push(openSource(definition));
    } catch (error) {
      const releases = opened.map((source) =>
        source.release(this.#clock, this.#budgets.cleanupDeadlineMilliseconds),
      );
      throw new SourceAcquisitionError(
        error,
        Promise.all(releases).then((outcomes) => combineOutcomes(outcomes)),
      );
    }
    return opened;
  }

  /**
   * The startup failure code the backend's `start()` rejected with, if it carried one (a rejection
   * with a `code` of `unsupported-runtime` or `spawn-failed`). Absent while the session has not
   * failed to start, and for a rejection that named no code, which is a `spawn-failed`.
   */
  get startFailureCode(): StartFailureCode | undefined {
    return this.#startFailureCode;
  }

  /** The configured user-operation FIFO depth, which a connection's endpoint window must cover. */
  get operationQueueLimit(): number {
    return this.#budgets.operationQueueLimit;
  }

  /**
   * The three state axes, quarantine and ownership, as they are right now. Every part is a frozen
   * copy: the session's own state is never reachable from what it hands out.
   */
  get snapshot(): SessionSnapshot {
    return Object.freeze({
      sessionIdentity: this.sessionId,
      process: Object.freeze({ ...this.#process }),
      connection: Object.freeze({ ...this.#connection }),
      cleanup: Object.freeze({ ...this.#cleanup }),
      quarantined: this.#quarantined,
      closed: this.#finalized,
      ownership: Object.freeze({
        process: this.#backend === undefined ? ('none' as const) : ('owned' as const),
        sources: Object.freeze(this.#sources.map((source) => source.ownership)),
        view: this.#connection.kind === 'attached' ? ('bound' as const) : ('unbound' as const),
      }),
    });
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
    // Set before `start()` runs: a backend can report its exit from inside it, and that close must wait.
    this.#startPending = true;
    const launched = attempt(() => {
      try {
        const starting = Promise.resolve(backend.start());
        starting.then(undefined, (error: unknown) => this.#recordStartFailure(error));
        return starting;
      } catch (error) {
        this.#recordStartFailure(error);
        throw error;
      }
    });
    this.#startSettled = launched;
    const succeeded = await launched;
    this.#startPending = false;
    if (this.#closeCause !== undefined) {
      // A natural close that began during startup is waiting for output that has not been read yet.
      // However `start()` settled: the exit was reported, so the bytes it left behind are still owed.
      if (this.#exitedDuringStartup) this.#startSources();
      this.#checkDrain();
      return;
    }
    if (!succeeded) {
      this.#process = { kind: 'failed', reason: 'start-rejected' };
      this.#beginClose('start-failed');
      return;
    }
    this.#markRunning();
  }

  #recordStartFailure(error: unknown): void {
    const code = (error as { readonly code?: unknown } | null)?.code;
    if (code === 'unsupported-runtime' || code === 'spawn-failed') this.#startFailureCode = code;
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
      inputHeld: false,
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
    if (this.#process.kind === 'starting') this.#exitedDuringStartup = true;
    this.#process = { kind: 'exited', exitCode, signal };
    // The natural exit is the first cause, recorded before any listener can run. A listener that
    // stops, disposes or detaches from inside its `processExit` call hurries the drain it finds
    // under way, but it cannot take the cause from the exit that began the close.
    this.#beginClose('process-exit');
    this.#emit({ type: 'processExit', exitCode, signal });
    this.#cancelQueued('process-exited');
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
        this.#notifyRoom();
        this.#checkDrain();
        return released;
      },
      outputParsedThrough: (cumulativeBytes) => {
        const released = attachment.output.releaseThrough(cumulativeBytes);
        this.#notifyRoom();
        this.#checkDrain();
        return released;
      },
      get inputHeld() {
        return attachment.inputHeld;
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
    // A held write means the process is not reading: nothing new is queued behind it, and a refused
    // operation is never replayed. The client's empty capacity probe lands here too.
    if (attachment.inputHeld) return refuse('input-held');
    const byteLength = operation.kind === 'input' ? operation.bytes.length : 0;
    if (attachment.inputBytes + byteLength > this.#budgets.inputQueueBytes) {
      return refuse('input-overflow');
    }
    const queued: QueuedOperation =
      operation.kind === 'input'
        ? { sequence, kind: 'input', bytes: operation.bytes.slice() }
        : { sequence, ...operation };
    // The queue holds the user-limit of waiting operations and the one being submitted is counted on
    // top of it, so unsettled operations never exceed depth plus the active one: the window the
    // endpoint keeps failable ("a submitted operation can still fail later").
    if (!attachment.queue.offerUser(queued)) return refuse('fifo-full');
    attachment.inputBytes += byteLength;
    this.#schedulePump(attachment);
    return { disposition: 'accepted', sequence };
  }

  /**
   * Start submitting after the caller has been handed the accepted receipt. The backend can exit
   * or fail synchronously, and the caller must be able to acknowledge acceptance on the wire first.
   */
  #schedulePump(attachment: AttachmentRuntime): void {
    if (attachment.pumping) return;
    attachment.pumping = true;
    void Promise.resolve().then(() => this.#pump(attachment));
  }

  /** Submit queued operations to the backend one at a time, each bounded by the acknowledgement deadline. */
  async #pump(attachment: AttachmentRuntime): Promise<void> {
    // Only an attachment whose capabilities allow input or resize can queue anything, and only a backend grants those.
    const backend = this.#backend as ProcessBackend;
    for (;;) {
      const operation = attachment.queue.take();
      if (operation === undefined) break;
      // A hold report only counts while this operation is the one in flight.
      let current = true;
      const settling = settleWithin(
        this.#clock,
        this.#budgets.inputAcknowledgementDeadlineMilliseconds,
        (deadline) =>
          operation.kind === 'input'
            ? backend.write(operation.bytes, {
                held: () => {
                  if (!current) return;
                  attachment.inputHeld = true;
                  deadline.suspend();
                },
                resumed: () => {
                  if (!current) return;
                  attachment.inputHeld = false;
                  deadline.resume();
                },
              })
            : backend.resize?.(operation.columns, operation.rows),
      );
      attachment.inFlight = { operation, settling };
      const settled = await settling.outcome;
      current = false;
      attachment.inputHeld = false;
      // A close that already reported this operation as unknown owns its result: nothing is said twice.
      if (this.#finalized || attachment.inFlight === undefined) return;
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
      !(this.#process.kind === 'running' || this.#exitedDuringStartup)
    ) {
      return;
    }
    this.#sourcesStarted = true;
    for (const source of this.#sources) {
      try {
        source.start({
          room: (minimum) => this.#waitForRoom(minimum),
          offer: (bytes) => this.#offer(source.channel, bytes),
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
      this.#overflowed = true;
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

  /**
   * Resolve with the output budget's free bytes once it has room for `minimum` of them, capped at
   * a quarter of the budget so a small budget still moves, or with `undefined` once the session
   * no longer accepts output. This is the whole of the pause: a source that is not asked for more
   * is not read.
   */
  #waitForRoom(minimum: number): Promise<number | undefined> {
    return new Promise((resolve) => {
      const settle = (): boolean => {
        const attachment = this.#attachment;
        if (this.#finalized || attachment === undefined || attachment.revoked) {
          resolve(undefined);
          return true;
        }
        const wanted = Math.max(1, Math.min(minimum, Math.floor(attachment.output.limitBytes / 4)));
        if (attachment.output.availableBytes < wanted) return false;
        resolve(attachment.output.availableBytes);
        return true;
      };
      if (!settle()) this.#roomWaiters.push(settle);
    });
  }

  /**
   * Take up to what the output budget has free right now, in one step with checking it. A session
   * that no longer accepts output takes everything, to count it as unavailable.
   */
  #offer(channel: OutputChannel, bytes: Uint8Array): number {
    const attachment = this.#attachment;
    const take =
      this.#finalized || attachment === undefined || attachment.revoked
        ? bytes.length
        : Math.min(attachment.output.availableBytes, bytes.length);
    if (take === 0 && bytes.length > 0) return 0;
    this.#ingest(channel, bytes.subarray(0, take));
    return take;
  }

  /** Wake every source waiting for room whose wait can now end. */
  #notifyRoom(): void {
    if (this.#roomWaiters.length === 0) return;
    this.#roomWaiters = this.#roomWaiters.filter((settle) => !settle());
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
      this.#callbackFailed = true;
      this.#beginClose('callback-failed');
    };
    try {
      const delivery = attachment.listener(event);
      if (delivery !== undefined) {
        const tracked: Promise<void> = delivery.then(() => undefined, fail);
        this.#deliveries.add(tracked);
        void tracked.finally(() => this.#deliveries.delete(tracked));
      }
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
    this.#notifyRoom();
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
      (!this.#startPending &&
        attachment.output.pendingBytes === 0 &&
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
    // The last operation result is an event like any other, so it goes out before deliveries settle:
    // a listener that rejects it must still be able to turn a natural close into `callback-failed`.
    this.#abandonInFlight();
    await this.#settleDeliveries();
    // A listener that failed during a natural close means the close was not the clean end it claims.
    const finalCause =
      this.#callbackFailed && NATURAL_CAUSES.has(cause) ? 'callback-failed' : cause;
    // An output overflow dropped bytes the session had no way to pause, so the owned scope was not
    // drained cleanly however the release itself went: it quarantines the slot.
    const outcome = this.#overflowed ? combineOutcomes([released, 'incomplete']) : released;
    this.#cleanup = { kind: 'finished', outcome };
    this.#quarantined = outcome !== 'complete';
    this.#finalize(finalCause, outcome);
  }

  /** Give listener promises still pending a bounded chance to settle, so a late rejection reaches the summary. */
  async #settleDeliveries(): Promise<void> {
    if (this.#deliveries.size === 0) return;
    await settleWithin(this.#clock, this.#budgets.cleanupDeadlineMilliseconds, () =>
      Promise.all(this.#deliveries),
    ).outcome;
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

  /** Report the operation still in flight as unknown delivery, once, and stop waiting for the backend to answer it. */
  #abandonInFlight(): void {
    const inFlight = this.#attachment?.inFlight;
    if (inFlight === undefined) return;
    (this.#attachment as AttachmentRuntime).inFlight = undefined;
    this.#emit(
      this.#operationResult(inFlight.operation, 'unknown', 'closed-before-acknowledgement'),
    );
    inFlight.settling.cancel();
  }

  #finalize(cause: CloseCause, cleanup: CleanupOutcome): void {
    const attachment = this.#attachment;
    attachment?.releaseControl?.();
    const unavailableBytes = (attachment?.output.pendingBytes ?? 0) + this.#droppedBytes;
    const summary: SessionClosedSummary = {
      sessionIdentity: this.sessionId,
      cause,
      process: Object.freeze({ ...this.#process }),
      cleanup,
      drain: Object.freeze({
        state: unavailableBytes === 0 ? ('drained' as const) : ('truncated' as const),
        unavailableBytes,
      }),
      quarantined: this.#quarantined,
    };
    Object.freeze(summary);
    this.#emit({ type: 'sessionClosed', summary });
    this.#finalized = true;
    this.#notifyRoom();
    this.#resolveClosed(summary);
  }
}
