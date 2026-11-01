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
  createChatSessionController,
  createConversationHistory,
  getUnresolvedToolApprovals,
  removeMessage,
  type ChatSessionController,
  type ConversationHistory,
  type MessageInput,
} from '@lostgradient/chat';

import { CHAT_COPY } from '../../app/copy.ts';
import { sendContextInput, type Fetcher } from '../../lib/bureau-client.ts';
import { messageWithAttachments, runFailureMessage } from '../../lib/chat-attachments.ts';
import { AgUiHttpError } from './ag-ui-events.ts';
import { questionKeyOf } from './answer-rows.ts';
import {
  createChatRunWiring,
  withAssetParts,
  type ChatRunWiring,
  type HumanRequest,
  type Refusal,
} from './run-wiring.ts';

export type ChatSessionOptions = {
  /** The session's identifier, which is the conversation's and the AG-UI thread's. */
  readonly sessionId: string;
  /** The agent the session's runs name. */
  readonly agentName: () => string;
  /** Replaces `fetch` for the AG-UI requests, for tests. */
  readonly fetch?: Fetcher;
  /** Told when a run this page started has begun. */
  readonly onRunStarted?: () => void;
};

/** The text a follow-up sends: the Bureau takes text, or a list of parts, as session input. */
function inputPayload(message: MessageInput): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join('\n');
}

/**
 * The transcript without the approvals a run is parked on. The controller refuses a turn while an
 * approval is pending, and a hidden turn is not a new one: it reads the run that parked them, whose
 * stream shows the call again and whose interrupts park each approval again (`run-wiring.ts`).
 */
function withoutParkedApprovals(history: ConversationHistory): ConversationHistory {
  return getUnresolvedToolApprovals(history).reduce(
    (current, { message }) => removeMessage(current, message.id),
    history,
  );
}

/** How many failed attempts in a row end the retries and leave the session disconnected. */
export const MAX_RECONNECT_ATTEMPTS = 8;

export class ChatSessionState {
  conversation = $state.raw<ConversationHistory>(createConversationHistory({ id: '' }));
  streaming = $state(false);
  /**
   * What the last failed turn said, for a person who needs to know why a row is marked failed. It
   * is cleared when the next turn begins or when the person dismisses it, so the same failure
   * again is told again.
   */
  failure = $state<string | undefined>(undefined);
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
  #retryTimer: ReturnType<typeof setTimeout> | undefined;
  #retryGeneration = 0;
  #retryFailures = 0;
  #attachedRun = false;
  /** The schema of each question the page has been shown, by the key its answer's row shares. */
  readonly #questionSchemas = new Map<string, Readonly<Record<string, unknown>>>();
  #readerAbort: AbortController | undefined;
  #activeTurn: Promise<unknown> = Promise.resolve();

  constructor(options: ChatSessionOptions) {
    this.sessionId = options.sessionId;
    this.conversation = createConversationHistory({ id: options.sessionId });
    this.#wiring = createChatRunWiring({
      conversation: () => this.conversation,
      onRunStarted: () => {
        this.#attachedRun = true;
        options.onRunStarted?.();
      },
      onFrame: () => {
        this.#retryFailures = 0;
        this.disconnected = false;
      },
      onTerminal: () => {
        this.#attachedRun = false;
      },
      onSnapshot: (history) => {
        if (!this.#abort.signal.aborted) this.restore(history);
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
      getConversation: () => this.conversation,
      setConversation: (next) => {
        this.conversation = next;
      },
      transport: this.#wiring.transport,
      // A follow-up goes to the run in flight. Its row id is the input's id, so a retry of the
      // same row is the same input.
      sendRunInput: async (conversationId, message, _attachments, { messageId }) => {
        const result = await sendContextInput(
          conversationId,
          { id: messageId, payload: inputPayload(message) },
          { signal: this.#abort.signal },
        );
        return assertRunInputAccepted(result.receipt);
      },
      hooks: {
        resolveToolApproval: (toolCallId, resolution) =>
          this.#wiring.resolveToolApproval(toolCallId, resolution),
        onStreamingChange: (streaming) => {
          this.streaming = streaming;
          // A new turn is a new attempt, and what failed before it is not what it will say. The
          // turn that reads a run the page joins is nobody's attempt: it is how the page finds out
          // what to say next, and must not wipe what the refusal before it said.
          if (streaming) {
            if (!this.attaching) this.failure = undefined;
          }
          // A turn that ended in an error or a stop has no history to carry the assets it
          // announced, so they are put on their rows here, as a completed turn's are.
          else {
            this.stopping = false;
            this.#stampAnnouncedAssets();
            this.#dropSettledAnswerRows();
            this.#readAgainAfterRefusal();
          }
        },
        onError: (error) => {
          const failure =
            runFailureMessage(error, { hadAttachments: this.#turnHadAttachments }) ??
            (error instanceof Error ? error.message : String(error));
          const refusal = this.#wiring.takeRefusal();
          if (refusal?.resume === true) this.#refused = refusal;
          // A busy thread is not told when it refused a resume: the next send repeats it. A start
          // refused as busy, and every other refusal, is.
          if (refusal?.resume !== true || !refusal.busy) this.failure = failure;
          if (this.#attachedRun && !this.#readerAbort?.signal.aborted)
            this.#scheduleReconnect(error);
        },
      },
    });
    const adapter = this.controller.adapter;
    this.adapter = {
      ...adapter,
      sendMessage: async (message, attachments) => {
        this.#turnHadAttachments = attachments.length > 0;
        await this.#attachment;
        // What a refused resume still owes goes first, so the new message reaches the agent after
        // it, once, and not as a row of the resume, which the mount never reads.
        await this.#repeatOwedResume();
        if (this.#holdsAsAnswer(message)) return;
        const turn = adapter.sendMessage(messageWithAttachments(message, attachments), attachments);
        this.#activeTurn = turn.catch(() => undefined);
        return turn;
      },
      stopGenerating: async (...input: Parameters<NonNullable<typeof adapter.stopGenerating>>) => {
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
    if (announced.length > 0) this.conversation = withAssetParts(this.conversation, announced);
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
    if (this.streaming || this.attaching || this.#abort.signal.aborted) return false;
    const history = await this.#wiring.history(this.sessionId, this.#abort.signal);
    if (history === undefined || this.streaming || this.attaching) return false;
    this.conversation = history;
    await this.attach({ rereading: true });
    // A read that failed has not said what the run waits on, so the caller reads again.
    return !this.#attachFailed;
  }

  /** Stops telling the person of the last failure. */
  dismissFailure(): void {
    this.failure = undefined;
  }

  /** Reopens an interrupted attach, preserving the last SSE cursor in the wiring. */
  async reconnect(): Promise<boolean> {
    if (this.#abort.signal.aborted) return false;
    const generation = ++this.#retryGeneration;
    this.#readerAbort?.abort();
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#retryFailures = 0;
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
      this.disconnected = false;
      this.#attachedRun = true;
      this.#activeTurn = this.#sendHiddenTurn().catch(() => undefined);
      return true;
    } catch (error) {
      // The page opened on a session it could not read: it says so, and it is not an unhandled
      // rejection with an empty transcript.
      if (generation !== this.#retryGeneration || signal.aborted) return false;
      this.#attachFailed = true;
      if (!rereading) this.failure = error instanceof Error ? error.message : String(error);
      this.#scheduleReconnect(error);
      return false;
    } finally {
      if (this.#readerAbort === readerAbort) this.attaching = false;
    }
  }

  /**
   * Starts a turn under a row the person never sees, which reads the run (an attach) or sends what
   * a refused resume still owes. The approvals the run is parked on leave the transcript first, so
   * the controller does not refuse the turn as a new one while they are pending (COR-1957).
   */
  #sendHiddenTurn(): Promise<void> {
    this.conversation = withoutParkedApprovals(this.conversation);
    return this.controller.adapter.sendMessage({ role: 'user', content: '', hidden: true }, []);
  }

  /** Replaces the transcript with the authoritative snapshot from the Bureau. */
  private restore(restored: ConversationHistory): void {
    this.conversation = restored;
  }

  #scheduleReconnect(error: unknown): void {
    if (this.#abort.signal.aborted) return;
    // A session that has given up is retried by the person, once per press: a `reconnect()` that
    // fails must not start the ladder again behind a page that still says it is disconnected.
    if (this.disconnected) return;
    if (error instanceof AgUiHttpError && [403, 404, 410].includes(error.status)) {
      this.disconnected = true;
      return;
    }
    this.#retryFailures += 1;
    if (this.#retryFailures >= MAX_RECONNECT_ATTEMPTS) {
      this.disconnected = true;
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
