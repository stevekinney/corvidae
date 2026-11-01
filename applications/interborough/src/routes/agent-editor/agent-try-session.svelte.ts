/**
 * The throwaway chat behind the editor's Try it (COR-1911): one chat at a time with the agent as
 * the form describes it, saved or not.
 *
 * `bureau.agents.try` takes the definition and the first message, writes nothing (no agent file, no
 * catalog entry, no memory), and answers the chat's `contextId` and the `try:` name its agent runs
 * under. The agent exists in the Bureau's memory for that chat alone, so ending the chat is
 * deleting its context: `end()` does that, and it is what leaving does. A chat that is still being
 * started when it is ended is deleted as soon as it exists, so no start leaves one behind. Leaving
 * the page altogether (closing the tab, following an outside link) cannot wait for an answer, so
 * `pagehide` sends the same delete as a request that outlives the page.
 *
 * The chat itself is the application's chat session (`../chat/chat-session.svelte.ts`) over the
 * tried context, joined to the run the first message started, so follow-ups, stopping and
 * approvals behave as they do in Chat.
 */
import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import { agentFaultOf, tryAgent, type AgentDefinitionInput } from '../../lib/agent-definitions.ts';
import { deleteContext, wireCodeOf, type Fetcher } from '../../lib/bureau-client.ts';
import { ChatSessionState } from '../chat/chat-session.svelte.ts';

/** Where the trial is: waiting for a first message, starting the chat, or in the chat. */
export type TryPhase = 'idle' | 'starting' | 'chatting';

/** What a refused or failed start says, in words. */
function startFailureOf(error: unknown): string {
  const copy = AGENT_EDITOR_COPY.try;
  const fault = agentFaultOf(error);
  switch (fault.kind) {
    case 'forbidden':
      return copy.forbidden;
    case 'rejected':
    case 'other':
      return fault.message;
    case 'stale':
    case 'not-found':
    case 'identifier-taken':
      return copy.failed;
  }
}

/** A `fetch` whose request outlives the page, for the delete that `pagehide` sends. */
const outlivingFetch: Fetcher = (input, init) => fetch(input, { ...init, keepalive: true });

export class AgentTrySession {
  phase = $state<TryPhase>('idle');
  /** Why the last start did not happen, or `null`. */
  failure = $state<string | null>(null);
  /** The last chat could not be deleted, so it is left in the Bureau (out of the chat list). */
  removalFailed = $state(false);
  /** The chat in progress, or `undefined` when there is none. */
  chat = $state.raw<ChatSessionState | undefined>(undefined);
  /** The tried chat's context, or `undefined` when there is none. */
  contextId = $state<string | undefined>(undefined);
  /** The definition the chat was started with, as JSON, to tell when the form has moved on. */
  triedWith = $state<string | undefined>(undefined);
  /** Counts starts and ends, so an answer that arrives after an end knows it is too late. */
  #generation = 0;
  readonly #onPageHide = (): void => {
    if (this.contextId !== undefined) {
      void deleteContext(this.contextId, { fetch: outlivingFetch }).catch(() => undefined);
    }
  };

  /**
   * Starts a chat with `definition` and sends it `message`. Does nothing while a chat is going or
   * starting. A refusal (a definition the Bureau would not load as a file, a tool a trial may not
   * have) is `failure`, and nothing exists.
   */
  async start(definition: AgentDefinitionInput, message: string): Promise<void> {
    if (this.phase !== 'idle') return;
    const generation = ++this.#generation;
    // Read before the await: the form goes on changing while the Bureau starts the chat.
    const triedWith = JSON.stringify(definition);
    this.phase = 'starting';
    this.failure = null;
    this.removalFailed = false;
    let tried;
    try {
      tried = await tryAgent(definition, message);
    } catch (error) {
      if (generation === this.#generation) {
        this.phase = 'idle';
        this.failure = startFailureOf(error);
      }
      return;
    }
    if (generation !== this.#generation) {
      // Ended while it was starting: the chat exists now, and nobody is left to use it.
      await this.#remove(tried.contextId);
      return;
    }
    const chat = new ChatSessionState({
      sessionId: tried.contextId,
      agentName: () => tried.agentName,
    });
    this.chat = chat;
    this.contextId = tried.contextId;
    this.triedWith = triedWith;
    this.phase = 'chatting';
    window.addEventListener('pagehide', this.#onPageHide);
    // The first message is already running: joining it restores the transcript and carries on live.
    void chat.attach();
  }

  /**
   * Ends the trial: stops reading the chat and deletes its context, which takes the agent with it.
   * Safe to call at any time and more than once; a chat that cannot be deleted sets
   * `removalFailed`.
   */
  async end(): Promise<void> {
    this.#generation += 1;
    window.removeEventListener('pagehide', this.#onPageHide);
    const { chat, contextId } = this;
    this.chat = undefined;
    this.contextId = undefined;
    this.triedWith = undefined;
    this.phase = 'idle';
    chat?.dispose();
    if (contextId !== undefined) await this.#remove(contextId);
  }

  async #remove(contextId: string): Promise<void> {
    try {
      await deleteContext(contextId);
    } catch (error) {
      // A chat that is already gone is the outcome that was wanted.
      if (wireCodeOf(error) !== 'NotFound') this.removalFailed = true;
    }
  }
}
