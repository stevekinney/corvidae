/**
 * What the chat's composer says about the chat right now: a blocked row that replaces the text box
 * when sending is not possible, or else the line under it. Both are `@lostgradient/chat`'s
 * `composerStatus`; this turns what the page knows into the one that applies.
 *
 * A blocked row says the first of these that holds, because each makes the ones after it moot:
 * the server is unreachable (Retry lives in the banner, so the row has no action), the host is
 * restarting after a plugin was enabled, the chat is archived (Chat's neutral Archived bar, with New
 * chat and the primary Unarchive), the chat's agent comes from a disabled plugin, the host
 * stopped the chat when it restarted, a chat started from Workflows has no agent that can create
 * workflows, or no provider is connected for an agent that needs a model.
 * Otherwise the line under the box is, in this order, the reconnect count, a queued follow-up, a
 * note about a setting that was just changed, and the steering line while the chat is working.
 */
import type { ChatComposerStatus } from '@lostgradient/chat';

import { CHAT_COPY } from '../../app/copy/chat.ts';

/** An agent that cannot run because its plugin is disabled, and what enabling it does. */
export interface UnavailableAgent {
  /** The agent's name as a person reads it, such as `Release helper`. */
  readonly agent: string;
  /** The plugin's title, such as `Demo`. */
  readonly plugin: string;
  /** Opens the confirmation that enables the plugin and restarts the host. */
  readonly enable: () => void;
}

/** An archived chat: when it was archived, and the way back. */
export interface ArchivedChat {
  /** When the chat was archived, in words, such as `Nov 3`. */
  readonly when: string;
  /** Unarchives the chat, so the composer comes back. */
  readonly unarchive: () => void;
}

/** What the page knows that decides the composer's status. */
export interface ComposerFacts {
  /** The server does not answer. */
  readonly unreachable: boolean;
  /** The host is restarting after the person enabled a plugin. */
  readonly restarting: boolean;
  /**
   * The chat is archived, so it takes no message until it is unarchived. Unarchive is a write, so
   * the unreachable and restarting rows come first, as they do for every other write.
   */
  readonly archived?: ArchivedChat | undefined;
  /** The chat's agent, when it comes from a plugin that is disabled. */
  readonly unavailable?: UnavailableAgent | undefined;
  /** The host stopped the chat when it restarted, so its run cannot continue. */
  readonly ended: boolean;
  /** The agent needs a model, and no provider is connected. */
  readonly noProvider: boolean;
  /**
   * A new chat started from Workflows, and no agent has the Create workflow tool. What the person
   * typed is kept, and shows again once an agent that can create workflows exists.
   */
  readonly noWorkflowAgent?: boolean | undefined;
  /** Where the agents are listed. */
  readonly agentsHref?: string | undefined;
  /** Where a provider is connected. */
  readonly connectHref: string;
  /** Switches to Assistant, where the person may choose it (a new chat). */
  readonly useAssistant?: (() => void) | undefined;
  /** Starts a new chat. */
  readonly newChatHref: string;
  /** The failed reads in a row while the page retries the stream; `0` when it is up. */
  readonly reconnectAttempt: number;
  /** Follow-ups the Bureau accepted that the run has not yet taken. */
  readonly queuedFollowUps: number;
  /** When a setting the person just changed takes effect, in words. */
  readonly note?: string | undefined;
  /** The chat is working, so a message sent now steers the run. */
  readonly working: boolean;
}

const COPY = CHAT_COPY.composer;

/** The status the composer shows for `facts`, or `undefined` for the plain composer with its hint. */
export function composerStatusOf(facts: ComposerFacts): ChatComposerStatus | undefined {
  if (facts.unreachable) return { kind: 'blocked', reason: COPY.unreachable };
  if (facts.restarting) return { kind: 'blocked', reason: COPY.restarting };
  if (facts.archived !== undefined) {
    return {
      kind: 'archived',
      when: facts.archived.when,
      newChat: { label: COPY.newChat, href: facts.newChatHref },
      unarchive: { label: COPY.unarchive, onclick: facts.archived.unarchive, primary: true },
    };
  }
  if (facts.unavailable !== undefined) {
    return {
      kind: 'blocked',
      reason: COPY.pluginDisabled(facts.unavailable.agent, facts.unavailable.plugin),
      action: { label: COPY.enableAndRestart, onclick: facts.unavailable.enable },
    };
  }
  if (facts.ended) {
    return {
      kind: 'blocked',
      reason: COPY.ended,
      action: { label: COPY.newChat, href: facts.newChatHref },
    };
  }
  if (facts.noWorkflowAgent === true) {
    return {
      kind: 'blocked',
      reason: COPY.noWorkflowAgent,
      action: { label: COPY.openAgents, href: facts.agentsHref ?? '/agents' },
    };
  }
  if (facts.noProvider) {
    return {
      kind: 'blocked',
      reason: COPY.noProvider,
      action: { label: COPY.connectProvider, href: facts.connectHref },
      ...(facts.useAssistant === undefined
        ? {}
        : { link: { label: COPY.useAssistant, onclick: facts.useAssistant } }),
    };
  }
  if (facts.reconnectAttempt > 0) return { kind: 'reconnecting', attempt: facts.reconnectAttempt };
  if (facts.queuedFollowUps > 0) return { kind: 'queued', count: facts.queuedFollowUps };
  if (facts.note !== undefined) return { kind: 'note', text: facts.note };
  if (facts.working) return { kind: 'steering' };
  return undefined;
}
