/**
 * One chat session's state: the conversation Chat renders, whether a run is going, and the
 * session controller that sends turns and follow-ups. A session is a Bureau context, and the
 * conversation's id is its id, which is the AG-UI thread (`run-wiring.ts`).
 *
 * The page may open on a session whose run is still going (a reload, a link). `attach()` joins
 * that run: its stream restores the transcript from the mount's snapshot and carries on live. A
 * session with nothing going has its transcript read from the mount (`wiring.history`), so a
 * finished session opens on all of it, in order.
 */
import {
  assertRunInputAccepted,
  createChatSessionController,
  createConversationHistory,
  getUnresolvedToolApprovals,
  type ChatSessionController,
  type ConversationHistory,
  type MessageInput,
} from '@lostgradient/chat';

import { sendContextInput, type Fetcher } from '../../lib/bureau-client.ts';
import { createChatRunWiring, type ChatRunWiring } from './run-wiring.ts';

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
  /** What the last failed turn said, for a person who needs to know why a row is marked failed. */
  failure = $state<string | undefined>(undefined);
  /** Whether the session opened on a run that was going, and is still reading it. */
  attaching = $state(false);

  readonly controller: ChatSessionController;
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
        },
        onError: (error) => {
          this.failure = error instanceof Error ? error.message : String(error);
        },
      },
    });
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
  async attach(): Promise<void> {
    this.attaching = true;
    try {
      const restored = await this.#wiring.attach(this.sessionId, this.#abort.signal);
      if (restored === undefined) {
        // Nothing is going, so the transcript is what the Bureau holds of the thread.
        const history = await this.#wiring.history(this.sessionId, this.#abort.signal);
        if (history !== undefined) this.restore(history);
        return;
      }
      // The stream's own events, not this row, are the transcript: the terminal history drops it.
      // Errors are the controller's to report.
      void this.controller.adapter
        .sendMessage({ role: 'user', content: '', hidden: true }, [])
        .catch(() => undefined);
      // The run is going, so the transcript is restored now and the person sees it while the run
      // carries on, not at its end. The terminal history replaces each of these rows with its own.
      this.restore(restored);
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
    this.#abort.abort();
    this.controller.dispose();
    void this.#wiring.discardAttach();
  }
}
