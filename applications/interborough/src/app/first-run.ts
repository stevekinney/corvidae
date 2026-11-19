/**
 * The first-run checklist's state: which of its three steps the host's answers say are done, and the
 * two facts kept in the browser (`localStorage`, as the shell's other personal preferences are).
 *
 * A step is done by a signal the host already gives, not by a flag the checklist keeps: a provider
 * is connected once the host says it can be called, which is when it holds a key or declares no
 * secret to hold one (`connected` of `GET /host/providers`, the rule Settings › Models states), an
 * agent exists once the Bureau lists one defined in a file (`bureau.agents.list`), and a chat
 * exists once the Bureau lists a session a person started (`bureau.contexts.list`). Nothing here
 * reads or keeps a key.
 *
 * Home's checklist (`routes/home/home-first-run.svelte`) reads the same signals under one more
 * rule: it is over when the chat step is done, whatever the other two say, and it never returns
 * (`homeChecklistShows`). Two things it keeps in the browser: that the person chose Assistant for the
 * second step, and that a chat has happened.
 */

/** The `localStorage` key that holds the choice to start from Assistant (the second step's quiet link). */
export const FIRST_RUN_ASSISTANT_KEY = 'interborough:first-run:assistant';

/** The `localStorage` key that holds that a chat has happened, so the checklist never returns. */
export const FIRST_RUN_SAID_HELLO_KEY = 'interborough:first-run:said-hello';

/** The three steps, in the order the checklist shows them. */
export const FIRST_RUN_STEPS = ['provider', 'agent', 'chat'] as const;

/** One step of the checklist. */
export type FirstRunStepId = (typeof FIRST_RUN_STEPS)[number];

/** What the host's answers say of each step: `true` once it is done. */
export type FirstRunProgress = Readonly<Record<FirstRunStepId, boolean>>;

/** The signals the steps read. */
export interface FirstRunSignals {
  /** The providers `GET /host/providers` lists, each with whether it can be called (a saved key, or none needed). */
  readonly providers: readonly { readonly connected: boolean }[];
  /** The agents `bureau.agents.list` lists, each with where it is defined. */
  readonly agents: readonly { readonly kind: 'code' | 'file' }[];
  /** How many chats a person started that the Bureau lists (at least one is enough). */
  readonly chatCount: number;
  /**
   * Whether the person chose to start from Assistant, which is the second step's other way to be
   * done: Assistant ships with the host and works with no provider, so choosing it needs nothing
   * to be created.
   */
  readonly assistantChosen?: boolean;
}

/** Whether a provider can be called: it holds a key, or declares no secret to hold one. */
export function providerConnected(providers: FirstRunSignals['providers']): boolean {
  return providers.some((provider) => provider.connected);
}

/** Which steps the signals say are done. */
export function firstRunProgress(signals: FirstRunSignals): FirstRunProgress {
  return {
    provider: providerConnected(signals.providers),
    agent:
      signals.assistantChosen === true || signals.agents.some((agent) => agent.kind === 'file'),
    chat: signals.chatCount > 0,
  };
}

/**
 * Whether Home's checklist is showing: until the chat step is done, whatever the provider and agent
 * steps say, because a person who has said hello has seen a chat work and the checklist has done its
 * job (the provider notice then moves to Needs attention). `saidHello` is that the person had a chat
 * before, kept in the browser, so deleting every chat does not bring the checklist back.
 */
export function homeChecklistShows(progress: FirstRunProgress, saidHello: boolean): boolean {
  return !saidHello && !progress.chat;
}

/**
 * Whether a chat can work now, and if not, the step it is missing (COR-2438): every place a chat is
 * started (the chat list with no chats, New chat in the sidebar and its key, the command palette,
 * Home's Start a chat, the new chat's composer) reads this one answer, from the signals the
 * checklist's steps read, so none offers an action that cannot work.
 *
 * A chat is with an agent Chat offers (a hidden agent is not). A scripted agent names no model
 * (`media` is `null`), so a chat with it works with no provider, as Assistant's does. Any other
 * agent needs a provider that can be called. With neither a provider nor an agent, the provider is
 * the first step, as on the checklist.
 */
export type ChatReadiness = 'ready' | 'needs-provider' | 'needs-agent';

/** The signals {@link chatReadiness} reads. */
export interface ChatReadinessSignals {
  /** The providers `GET /host/providers` lists. */
  readonly providers: FirstRunSignals['providers'];
  /** The agents `bureau.agents.list` lists: `media` is `null` for one that names no model. */
  readonly agents: readonly {
    readonly media: unknown;
    readonly visibility?: 'hidden' | undefined;
  }[];
}

/** Whether a chat can work now, or the step it is missing. */
export function chatReadiness(signals: ChatReadinessSignals): ChatReadiness {
  const offered = signals.agents.filter((agent) => agent.visibility !== 'hidden');
  if (offered.some((agent) => agent.media === null)) return 'ready';
  if (!providerConnected(signals.providers)) return 'needs-provider';
  return offered.length > 0 ? 'ready' : 'needs-agent';
}

/** Where the step a chat is missing is taken. */
export const CHAT_READINESS_PATHS: Readonly<Record<Exclude<ChatReadiness, 'ready'>, string>> = {
  'needs-provider': '/settings/models',
  'needs-agent': '/agents/new',
};

/** How many steps are still open, which says how far the person has to go. */
export function stepsLeft(progress: FirstRunProgress): number {
  return FIRST_RUN_STEPS.filter((step) => !progress[step]).length;
}

/** A flag in `storage`. Storage that cannot be read means it was not set. */
function readFlag(key: string, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined): boolean {
  if (storage === undefined) return false;
  try {
    return storage.getItem(key) === 'true';
  } catch {
    return false;
  }
}

/** Keeps a flag. Storage that is full or blocked keeps it for this page only. */
function writeFlag(key: string, storage: Pick<Storage, 'getItem' | 'setItem'> | undefined): void {
  if (storage === undefined) return;
  try {
    storage.setItem(key, 'true');
  } catch {
    // Storage that refuses the write keeps the flag for this page only.
  }
}

/** Whether the person chose to start from Assistant. Storage that cannot be read means they did not. */
export function readAssistantChosen(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultStorage(),
): boolean {
  return readFlag(FIRST_RUN_ASSISTANT_KEY, storage);
}

/** Keeps the choice to start from Assistant. Storage that is full or blocked keeps it for this page only. */
export function writeAssistantChosen(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultStorage(),
): void {
  writeFlag(FIRST_RUN_ASSISTANT_KEY, storage);
}

/** Whether a chat has happened in this browser's workspace. Storage that cannot be read means none has. */
export function readSaidHello(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultStorage(),
): boolean {
  return readFlag(FIRST_RUN_SAID_HELLO_KEY, storage);
}

/** Keeps that a chat has happened, so the checklist never returns. Storage that is full or blocked keeps it for this page only. */
export function writeSaidHello(
  storage: Pick<Storage, 'getItem' | 'setItem'> | undefined = defaultStorage(),
): void {
  writeFlag(FIRST_RUN_SAID_HELLO_KEY, storage);
}

/** The page's `localStorage`, or `undefined` where reaching it throws (a blocked or private window). */
function defaultStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
