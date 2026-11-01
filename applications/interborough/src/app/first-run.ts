/**
 * The first-run checklist's two pieces of state that are not on the server: whether the person
 * dismissed it (kept in `localStorage`, as the shell's other personal preferences are), and which
 * of its three steps the host's answers say are done.
 *
 * A step is done by a signal the host already gives, not by a flag the checklist keeps: a provider
 * is connected once it holds a key (`GET /host/providers`, the rule Settings › Models states), an
 * agent exists once the Bureau lists one defined in a file (`bureau.agents.list`), and a chat
 * exists once the Bureau lists a session a person started (`bureau.contexts.list`). Nothing here
 * reads or keeps a key: only whether one is saved.
 */

/** The `localStorage` key that holds the dismissal. */
export const FIRST_RUN_DISMISSED_KEY = 'interborough:first-run:dismissed';

/** The three steps, in the order the checklist shows them. */
export const FIRST_RUN_STEPS = ['provider', 'agent', 'chat'] as const;

/** One step of the checklist. */
export type FirstRunStepId = (typeof FIRST_RUN_STEPS)[number];

/** What the host's answers say of each step: `true` once it is done. */
export type FirstRunProgress = Readonly<Record<FirstRunStepId, boolean>>;

/** The signals the steps read. */
export interface FirstRunSignals {
  /** The providers `GET /host/providers` lists, each with whether it holds a key. */
  readonly providers: readonly { readonly hasKey: boolean }[];
  /** The agents `bureau.agents.list` lists, each with where it is defined. */
  readonly agents: readonly { readonly kind: 'code' | 'file' }[];
  /** How many chats a person started that the Bureau lists (at least one is enough). */
  readonly chatCount: number;
}

/** Which steps the signals say are done. */
export function firstRunProgress(signals: FirstRunSignals): FirstRunProgress {
  return {
    provider: signals.providers.some((provider) => provider.hasKey),
    agent: signals.agents.some((agent) => agent.kind === 'file'),
    chat: signals.chatCount > 0,
  };
}

/** Whether every step is done, which ends the checklist whether it was dismissed or not. */
export function firstRunComplete(progress: FirstRunProgress): boolean {
  return FIRST_RUN_STEPS.every((step) => progress[step]);
}

/** Whether the person dismissed the checklist. Storage that cannot be read means it was not. */
export function readFirstRunDismissed(storage: Storage | undefined = defaultStorage()): boolean {
  if (storage === undefined) return false;
  try {
    return storage.getItem(FIRST_RUN_DISMISSED_KEY) === 'true';
  } catch {
    return false;
  }
}

/** Keeps the dismissal. Storage that is full or blocked keeps it for this page only. */
export function writeFirstRunDismissed(storage: Storage | undefined = defaultStorage()): void {
  if (storage === undefined) return;
  try {
    storage.setItem(FIRST_RUN_DISMISSED_KEY, 'true');
  } catch {
    // Storage that refuses the write keeps the dismissal for this page only.
  }
}

/** The page's `localStorage`, or `undefined` where reaching it throws (a blocked or private window). */
function defaultStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}
