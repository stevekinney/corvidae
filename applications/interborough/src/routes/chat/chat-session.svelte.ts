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
  type ChatSessionController,
  type ConversationHistory,
  type MessageInput,
} from '@lostgradient/chat';

import { sendContextInput, type Fetcher } from '../../lib/bureau-client.ts';
import { messageWithAttachments, runFailureMessage } from '../../lib/chat-attachments.ts';
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

  readonly controller: ChatSessionController;
  /**
   * What the page hands to Chat: the controller's adapter, whose sends wait for the attach to
   * finish. The controller starts a run for a message sent while nothing is going, and the attach
   * is the thing that finds out whether something is.
   */
  readonly adapter: ChatSessionController['adapter'];
  #attachment: Promise<void> = Promise.resolve();
  /** Whether the turn on screen carried files, which decides what the door's `INVALID_INPUT` is about. */
  #turnHadAttachments = false;
  /** What the turn that just failed was refused with, and what it would tell the person. */
  #refused: { readonly refusal: Refusal; readonly failure: string | undefined } | undefined;
  readonly #wiring: ChatRunWiring;
  readonly #abort = new AbortController();
  readonly sessionId: string;

  constructor(options: ChatSessionOptions) {
    this.sessionId = options.sessionId;
    this.conversation = createConversationHistory({ id: options.sessionId });
    this.#wiring = createChatRunWiring({
      conversation: () => this.conversation,
      ...(options.onRunStarted === undefined ? {} : { onRunStarted: options.onRunStarted }),
      agentName: options.agentName,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      onHumanRequests: (requests) => {
        this.humanRequests = requests;
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
            this.#stampAnnouncedAssets();
            this.#readAgainAfterRefusal();
          }
        },
        onError: (error) => {
          const failure =
            runFailureMessage(error, { hadAttachments: this.#turnHadAttachments }) ??
            (error instanceof Error ? error.message : String(error));
          const refusal = this.#wiring.takeRefusal();
          // A request that carried no answers owes nothing to be read again: its failure is told.
          if (refusal === undefined || !refusal.resume) {
            this.failure = failure;
            return;
          }
          this.#refused = { refusal, failure };
          // The next send retries a resume that was only busy. A `RUN_FAILED` is told once the
          // thread has been read again: it says whether an attempt is still applying the answers.
          if (refusal.code !== 'THREAD_BUSY' && refusal.code !== 'RUN_FAILED') {
            this.failure = failure;
          }
        },
      },
    });
    const adapter = this.controller.adapter;
    this.adapter = {
      ...adapter,
      sendMessage: async (message, attachments) => {
        this.#turnHadAttachments = attachments.length > 0;
        await this.#attachment;
        if (this.#holdsAsAnswer(message)) return;
        return adapter.sendMessage(messageWithAttachments(message, attachments), attachments);
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
   * question the page did not know is shown. A `RUN_FAILED` is told only when the thread has
   * nothing to attach to: its approvals were applied, so no attempt is still applying them.
   */
  #readAgainAfterRefusal(): void {
    const refused = this.#refused ?? this.#wiringRefusal();
    this.#refused = undefined;
    if (refused === undefined || !refused.refusal.resume || this.#abort.signal.aborted) return;
    void this.#readAgain(refused.refusal.code, refused.failure);
  }

  async #readAgain(code: string | undefined, failure: string | undefined): Promise<void> {
    const found = await this.attach({ rereading: true });
    if (code === 'RUN_FAILED' && !found && failure !== undefined) this.failure = failure;
  }

  /** A refusal no error reported, because the person stopped the turn before it arrived. */
  #wiringRefusal(): { readonly refusal: Refusal; readonly failure: undefined } | undefined {
    const refusal = this.#wiring.takeRefusal();
    return refusal === undefined ? undefined : { refusal, failure: undefined };
  }

  #stampAnnouncedAssets(): void {
    const announced = this.#wiring.drainAssets();
    if (announced.length > 0) this.conversation = withAssetParts(this.conversation, announced);
  }

  /** Stops telling the person of the last failure. */
  dismissFailure(): void {
    this.failure = undefined;
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
    this.attaching = true;
    try {
      const restored = await this.#wiring.attach(this.sessionId, this.#abort.signal);
      if (restored === undefined) {
        // Nothing is going, so the transcript is what the Bureau holds of the thread.
        const history = await this.#wiring.history(this.sessionId, this.#abort.signal);
        if (history !== undefined) this.restore(history);
        return false;
      }
      // The stream's own events, not this row, are the transcript: the terminal history drops it.
      // Errors are the controller's to report.
      void this.controller.adapter
        .sendMessage({ role: 'user', content: '', hidden: true }, [])
        .catch(() => undefined);
      // The run is going, so the transcript is restored now and the person sees it while the run
      // carries on, not at its end. The terminal history replaces each of these rows with its own.
      this.restore(restored);
      return true;
    } catch (error) {
      // The page opened on a session it could not read: it says so, and it is not an unhandled
      // rejection with an empty transcript.
      if (!rereading) this.failure = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      this.attaching = false;
    }
  }

  /**
   * Puts the rows the Bureau holds ahead of the ones on screen. The person may have started typing
   * while the transcript was being read, so what is on screen stays, and a row both have is the one
   * on screen. It goes ahead of the row a turn is streaming into.
   */
  private restore(restored: ConversationHistory): void {
    const current = this.conversation;
    const known = new Set(current.ids);
    this.conversation = {
      ...current,
      ids: [...restored.ids.filter((id) => !known.has(id)), ...current.ids],
      messages: { ...restored.messages, ...current.messages },
    };
  }

  dispose(): void {
    // Leaving the page is not a stop: the run is the Bureau's, and it goes on.
    this.#wiring.detach();
    this.#abort.abort();
    this.controller.dispose();
    void this.#wiring.discardAttach();
  }
}
