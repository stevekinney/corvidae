/**
 * The throwaway chat behind the editor's Try it (COR-1911): one chat at a time with the agent as
 * the form describes it, saved or not.
 *
 * `bureau.agents.try` takes the definition and the first message, writes nothing (no agent file, no
 * catalog entry, no memory), and answers the chat's `contextId` and the `try:` name its agent runs
 * under. The agent exists in the Bureau's memory for that chat alone, so ending the chat is
 * deleting its context: `end()` does that, and it is what Reset and leaving do. Closing the sheet
 * Try it opens in on a tablet or phone does not end it: the transcript is kept for the next
 * opening (rows 43z, 44b). A chat that is still being
 * started when it is ended is deleted as soon as it exists, so no start leaves one behind. Leaving
 * the page altogether (closing the tab, following an outside link) cannot wait for an answer, so
 * `pagehide` sends the same delete as a request that outlives the page.
 *
 * The chat itself is the application's chat session (`../chat/chat-session.svelte.ts`) over the
 * tried context, joined to the run the first message started, so follow-ups, stopping and
 * approvals behave as they do in Chat. A tool that asks first is answered inside Try it
 * (`resolveApproval`, rows 43d, 43e), and the answer resumes this test run only.
 */

import type { ApprovalResolution } from '@lostgradient/cinder';

import { AGENT_EDITOR_COPY } from '../../app/copy.ts';
import { agentFaultOf, tryAgent, type AgentDefinitionInput } from '../../lib/agent-definitions.ts';
import { deleteContext, wireCodeOf, type Fetcher } from '../../lib/bureau-client.ts';
import { ChatSessionState } from '../chat/chat-session.svelte.ts';

/** Where the trial is: waiting for a first message, starting the chat, or in the chat. */
export type TryPhase = 'idle' | 'starting' | 'chatting';

/**
 * Where Try it is drawn: `beside` the form, always open, at desktop width (row 41n); a 360px
 * `right` sheet from 640 to 1023px (row 44a); a `bottom` sheet below 640px (row 43x). Below 1024px
 * a "Try it" button in the page header opens the sheet (row 43t).
 */
export type TryPlacement = 'beside' | 'right' | 'bottom';

/** The viewport below which Try it is a sheet opened from the page header, not a panel beside the form. */
export const TRY_SHEET_QUERY = '(max-width: 1023.98px)';

/** The viewport below which the sheet rises from the bottom edge instead of the right. */
export const TRY_BOTTOM_SHEET_QUERY = '(max-width: 639.98px)';

/** Where Try it is drawn, given whether the viewport is narrower than 1024px and than 640px. */
export function tryPlacementOf(sheet: boolean, phone: boolean): TryPlacement {
  if (!sheet) return 'beside';
  return phone ? 'bottom' : 'right';
}

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
  /** The answer to a tool approval that is on its way, or `undefined` when none is. */
  deciding = $state<'approve' | 'deny' | undefined>(undefined);
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
    this.deciding = undefined;
    this.phase = 'idle';
    chat?.dispose();
    if (contextId !== undefined) await this.#remove(contextId);
  }

  /**
   * Answers the tool approval the test run is parked on, the way Chat answers one: the decision,
   * the note and nothing else resume this run (rows 43d, 43e). A refused answer is reported by the
   * chat's controller and leaves the approval waiting for another try. Does nothing while no chat
   * is going or another answer is on its way.
   */
  async resolveApproval(toolCallId: string, resolution: ApprovalResolution): Promise<void> {
    const chat = this.chat;
    if (chat === undefined || this.deciding !== undefined) return;
    this.deciding = resolution.decision === 'deny' ? 'deny' : 'approve';
    try {
      await chat.controller.adapter.resolveToolApproval?.(toolCallId, resolution);
    } catch {
      // The controller reported it, and the approval is still pending for another try.
    } finally {
      if (this.chat === chat) this.deciding = undefined;
    }
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
