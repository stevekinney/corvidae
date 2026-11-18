/**
 * What the chat's composer says about the chat right now: a blocked row that replaces the text box
 * when sending is not possible, or else the line under it. Both are `@lostgradient/chat`'s
 * `composerStatus`; this turns what the page knows into the one that applies.
 *
 * The server being unreachable comes first, as a warning drawer above the box (COR-2284 C5): Chat's
 * offline drawer when the browser is offline, and one that says Interborough can't be reached when
 * only the host is down (row 17b's words). The draft stays in the box and Send is off until the
 * server answers (Retry lives in the banner, so the drawer has no action). While the shell's banner
 * already says what is down, the drawer says only what is true of the draft. Otherwise a blocked row says the first of these that holds,
 * because each makes the ones after it moot: the host is restarting after a plugin was enabled, the
 * chat is archived (Chat's neutral Archived bar, with New chat and the primary Unarchive), the
 * chat's agent comes from a disabled plugin, the host stopped the chat when it restarted, a chat
 * started from Workflows has no agent that can create workflows, or no provider is connected for an
 * agent that needs a model.
 * Otherwise the composer says, in this order, the reconnect count, a draft put back from the draft
 * store with when it was written (COR-2284 C7), a queued follow-up, a note about a setting that was
 * just changed, and, while the chat is working, that a message sent now waits for the run to finish.
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

/** A draft the page put back in the composer from the draft store (`chat-drafts.ts`). */
export interface RestoredDraft {
  /** When the draft was written, in words, such as `yesterday at 4:12 PM`. */
  readonly when: string;
  /** Forgets the draft once Discard draft has emptied the composer. */
  readonly discard: () => void;
}

/** What the page knows that decides the composer's status. */
export interface ComposerFacts {
  /** The server does not answer. */
  readonly unreachable: boolean;
  /** The browser itself reports that it is offline, so the server's silence is the network's. */
  readonly browserOffline?: boolean | undefined;
  /** The shell's banner says the browser is offline or the server can't be reached. */
  readonly outageBannerShown?: boolean | undefined;
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
  /** The draft put back in the composer, until it is sent or discarded. */
  readonly restoredDraft?: RestoredDraft | undefined;
  /** Follow-ups the Bureau accepted that the run has not yet taken. */
  readonly queuedFollowUps: number;
  /** When a setting the person just changed takes effect, in words. */
  readonly note?: string | undefined;
  /**
   * The chat is working, so a message sent now waits in Chat's Up next queue and goes when the run
   * finishes.
   */
  readonly working: boolean;
}

const COPY = CHAT_COPY.composer;

/** The status the composer shows for `facts`, or `undefined` for the plain composer with its hint. */
export function composerStatusOf(facts: ComposerFacts): ChatComposerStatus | undefined {
  if (facts.unreachable) {
    // The shell's banner already says what is down: the drawer says only what is true of the draft,
    // so the outage is said once and the box stays above the fold on a phone.
    if (facts.outageBannerShown === true) {
      return {
        kind: 'drawer-notice',
        tone: 'warning',
        text: facts.browserOffline === true ? COPY.draftKept : COPY.draftKeptUntilReachable,
        sendDisabledReason: COPY.unreachable,
      };
    }
    // The browser itself is offline: Chat's offline drawer says so in its own words. Only the host
    // is down: the same warning drawer names the host, as row 17b does, with Send off for that reason.
    if (facts.browserOffline === true) return { kind: 'offline' };
    return {
      kind: 'drawer-notice',
      tone: 'warning',
      text: COPY.hostUnreachable,
      sendDisabledReason: COPY.unreachable,
    };
  }
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
  if (facts.restoredDraft !== undefined) {
    return {
      kind: 'draft-restored',
      when: facts.restoredDraft.when,
      ondiscard: facts.restoredDraft.discard,
    };
  }
  if (facts.queuedFollowUps > 0) return { kind: 'queued', count: facts.queuedFollowUps };
  if (facts.note !== undefined) return { kind: 'note', text: facts.note };
  if (facts.working) return { kind: 'note', text: COPY.working };
  return undefined;
}
