/**
 * One chat session's state: the conversation Chat renders, whether a run is going, and the
 * session controller that sends turns and follow-ups. A session is a Bureau context, and the
 * conversation's id is its id, which is the AG-UI thread (`run-wiring.ts`).
 *
 * The page may open on a session whose run is still going (a reload, a link). `attach()` joins
 * that run: its stream restores the transcript from the mount's snapshot and carries on live. A
 * session with nothing going has its transcript read from the mount (`wiring.history`), so a
 * finished session opens on all of it, in order.
 *
 * Leaving the page ends the session's streams but not its run: only a stop cancels the run. A
 * message sent while the attach is still opening waits for it, so it goes to the run the attach
 * joins and not to the mount as a second run.
 *
 * A run can wait on several things at once, and one resume answers them all. A message typed to
 * answer a question while others still wait (another question, or a tool approval) is held with the
 * rest and sends nothing (`run-wiring.ts`). A request the mount refuses is answered by reading
 * the thread again, through the same attach: what is still pending decides what is still owed.
 */
import {
  appendMessages,
  assertRunInputAccepted,
  countQueuedFollowUps,
  createChatSessionController,
  createConversationHistory,
  findToolResultMessage,
  getUnresolvedToolApprovals,
  pairToolCallsWithResults,
  removeMessage,
  type ChatSessionController,
  type ConversationHistory,
  type MessageInput,
} from '@lostgradient/chat';

import { parseStepRowIdentifier } from '@lostgradient/operative';
import { CHAT_COPY } from '../../app/copy/chat.ts';
import {
  forgetContextGrants,
  regenerateContext,
  retractContextInput,
  sendContextInput,
  wireCodeOf,
  type Fetcher,
} from '../../lib/bureau-client.ts';
import { BureauClock } from '../../lib/bureau-clock.ts';
import { messageWithAttachments, runFailureMessage } from '../../lib/chat-attachments.ts';
import { AgUiHttpError } from './ag-ui-events.ts';
import { questionKeyOf } from './answer-rows.ts';
import {
  carryLiveNotes,
  holdStopLines,
  withHeldStopLines,
  type HeldStopLine,
} from './event-notes.ts';
import {
  createChatRunWiring,
  withAnnouncements,
  type ApprovalDeadline,
  type ChatRunWiring,
  type GrantNotLoosened,
  type HumanRequest,
  type Refusal,
  type RunUsage,
} from './run-wiring.ts';
import { lastTurnStart, mayChange, type ToolInfo } from './tool-activity.ts';

export type ChatSessionOptions = {
  /** The session's identifier, which is the conversation's and the AG-UI thread's. */
  readonly sessionId: string;
  /** The agent the session's runs name. */
  readonly agentName: () => string;
  /** Replaces `fetch` for the AG-UI requests, for tests. */
  readonly fetch?: Fetcher;
  /** Told when a run this page started has begun. */
  readonly onRunStarted?: () => void;
  /**
   * Whether a turn that ends before any run has begun leaves nothing behind: a new chat's first
   * message whose start failed. The message was never sent, so its row is dropped, the person keeps
   * what they typed in the box, and the next Send is the first message again, not a second one.
   */
  readonly discardUnstarted?: () => boolean;
  /**
   * Whether the chat is closed: it was deleted, so a send would start a new chat under the same
   * identifier. A closed session sends nothing, and says why to whoever tried.
   */
  readonly closed?: () => boolean;
  /**
   * Told when the Bureau answered a read or a send with not-found. That answer is also what a
   * caller who cannot change the chat is given, so the page reads the chat again to learn which.
   */
  readonly onNotFound?: () => void;
  /** Told when a grant the person asked for did not loosen the tool (see the run wiring). */
  readonly onGrantNotLoosened?: (notice: GrantNotLoosened) => void;
  /** The Bureau's clock as the page reads it; a fresh one when omitted, for tests to replace. */
  readonly clock?: BureauClock;
  /**
   * Whether the session is a new chat whose thread the Bureau does not hold yet. Its history is not
   * read until a run it started has begun or an attach has restored a run, because a read sent
   * before the first message is kept would race the request that keeps it. A session that names an
   * existing thread leaves this out.
   */
  readonly unopened?: boolean;
};

/** Whether `error` is the Bureau, or the AG-UI door, saying it has no such thread. */
function isNotFound(error: unknown): boolean {
  return (
    (error instanceof AgUiHttpError && error.status === 404) || wireCodeOf(error) === 'NotFound'
  );
}

/** The text a follow-up sends: the Bureau takes text, or a list of parts, as session input. */
function inputPayload(message: MessageInput): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/** A stable comparison for the approval action a host read before an asynchronous cleanup. */
function approvalActionFingerprint(action: unknown): string | undefined {
  if (typeof action !== 'object' || action === null) return undefined;
  try {
    return JSON.stringify(action);
  } catch {
    return undefined;
  }
}

/** The Bureau round carried by a result row. */
function approvalRound(
  row: ConversationHistory['messages'][string] | undefined,
): number | undefined {
  const bureau = row?.metadata['@lostgradient/bureau'];
  if (typeof bureau !== 'object' || bureau === null) return undefined;
  const round = Reflect.get(bureau, 'round');
  return typeof round === 'number' ? round : undefined;
}

/** How many failed attempts in a row end the retries and leave the session disconnected. */
export const MAX_RECONNECT_ATTEMPTS = 8;

export type ChatRegenerationState = {
  readonly messageId: string;
  readonly commandId: string;
  readonly status: 'running' | 'failed';
  readonly error?: string;
};

export class ChatSessionState {
  conversation = $state.raw<ConversationHistory>(createConversationHistory({ id: '' }));
  /** Parsed approval rail identities retained across hidden attach/resume reconciliation. */
  parkedApprovalRailIds = $state.raw<ReadonlyMap<string, string>>(new Map());
  /** Approval keys retained with parked identities across hidden attach/resume reconciliation. */
  parkedApprovalKeys = $state.raw<ReadonlyMap<string, string>>(new Map());
  streaming = $state(false);
  /**
   * What the last failed turn said, for a person who needs to know why a row is marked failed. It
   * is cleared when the next turn begins or when the person dismisses it, so the same failure
   * again is told again.
   */
  failure = $state<string | undefined>(undefined);

  /**
   * Whether the last send failed because the request never got an answer (the network, or a server
   * that could not be reached), as opposed to an answer that refused it. A message that did not go
   * through for that reason says "Not sent" on its row and nothing more; a refusal has a reason of
   * its own, which the page keeps saying.
   */
  failureWasTransport = $state(false);
  /** The host-owned answer replacement currently in flight, or its retryable failure receipt. */
  regeneration = $state<ChatRegenerationState | undefined>(undefined);
  /** The questions the run is waiting on the person to answer; the next message answers one. */
  humanRequests = $state.raw<readonly HumanRequest[]>([]);
  /** Whether the session opened on a run that was going, and is still reading it. */
  attaching = $state(false);
  /**
   * Whether the session has stopped trying to reach the thread: it failed `MAX_RECONNECT_ATTEMPTS`
   * times in a row, or the Bureau refused it in a way a retry cannot change. The page says so and
   * offers `reconnect()`. It clears when the thread is read again, or a frame of the run arrives,
   * and a `reconnect()` that fails leaves it set without starting the retries over.
   */
  disconnected = $state(false);
  /**
   * Which reconnect attempt is under way: the number of failed reads in a row while the page is
   * still retrying, `0` when the stream is up or the page has given up (`disconnected`). The
   * composer says "Reconnecting… attempt N" while it is above zero.
   */
  reconnectAttempt = $state(0);
  /**
   * How many follow-ups the run has not taken yet: the transcript's queued rows. The Bureau holds
   * each until the run's next step takes it, when it becomes a sent message, and Remove takes one
   * back before then. The composer says one is queued.
   */
  readonly queuedFollowUps = $derived(countQueuedFollowUps(this.conversation));
  /**
   * What each run this page watched end reported it used, by the run's Bureau identifier. A run the
   * page did not watch end has no entry, and its reply details say nothing of usage.
   */
  usage = $state.raw<ReadonlyMap<string, RunUsage>>(new Map());
  /**
   * The Bureau's clock as this page reads it (`bureau-clock.ts`): the times a message the page
   * wrote carries, and how long a running call has been going, are read off it.
   */
  readonly clock: BureauClock;
  /**
   * When each call this page watched begin started, on the Bureau's clock, by call identifier: a
   * running call's duration counts from it.
   */
  callStarts = $state.raw<ReadonlyMap<string, number>>(new Map());
  /** When each call this page watched answered, on the Bureau's clock, by call identifier. */
  callEnds = $state.raw<ReadonlyMap<string, number>>(new Map());
  /** When the last run ended, on the Bureau's clock: a call it left without an answer stopped then. */
  stoppedAt = $state<number | undefined>(undefined);

  readonly controller: ChatSessionController;
  /**
   * What the page hands to Chat: the controller's adapter, whose sends wait for the attach to
   * finish. The controller starts a run for a message sent while nothing is going, and the attach
   * is the thing that finds out whether something is.
   */
  readonly adapter: ChatSessionController['adapter'];
  #attachment: Promise<void> = Promise.resolve();
  /** Whether the last attach could not read the thread. */
  #attachFailed = false;
  /** Whether the turn on screen carried files, which decides what the door's `INVALID_INPUT` is about. */
  #turnHadAttachments = false;
  /**
   * Whether the person has stopped the turn on screen and it has not ended yet. A Stop before the
   * run's first event is held until the event names the run (`run-wiring.ts`), so for that while the
   * page shows the turn as stopped and sends nothing.
   */
  stopping = $state(false);
  /** The refusal an error reported, for the read that follows the turn. */
  #refused: Refusal | undefined;
  readonly #stoppingAdapter: ChatSessionController['adapter'];
  readonly #wiring: ChatRunWiring;
  readonly #abort = new AbortController();
  readonly sessionId: string;
  readonly #onNotFound: (() => void) | undefined;
  readonly #closed: ChatSessionOptions['closed'];
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryGeneration = 0;
  #retryFailures = 0;
  #attachedRun = false;
  /** The schema of each question the page has been shown, by the key its answer's row shares. */
  readonly #questionSchemas = new Map<string, Readonly<Record<string, unknown>>>();
  /**
   * The deadlines of the tool approvals the last run ended on, as its interrupts gave them
   * (COR-2280), kept so a snapshot that restores the stored action without one gets it again.
   */
  #approvalDeadlines: readonly ApprovalDeadline[] = [];
  #regenerationPromise: Promise<void> | undefined;
  #readerAbort: AbortController | undefined;
  #activeTurn: Promise<unknown> = Promise.resolve();
  /**
   * The run token of the controller turn whose transport is in flight (`onTransportStart`), until
   * that same turn's transport ends. An older turn's end names an older token and releases nothing.
   */
  #controllerTransport: number | undefined;
  /** Whether the Bureau holds this session's thread, so its history may be read. */
  #opened: boolean;

  constructor(options: ChatSessionOptions) {
    this.sessionId = options.sessionId;
    this.#opened = options.unopened !== true;
    this.#closed = options.closed;
    this.#onNotFound = options.onNotFound;
    this.conversation = createConversationHistory({ id: options.sessionId });
    const clock = (this.clock = options.clock ?? new BureauClock());
    this.#wiring = createChatRunWiring({
      conversation: () => this.conversation,
      clock,
      onCallStarted: (callId, at) => {
        if (!this.callStarts.has(callId))
          this.callStarts = new Map(this.callStarts).set(callId, at);
      },
      onCallSettled: (callId, at) => {
        if (!this.callEnds.has(callId)) this.callEnds = new Map(this.callEnds).set(callId, at);
      },
      onRunStopped: (at) => {
        this.stoppedAt = at;
      },
      onRunStarted: () => {
        this.#attachedRun = true;
        // The run's start keeps the thread, so its history can be read from now on.
        this.#opened = true;
        options.onRunStarted?.();
      },
      onFrame: () => {
        this.#setRetryFailures(0);
        this.disconnected = false;
      },
      onTerminal: () => {
        this.#attachedRun = false;
      },
      ...(options.onGrantNotLoosened === undefined
        ? {}
        : { onGrantNotLoosened: options.onGrantNotLoosened }),
      // The run's step took these follow-ups: they read as sent from now on.
      onInputsDelivered: (inputIds) => this.controller.markFollowUpsDelivered(inputIds),
      onUsage: (runId, usage) => {
        this.usage = new Map(this.usage).set(runId, usage);
      },
      onSnapshot: (history) => {
        if (!this.#abort.signal.aborted) this.restore(history);
      },
      onApprovalDeadlines: (deadlines) => {
        this.#approvalDeadlines = deadlines;
        this.#reconcileApprovalDeadlines();
      },
      agentName: options.agentName,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      onHumanRequests: (requests) => {
        this.humanRequests = requests;
        for (const request of requests) {
          const key = questionKeyOf(request.interruptId);
          if (key !== undefined && request.schema !== undefined) {
            this.#questionSchemas.set(key, request.schema);
          }
        }
      },
    });
    this.controller = createChatSessionController({
      executionOwner: 'server',
      // A message the person writes is stamped with the Bureau's time, as the Bureau stamps it.
      now: () => clock.nowISO(),
      getConversation: () => this.conversation,
      // The line of a failed attempt Retry kept is not in the run's snapshot, so it is held.
      setConversation: (next) => {
        this.#setKeepingStopLines(next);
      },
      transport: this.#wiring.transport,
      // A follow-up goes to the run in flight. Its row id is the input's id, so a retry of the
      // same row is the same input.
      sendRunInput: async (conversationId, message, _attachments, { messageId }) => {
        if (options.closed?.() === true) throw new Error(CHAT_COPY.gone.title);
        const result = await sendContextInput(
          conversationId,
          { id: messageId, payload: inputPayload(message) },
          { signal: this.#abort.signal },
        );
        return assertRunInputAccepted(result.receipt);
      },
      // Remove on a queued follow-up: the Bureau holds it until the run takes it, and takes it back
      // until then.
      retractRunInput: async (conversationId, { messageId }) =>
        retractContextInput(conversationId, messageId, { signal: this.#abort.signal }),
      hooks: {
        resolveToolApproval: (toolCallId, resolution) =>
          this.#wiring.resolveToolApproval(toolCallId, resolution),
        onTransportStart: (runToken) => {
          this.#controllerTransport = runToken;
        },
        onTransportEnd: (runToken) => {
          if (this.#controllerTransport === runToken) this.#controllerTransport = undefined;
        },
        onStreamingChange: (streaming) => {
          this.streaming = streaming;
          // A new turn is a new attempt, and what failed before it is not what it will say. The
          // turn that reads a run the page joins is nobody's attempt: it is how the page finds out
          // what to say next, and must not wipe what the refusal before it said.
          if (streaming) {
            this.#turnsBegun += 1;
            if (!this.attaching) this.failure = undefined;
          }
          // A turn that ended in an error or a stop has no history to carry the assets it
          // announced, so they are put on their rows here, as a completed turn's are.
          else {
            this.stopping = false;
            if (options.discardUnstarted?.() === true) {
              this.conversation = createConversationHistory({ id: options.sessionId });
              return;
            }
            this.#stampAnnouncedAssets();
            this.#dropSettledAnswerRows();
            this.#readAgainAfterRefusal();
          }
        },
        onError: (error) => {
          if (isNotFound(error)) options.onNotFound?.();
          const failure =
            runFailureMessage(error, { hadAttachments: this.#turnHadAttachments }) ??
            (error instanceof Error ? error.message : String(error));
          const refusal = this.#wiring.takeRefusal();
          if (refusal?.resume === true) this.#refused = refusal;
          // A busy thread is not told when it refused a resume: the next send repeats it. A start
          // refused as busy, and every other refusal, is.
          if (refusal?.resume !== true || !refusal.busy) this.failure = failure;
          this.failureWasTransport = error instanceof TypeError;
          if (this.#attachedRun && !this.#readerAbort?.signal.aborted)
            this.#scheduleReconnect(error);
        },
      },
    });
    // The controller's own edit rewinds this thread in place, which the Bureau's thread cannot
    // follow, so it is removed: a sent message is changed by branching before it.
    const { editMessage: _editInPlace, ...adapter } = this.controller.adapter;
    this.adapter = {
      ...adapter,
      sendMessage: async (message, attachments) => {
        // A deleted chat is not written to: the run would start it again under the same identifier.
        if (options.closed?.() === true) throw new Error(CHAT_COPY.gone.title);
        this.#turnHadAttachments = attachments.length > 0;
        await this.#attachment;
        // What a refused resume still owes goes first, so the new message reaches the agent after
        // it, once, and not as a row of the resume, which the mount never reads.
        await this.#repeatOwedResume();
        if (this.#holdsAsAnswer(message)) return;
        if (options.closed?.() === true) throw new Error(CHAT_COPY.gone.title);
        const turn = adapter.sendMessage(messageWithAttachments(message, attachments), attachments);
        this.#activeTurn = turn.catch(() => undefined);
        return turn;
      },
      stopGenerating: async (...input: Parameters<NonNullable<typeof adapter.stopGenerating>>) => {
        if (!this.streaming && this.reconnectAttempt > 0) return this.#stopWhileReconnecting();
        if (this.streaming) this.stopping = true;
        await adapter.stopGenerating?.(...input);
      },
      ...(adapter.sendRunInput === undefined
        ? {}
        : {
            sendRunInput: async (
              ...input: Parameters<NonNullable<typeof adapter.sendRunInput>>
            ) => {
              await this.#attachment;
              return adapter.sendRunInput?.(...input);
            },
          }),
    };
    // A turn that is being stopped takes no follow-up: with no way to send one, the chat disables its
    // composer.
    const {
      sendRunInput: _sendRunInput,
      ordersRunInput: _ordersRunInput,
      ...withoutRunInput
    } = this.adapter;
    this.#stoppingAdapter = withoutRunInput;
  }

  /**
   * Whether a transport of this session is open or opening: an attach reading the thread, or a turn
   * of the controller (an opener's request, a hidden turn, a promoted follow-up, a retry) whose
   * transport has not ended. A page that comes back to the session reads this rather than opening a
   * second attachment over the same run.
   */
  get transportActive(): boolean {
    return this.attaching || this.#controllerTransport !== undefined;
  }

  /** What the chat is given: the session's adapter, and while a stop is being held, one that sends no follow-up. */
  get chatAdapter(): ChatSessionController['adapter'] {
    return this.stopping ? this.#stoppingAdapter : this.adapter;
  }

  /**
   * Sends again what a refused resume kept, before the message the person has just typed. The
   * wiring holds every entry, so the resume is a turn of its own over a hidden row, as the attach
   * is, and needs no row of the person's to carry it. When what is owed leaves a question without an
   * answer, nothing is sent here: the message is that answer. A resume that is still refused leaves
   * the message unsent and says so, so the chat keeps what was typed.
   */
  async #repeatOwedResume(): Promise<void> {
    if (!this.#wiring.owesResume() || this.#wiring.owedResumeIncomplete()) return;
    await this.#sendHiddenTurn().catch(() => undefined);
    // A refusal is answered by reading the thread again, which decides what is still owed.
    await this.#attachment;
    if (this.#wiring.owesResume()) throw new Error(CHAT_COPY.answersNotApplied);
    // The resume may have succeeded without a terminal snapshot. Re-read the authoritative
    // transcript before admitting the new turn so an old action-required row cannot keep the
    // controller's ordinary pending-approval gate closed.
    if (!(await this.refresh())) throw new Error(CHAT_COPY.answersNotApplied);
  }

  /**
   * Drops the rows that held answers the mount has taken. The run holds each answer as a row of its
   * own, and a typed row left beside it would show the answer twice and be sent to the agent again
   * by the next start.
   */
  #dropSettledAnswerRows(): void {
    const settled = this.#wiring.takeSettledAnswerRows();
    if (settled.length === 0) return;
    this.conversation = settled.reduce(
      (current, id) => (current.messages[id] === undefined ? current : removeMessage(current, id)),
      this.conversation,
    );
  }

  /** The schema of the question the answer row with `key` answered, when the page was shown it. */
  schemaOfAnswer = (key: string): Readonly<Record<string, unknown>> | undefined =>
    this.#questionSchemas.get(key);

  /**
   * Answers the question of `interruptId` with `value`, an answer given in the control its schema
   * drew (a choice, a number, a file's asset). It is held with the rest of what the run waits on,
   * like a typed answer, and when it is the last thing the run waits on the resume goes: it is a
   * turn of its own over a hidden row, as the attach is, since no row of the person's carries it.
   * Resolves `false` when the question is not waiting for an answer, the answers owed from a
   * refused resume could not be sent first, or the resume that carried the value was not applied:
   * the question is then asked again, with the reason in `failure`.
   */
  async answerQuestion(interruptId: string, value: unknown): Promise<boolean> {
    if (this.streaming || this.attaching || this.#abort.signal.aborted) return false;
    // The caller owns `value`, and this reads it after the awaits below.
    const answer = structuredClone(value);
    await this.#attachment;
    try {
      await this.#repeatOwedResume();
    } catch (error) {
      // The answer is not held on top of a resume that is still refused.
      this.failure = error instanceof Error ? error.message : String(error);
      return false;
    }
    // A turn that began while those finished would take the answer as a follow-up.
    if (this.streaming || this.#abort.signal.aborted) return false;
    // A deleted chat is not written to: the resume would start it again under the same identifier.
    if (this.#closed?.() === true) {
      this.failure = CHAT_COPY.gone.title;
      return false;
    }
    if (!this.#wiring.holdValue(interruptId, answer)) return false;
    if (this.humanRequests.length === 0 && this.approvals.length === 0) {
      this.#activeTurn = this.#sendHiddenTurn().catch(() => undefined);
      await this.#activeTurn;
      // A refusal is answered by reading the thread again, which decides what the run still waits on.
      await this.#attachment;
      // A value still held after the turn was not applied (a failed request, a refused or busy
      // thread). Nothing of the person's holds it, so it is let go and the control comes back with
      // the reason, rather than leaving a run parked with no question to answer.
      if (this.#wiring.releaseValue(interruptId)) {
        this.failure ??= CHAT_COPY.answerNotSent;
        return false;
      }
    }
    return true;
  }

  /**
   * Holds `message` as the answer to the next question when it cannot be the last thing a resume
   * waits for: another question still waits, or a tool approval does. The row is put in the
   * conversation as a sent one would be, and nothing is sent. Otherwise the controller sends it,
   * and the wiring finds the answer in it.
   */
  #holdsAsAnswer(message: MessageInput): boolean {
    const waiting = this.humanRequests.length;
    if (this.streaming || waiting === 0) return false;
    if (waiting === 1 && this.approvals.length === 0) return false;
    const next = appendMessages(this.conversation, message);
    const rowId = next.ids.at(-1);
    if (rowId === undefined) return false;
    if (!this.controller.adoptHistory(next, this.controller.captureHistoryToken())) return false;
    return this.#wiring.holdAnswer(inputPayload(message), rowId);
  }

  /**
   * After a resume the mount refused, reads what the thread is waiting on again, through the attach
   * the page makes when it opens. The entries still owed are kept and the others dropped, and a
   * question the page did not know is shown.
   */
  #readAgainAfterRefusal(): void {
    const refused = this.#refused ?? this.#wiring.takeRefusal();
    this.#refused = undefined;
    if (refused?.resume !== true || this.#abort.signal.aborted) return;
    void this.#readAgain();
  }

  async #readAgain(): Promise<boolean> {
    const reconnected = await this.attach({ rereading: true });
    this.#dropSettledAnswerRows();
    return reconnected;
  }

  #stampAnnouncedAssets(): void {
    const announced = this.#wiring.drainAssets();
    if (announced.length === 0) return;
    // On the rows the turn made, else the turn's last row: never on a reply of an earlier turn.
    this.conversation = withAnnouncements(this.conversation, announced, {
      owns: (id) => this.#wiring.ownsRow(id),
    });
  }

  /**
   * Reads the thread again and shows what the Bureau holds, replacing the rows on screen. A decision
   * made somewhere else (`/reviews`, a run's page, another tab) is written into the conversation by
   * the Bureau, and the rows here still show the approval as parked. A turn that is going, or a read
   * in progress, is left alone: it is the page's own.
   *
   * What the run waits on is not in the transcript, so it is read again the way the page reads it
   * when it opens (`attach`): a question answered elsewhere is no longer owed, and one the run still
   * waits on comes back. Without that, the person's next message would be sent as the answer to a
   * question the Bureau has settled, and the Bureau would refuse it.
   */
  async refresh(): Promise<boolean> {
    // A new chat's thread is not kept until its first run begins: there is nothing to read yet.
    if (!this.#opened) return false;
    if (this.streaming || this.attaching || this.#abort.signal.aborted) return false;
    // A turn that began during the read, even one that has ended since (a follow-up promoted from
    // Up next that stopped on an approval), wrote rows the read cannot hold: restoring it would
    // drop the person's message from the transcript.
    const turnsBegun = this.#turnsBegun;
    const history = await this.#wiring.history(this.sessionId, this.#abort.signal);
    if (history === undefined || this.streaming || this.attaching) return false;
    if (this.#turnsBegun !== turnsBegun) return false;
    this.restore(history);
    await this.attach({ rereading: true });
    // A read that failed has not said what the run waits on, so the caller reads again.
    return !this.#attachFailed;
  }

  /** Replaces the latest ended answer through Bureau without starting an AG-UI/tool turn. */
  async regenerateAnswer(messageId: string): Promise<void> {
    if (this.#closed?.() === true || this.streaming || this.attaching || this.transportActive)
      return;
    if (this.#regenerationPromise !== undefined) return this.#regenerationPromise;
    const previous = this.regeneration;
    const commandId =
      previous?.messageId === messageId ? previous.commandId : `regenerate:${crypto.randomUUID()}`;
    this.regeneration = { messageId, commandId, status: 'running' };
    const attempt = (async () => {
      try {
        await regenerateContext(
          { contextId: this.sessionId, commandId, messageId },
          { signal: this.#abort.signal },
        );
        if (!(await this.refresh())) throw new Error(CHAT_COPY.regeneration.readbackFailed);
        this.regeneration = undefined;
      } catch (error) {
        if (this.#abort.signal.aborted || this.#closed?.() === true) return;
        this.regeneration = {
          messageId,
          commandId,
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
        };
      }
    })();
    const settled = attempt.finally(() => {
      if (this.#regenerationPromise === settled) this.#regenerationPromise = undefined;
    });
    this.#regenerationPromise = settled;
    return settled;
  }

  /**
   * Sends `content` as the person's next message, as if it had been typed in the composer. It waits
   * for the attach in progress, so it goes to the run the attach joins, or starts one when there is
   * none. A failure is shown on the row, which offers Retry, and in `failure`.
   */
  send(content: string): Promise<void> {
    return this.adapter.sendMessage({ role: 'user', content }, []);
  }

  /** Stops telling the person of the last failure. */
  dismissFailure(): void {
    this.failure = undefined;
  }

  /**
   * Runs the last turn again: the person's message is sent as a new turn after the failed attempt,
   * which stays on record, here and in the Bureau's thread, with its status line (B06, row 20b).
   * It never resumes a call the run was in the middle of: the agent decides again over a thread
   * that shows what happened, and a tool that may change things and was interrupted goes back
   * through its approval (row 20c), because the chat's "Allow for the rest of this chat" grant for
   * every tool `tools` classifies that way among the turn's unanswered calls is forgotten first
   * (`forgetContextGrants`), so a refund cannot be issued twice unasked. When the grant cannot be
   * forgotten, nothing is sent and the failure says so. A last message with files, or one that is
   * not plain text, is not offered again here (`canRetryTurn`).
   */
  async retryTurn(options: { readonly tools?: ReadonlyMap<string, ToolInfo> } = {}): Promise<void> {
    const id = this.#lastUserRowId();
    const row = id === undefined ? undefined : this.conversation.messages[id];
    const text = row === undefined ? undefined : retryText(row);
    if (id === undefined || text === undefined) return;
    const tools = this.interruptedCallsThatMayChange(options.tools);
    if (tools.length > 0) {
      try {
        await forgetContextGrants(
          { contextId: this.sessionId, tools },
          { signal: this.#abort.signal },
        );
      } catch (error) {
        if (this.#abort.signal.aborted) return;
        if (isNotFound(error)) this.#onNotFound?.();
        this.failure = CHAT_COPY.stopLine.retryFailed;
        return;
      }
    }
    this.failure = undefined;
    return this.send(text);
  }

  /** Retries only an expired approval that belongs to the current final turn. */
  async retryExpiredApproval(
    toolCallId: string,
    options: {
      readonly tools?: ReadonlyMap<string, ToolInfo>;
      /** Durable review expiry can supersede a stale action deadline in the transcript. */
      readonly expiredAt?: number;
      /** The approval identity currently rendered by the chat, including its round. */
      readonly approvalKey?: string;
    } = {},
  ): Promise<void> {
    if (this.streaming || this.attaching || this.transportActive || this.#abort.signal.aborted) {
      return;
    }
    const rows = this.conversation.ids
      .slice(lastTurnStart(this.conversation))
      .flatMap((rowId) => this.conversation.messages[rowId] ?? []);
    const pair = pairToolCallsWithResults(rows).findLast(({ call }) => call.id === toolCallId);
    const actionExpiresAt =
      pair?.result?.action?.type === 'approval' ? pair.result.action.expiresAt : undefined;
    if (pair === undefined || pair.result?.outcome !== 'action_required') {
      return;
    }
    const deadline =
      options.expiredAt ??
      (actionExpiresAt === undefined ? Number.NaN : Date.parse(actionExpiresAt));
    const now = this.clock.now();
    if (!Number.isFinite(deadline) || deadline > now) {
      return;
    }
    const changes = mayChange(options.tools?.get(pair.call.name)?.tier);
    const finalUserRowId = this.#lastUserRowId();
    const finalUserRow =
      finalUserRowId === undefined ? undefined : this.conversation.messages[finalUserRowId];
    const text = finalUserRow === undefined ? undefined : retryText(finalUserRow);
    const expectedAction = pair.result.action;
    if (expectedAction?.type !== 'approval') {
      return;
    }
    const expectedActionFingerprint = approvalActionFingerprint(expectedAction);
    const expectedCallFingerprint = approvalActionFingerprint(pair.call);
    const expectedResultRow = rows.find((row) => row.toolResult === pair.result);
    const expectedResultRowId = expectedResultRow?.id;
    const expectedRunId =
      expectedResultRowId === undefined
        ? undefined
        : parseStepRowIdentifier(expectedResultRowId)?.runId;
    const expectedRound = approvalRound(expectedResultRow);
    const expectedApprovalKey =
      expectedResultRowId === undefined || expectedRunId === undefined
        ? undefined
        : `approval:${expectedRunId}:${
            parseStepRowIdentifier(expectedResultRowId)?.callId ?? pair.result.callId
          }:${expectedResultRowId}:round:${expectedRound ?? 'unknown'}`;
    const expectedReviewId = this.approvals.find(({ result }) => result === pair.result)?.message
      .id;
    if (
      expectedActionFingerprint === undefined ||
      expectedCallFingerprint === undefined ||
      expectedResultRowId === undefined ||
      (options.approvalKey !== undefined && options.approvalKey !== expectedApprovalKey)
    )
      return;
    if (text === undefined) {
      return;
    }
    if (changes) {
      try {
        await forgetContextGrants(
          { contextId: this.sessionId, tools: [pair.call.name] },
          { signal: this.#abort.signal },
        );
      } catch (error) {
        if (this.#abort.signal.aborted) {
          return;
        }
        if (isNotFound(error)) this.#onNotFound?.();
        this.failure = CHAT_COPY.stopLine.retryFailed;
        return;
      }
    }
    // Replay the exact final user input only if the approval is still the one this operation read.
    // The result can be renewed in place while grant cleanup is awaiting the Bureau; its action
    // payload may be identical, so the row's Bureau round is part of this host-side fence.
    const latestRows = this.conversation.ids
      .slice(lastTurnStart(this.conversation))
      .flatMap((rowId) => this.conversation.messages[rowId] ?? []);
    const latestPair = pairToolCallsWithResults(latestRows).findLast(
      ({ call }) => call.id === toolCallId,
    );
    const latestResultRow = latestRows.find((row) => row.toolResult === latestPair?.result);
    const latestResultRowId = latestResultRow?.id;
    const latestRunId =
      latestResultRowId === undefined
        ? undefined
        : parseStepRowIdentifier(latestResultRowId)?.runId;
    const latestApprovalKey =
      latestResultRowId === undefined || latestRunId === undefined
        ? undefined
        : `approval:${latestRunId}:${
            parseStepRowIdentifier(latestResultRowId)?.callId ?? latestPair?.result?.callId
          }:${latestResultRowId}:round:${approvalRound(latestResultRow) ?? 'unknown'}`;
    const latestReviewId = this.approvals.find(({ result }) => result === latestPair?.result)
      ?.message.id;
    if (
      this.#lastUserRowId() !== finalUserRowId ||
      latestPair === undefined ||
      latestPair.result?.outcome !== 'action_required' ||
      latestPair.result.action?.type !== 'approval' ||
      latestResultRowId !== expectedResultRowId ||
      (expectedRunId !== undefined && latestRunId !== expectedRunId) ||
      (expectedReviewId !== undefined && latestReviewId !== expectedReviewId) ||
      (expectedApprovalKey !== undefined && latestApprovalKey !== expectedApprovalKey) ||
      approvalActionFingerprint(latestPair.call) !== expectedCallFingerprint ||
      approvalActionFingerprint(latestPair.result.action) !== expectedActionFingerprint ||
      approvalRound(latestResultRow) !== expectedRound
    ) {
      return;
    }
    const reconciled = this.controller.reconcileApprovalExpiry({
      toolCallId,
      expiresAt: new Date(deadline).toISOString(),
      expectedAction,
    });
    if (!reconciled) {
      return;
    }
    this.failure = undefined;
    await this.send(text);
  }

  /**
   * The names of the tools the last turn called that may change things (the catalog says so, or
   * says nothing) and that have no answer: the calls the run was interrupted on, which may have run
   * and which a retry must put back through their approval. A call that finished has its result on
   * record, which the agent reads when it decides again, so its grant stands.
   */
  interruptedCallsThatMayChange(tools: ReadonlyMap<string, ToolInfo> | undefined): string[] {
    const rows = this.conversation.ids
      .slice(lastTurnStart(this.conversation))
      .flatMap((rowId) => this.conversation.messages[rowId] ?? []);
    const names = pairToolCallsWithResults(rows)
      .filter((pair) => pair.result === undefined && mayChange(tools?.get(pair.call.name)?.tier))
      .map((pair) => pair.call.name);
    return [...new Set(names)];
  }

  /** Whether the last turn can be run again here: its message is plain text and nothing is going. */
  get canRetryTurn(): boolean {
    if (this.streaming || this.attaching) return false;
    const id = this.#lastUserRowId();
    const row = id === undefined ? undefined : this.conversation.messages[id];
    return row !== undefined && retryText(row) !== undefined;
  }

  #lastUserRowId(): string | undefined {
    return this.conversation.ids.findLast((rowId) => {
      const row = this.conversation.messages[rowId];
      return row !== undefined && row.role === 'user' && !row.hidden;
    });
  }

  /** Reopens an interrupted attach, preserving the last SSE cursor in the wiring. */
  async reconnect(): Promise<boolean> {
    if (this.#abort.signal.aborted) return false;
    const generation = ++this.#retryGeneration;
    this.#readerAbort?.abort();
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#setRetryFailures(0);
    this.failure = undefined;
    await this.#activeTurn;
    if (generation !== this.#retryGeneration || this.#abort.signal.aborted) return false;
    return this.attach({ rereading: true });
  }

  /** The tool approvals the conversation is waiting on. */
  get approvals() {
    return getUnresolvedToolApprovals(this.conversation);
  }

  /**
   * Joins the run the session has going, if it has one. The run's stream is read as a turn of the
   * controller, under a row the person never sees, so everything a turn does (streaming text,
   * follow-ups, approvals) works on a run the page did not start.
   */
  attach(options: { readonly rereading?: boolean } = {}): Promise<boolean> {
    const attached = this.#attach(options.rereading === true);
    this.#attachment = attached.then(() => undefined);
    return attached;
  }

  /**
   * Whether the thread had a run to join. A thread that could not be read is the session's
   * failure, unless it is read again after a refusal: that one has a failure of its own to tell.
   */
  async #attach(rereading: boolean): Promise<boolean> {
    const generation = ++this.#retryGeneration;
    this.#readerAbort?.abort();
    const readerAbort = new AbortController();
    this.#readerAbort = readerAbort;
    const signal = AbortSignal.any([this.#abort.signal, readerAbort.signal]);
    this.attaching = true;
    this.#attachFailed = false;
    try {
      const restored = await this.#wiring.attach(this.sessionId, signal);
      if (generation !== this.#retryGeneration || signal.aborted) return false;
      if (restored === undefined) {
        // A new chat whose thread is not kept yet has no history to read, and the transcript on
        // screen is all there is.
        if (!this.#opened) {
          this.#attachedRun = false;
          return false;
        }
        // Nothing is going, so the transcript is what the Bureau holds of the thread.
        const history = await this.#wiring.history(this.sessionId, signal);
        if (generation !== this.#retryGeneration || signal.aborted) return false;
        if (history !== undefined) {
          this.restore(history);
          this.disconnected = false;
        }
        this.#attachedRun = false;
        return false;
      }
      this.restore(restored);
      // A run was restored, so the Bureau holds the thread.
      this.#opened = true;
      this.disconnected = false;
      this.#attachedRun = true;
      this.#activeTurn = this.#sendHiddenTurn().catch(() => undefined);
      return true;
    } catch (error) {
      // The page opened on a session it could not read: it says so, and it is not an unhandled
      // rejection with an empty transcript.
      if (generation !== this.#retryGeneration || signal.aborted) return false;
      this.#attachFailed = true;
      if (isNotFound(error)) this.#onNotFound?.();
      if (!rereading) this.failure = error instanceof Error ? error.message : String(error);
      this.#scheduleReconnect(error);
      return false;
    } finally {
      if (this.#readerAbort === readerAbort) this.attaching = false;
    }
  }

  /**
   * Starts a turn under a row the person never sees, which reads the run (an attach) or sends what
   * a refused resume still owes. The controller's hidden-turn entry point bypasses only the
   * ordinary new-turn approval gate; parked approval rows remain in the authoritative transcript
   * so attach and resume transport can preserve their identity (COR-1957).
   */
  #sendHiddenTurn(): Promise<void> {
    const carried = new Map(this.parkedApprovalRailIds);
    const carriedKeys = new Map(this.parkedApprovalKeys);
    for (const { message, result } of getUnresolvedToolApprovals(this.conversation)) {
      const parsed = parseStepRowIdentifier(message.id);
      if (parsed?.kind !== 'result') continue;
      const rawCallId = parsed.callId ?? result.callId;
      carried.set(result.callId, `approval:${parsed.runId}:${rawCallId}:call:${rawCallId}`);
      carriedKeys.set(
        result.callId,
        `approval:${parsed.runId}:${rawCallId}:${message.id}:round:${approvalRound(message) ?? 'unknown'}`,
      );
    }
    this.parkedApprovalRailIds = carried;
    this.parkedApprovalKeys = carriedKeys;
    return this.controller.sendHiddenMessage();
  }

  /** Replaces the transcript with the authoritative snapshot from the Bureau. */
  private restore(restored: ConversationHistory): void {
    // What the stream told this page about the run (a wakeup, a child run), and why an earlier
    // attempt stopped, are not in the Bureau's thread, so the rows that are still there keep them.
    this.#setKeepingStopLines(carryLiveNotes(this.conversation, restored));
    this.#reconcileApprovalDeadlines();
  }

  /**
   * Imports each deadline the run's interrupts gave into the approval it is for (COR-2280), through
   * the controller, which writes only a deadline that changed and only onto the approval action the
   * transcript holds now: the action is read here, just before, so nothing older can land on it.
   * An approval that is no longer waiting, or a call the transcript does not hold, is left alone.
   */
  #reconcileApprovalDeadlines(): void {
    for (const { toolCallId, expiresAt } of this.#approvalDeadlines) {
      const row = findToolResultMessage(this.conversation, toolCallId, { includeHidden: true });
      const action = row?.toolResult?.action;
      if (action?.type !== 'approval') continue;
      this.controller.reconcileApprovalExpiry({ toolCallId, expiresAt, expectedAction: action });
    }
  }

  /** Every line this page was shown of why a run stopped, by its identity, at its row. */
  #stopLines: ReadonlyMap<string, HeldStopLine> = new Map();

  /** How many turns of the controller have begun, so a read can tell that one began while it ran. */
  #turnsBegun = 0;

  /**
   * Shows `next`, with the lines of why an earlier run stopped that it does not give, so the
   * status line of a failed attempt Retry kept stays on its row (B06, row 20b).
   */
  #setKeepingStopLines(next: ConversationHistory): void {
    this.#stopLines = holdStopLines(this.#stopLines, this.conversation);
    this.conversation = withHeldStopLines(this.#stopLines, next);
  }

  /** Counts the failed reads in a row, and says so to the composer's reconnect line. */
  #setRetryFailures(failures: number): void {
    this.#retryFailures = failures;
    this.reconnectAttempt = failures;
  }

  #scheduleReconnect(error: unknown): void {
    if (this.#abort.signal.aborted) return;
    // A session that has given up is retried by the person, once per press: a `reconnect()` that
    // fails must not start the ladder again behind a page that still says it is disconnected.
    if (this.disconnected) return;
    if (error instanceof AgUiHttpError && [403, 404, 410].includes(error.status)) {
      this.disconnected = true;
      this.reconnectAttempt = 0;
      return;
    }
    this.#setRetryFailures(this.#retryFailures + 1);
    if (this.#retryFailures >= MAX_RECONNECT_ATTEMPTS) {
      this.disconnected = true;
      this.reconnectAttempt = 0;
      return;
    }
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    const generation = ++this.#retryGeneration;
    const delay = Math.min(500 * 2 ** (this.#retryFailures - 1), 10_000);
    // poll-reason: timer
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = undefined;
      void this.#retryAfter(generation);
    }, delay);
  }

  /**
   * A Stop while the page reconnects to a run whose stream dropped. Nothing is streaming, so the
   * controller has no turn to stop: the reconnect is retired (the scheduled one, and a read already
   * opening), so the page does not join the run again, and the run is cancelled through the route a
   * Stop on the live stream takes. The thread is then read as it is, which says why the run
   * stopped. When the Bureau did not take the cancellation, or the page knows no run to cancel
   * because it never read one, the failure says so, and Reconnect shows what is going.
   */
  async #stopWhileReconnecting(): Promise<void> {
    this.#retryGeneration += 1;
    this.#readerAbort?.abort();
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#setRetryFailures(0);
    this.stopping = true;
    try {
      const cancelled = await this.#wiring.cancelDroppedRun();
      if (this.#abort.signal.aborted) return;
      // No run known to cancel (the page never read one before the reads failed) is no stop either.
      if (cancelled !== true) {
        this.failure = CHAT_COPY.stopLine.stopFailed;
        this.disconnected = true;
        return;
      }
      this.#attachedRun = false;
      this.failure = undefined;
      const history = await this.#wiring
        .history(this.sessionId, this.#abort.signal)
        .catch(() => undefined);
      if (history !== undefined && !this.#abort.signal.aborted) this.restore(history);
    } finally {
      this.stopping = false;
    }
  }

  async #retryAfter(generation: number): Promise<void> {
    if (generation !== this.#retryGeneration || this.#abort.signal.aborted) return;
    await this.#activeTurn;
    if (generation !== this.#retryGeneration || this.#abort.signal.aborted) return;
    await this.#readAgain();
  }

  dispose(): void {
    // Leaving the page is not a stop: the run is the Bureau's, and it goes on.
    this.#wiring.detach();
    this.#abort.abort();
    this.#readerAbort?.abort();
    this.#retryGeneration += 1;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.controller.dispose();
    void this.#wiring.discardAttach();
  }
}

/** What a turn's message says when it is plain text, which is what a retry sends again; files are not repeated. */
function retryText(row: ConversationHistory['messages'][string]): string | undefined {
  return typeof row.content === 'string' && row.content.trim() !== '' ? row.content : undefined;
}
