/**
 * The chat sessions a route return reuses (COR-2293 B2, COR-2439 AC7 to AC9).
 *
 * Leaving a chat page used to dispose its session, so coming back opened a second attach over a
 * run the first was still reading, against the same semantic journal. The registry keeps a session
 * when its route is released and hands the same session back when the route is acquired again, so
 * a return makes no second attach and a queued follow-up keeps its row.
 *
 * - Keyed by session id. One page holds a session at a time; an acquire while another page holds
 *   it takes it over (a newer generation), and the older page's release is fenced off by its
 *   generation, so a late cleanup cannot release the newer holder.
 * - A released session is kept only while it has live work: a transport open or opening, a turn
 *   streaming, follow-ups queued, an approval or a question waiting, or a reconnect under way. It is
 *   disposed by an event, never a timer: that work ending, the session failing, a fifth retained
 *   session evicting the oldest, or the registry's own disposal.
 * - A session's callbacks go to the page that holds it now. While no page holds it, its
 *   notifications go nowhere and its questions (`agentName`, `closed`) are answered by the last
 *   holder's.
 * - Nothing is exposed before it is committed: an entry is in the map before its handle is
 *   returned, and leaves the map before its session is disposed.
 */
import { ChatSessionState, type ChatSessionOptions } from './chat-session.svelte.ts';

/** What a page tells the session it holds: its callbacks, read while it holds the session. */
export type ChatSessionHost = Omit<
  ChatSessionOptions,
  'sessionId' | 'fetch' | 'clock' | 'unopened'
>;

/** What identifies the session itself, fixed for its life. */
export type ChatSessionKey = Pick<ChatSessionOptions, 'sessionId' | 'fetch' | 'clock' | 'unopened'>;

/** A page's hold on a session. */
export type HeldChatSession = {
  readonly session: ChatSessionState;
  /** Whether the session was retained from an earlier visit, so the page attaches nothing. */
  readonly reacquired: boolean;
  /** Gives the session back when the page leaves; a stale release does nothing. */
  readonly release: () => void;
};

type Entry = {
  readonly key: ChatSessionKey;
  readonly session: ChatSessionState;
  /** The page that holds it now, or `undefined` while it is retained. */
  host: ChatSessionHost | undefined;
  /** The last page's callbacks, which answer the session's questions while nobody holds it. */
  lastHost: ChatSessionHost;
  generation: number;
  /** Stops watching a retained session's live work. */
  unwatch: (() => void) | undefined;
  /** Ends the reactive root the session's own state lives in. */
  readonly destroyRoot: () => void;
};

/** The default number of released sessions kept for a route return. */
export const RETAINED_CHAT_SESSIONS = 4;

/** Whether a session has work a route return should find going. */
export function hasLiveWork(session: ChatSessionState): boolean {
  if (session.failure !== undefined) return false;
  return (
    session.streaming ||
    session.transportActive ||
    session.queuedFollowUps > 0 ||
    session.approvals.length > 0 ||
    session.humanRequests.length > 0 ||
    session.reconnectAttempt > 0
  );
}

export class ChatSessionRegistry {
  readonly #entries = new Map<string, Entry>();
  readonly #capacity: number;
  /** Released ids, oldest first. */
  #retainedOrder: string[] = [];

  constructor(options: { readonly capacity?: number } = {}) {
    this.#capacity = Math.max(0, options.capacity ?? RETAINED_CHAT_SESSIONS);
  }

  /** How many released sessions are kept for a route return. */
  get retained(): number {
    return this.#retainedOrder.length;
  }

  /** Whether the registry holds a session under `sessionId`, held or retained. */
  has(sessionId: string): boolean {
    return this.#entries.has(sessionId);
  }

  /** Holds the session of `key`, the retained one when there is one, else a new one. */
  acquire(key: ChatSessionKey, host: ChatSessionHost): HeldChatSession {
    const existing = this.#entries.get(key.sessionId);
    const reusable =
      existing !== undefined &&
      existing.key.fetch === key.fetch &&
      existing.key.clock === key.clock;
    if (existing !== undefined && !reusable) this.#drop(existing);
    const entry = reusable ? existing : this.#create(key, host);
    entry.unwatch?.();
    entry.unwatch = undefined;
    this.#retainedOrder = this.#retainedOrder.filter((id) => id !== key.sessionId);
    entry.generation += 1;
    entry.host = host;
    entry.lastHost = host;
    const generation = entry.generation;
    return {
      session: entry.session,
      reacquired: reusable,
      release: () => this.#release(entry, generation),
    };
  }

  /** Disposes every session, held or retained. */
  dispose(): void {
    // Dropping deletes from the map, so the entries are read out before it.
    for (const entry of Array.from(this.#entries.values())) this.#drop(entry);
    this.#retainedOrder = [];
  }

  #create(key: ChatSessionKey, host: ChatSessionHost): Entry {
    let entry: Entry | undefined;
    // Each callback goes to the page holding the session now; its questions fall back to the last.
    const current = (): ChatSessionHost | undefined => entry?.host;
    const answering = (): ChatSessionHost | undefined => entry?.host ?? entry?.lastHost;
    const options: ChatSessionOptions = {
      ...key,
      agentName: () => answering()?.agentName() ?? host.agentName(),
      closed: () => answering()?.closed?.() === true,
      discardUnstarted: () => answering()?.discardUnstarted?.() === true,
      onRunStarted: () => current()?.onRunStarted?.(),
      onNotFound: () => current()?.onNotFound?.(),
      onArchived: () => current()?.onArchived?.(),
      onGrantNotLoosened: (notice) => current()?.onGrantNotLoosened?.(notice),
    };
    // The session's own derived state belongs to the registry, not to the page that asked first: a
    // page's deriveds die with it, and a retained session must still read true after its page is
    // gone.
    let session: ChatSessionState | undefined;
    const destroyRoot = $effect.root(() => {
      session = new ChatSessionState(options);
    });
    entry = {
      key,
      session: session!,
      host,
      lastHost: host,
      generation: 0,
      unwatch: undefined,
      destroyRoot,
    };
    this.#entries.set(key.sessionId, entry);
    return entry;
  }

  #release(entry: Entry, generation: number): void {
    // A page that no longer holds the session (another took it over, or it was dropped) releases
    // nothing.
    if (this.#entries.get(entry.key.sessionId) !== entry || entry.generation !== generation) return;
    entry.host = undefined;
    if (!hasLiveWork(entry.session)) {
      this.#drop(entry);
      return;
    }
    this.#retainedOrder.push(entry.key.sessionId);
    // The work ending, or the session failing, is the event that ends the retention. A page
    // releases from its teardown, where no effect may be created, so the watch starts just after.
    queueMicrotask(() => {
      if (!this.#isRetained(entry, generation)) return;
      entry.unwatch = $effect.root(() => {
        $effect(() => {
          if (hasLiveWork(entry.session)) return;
          queueMicrotask(() => {
            if (this.#isRetained(entry, generation)) this.#drop(entry);
          });
        });
      });
    });
    while (this.#retainedOrder.length > this.#capacity) {
      const oldest = this.#entries.get(this.#retainedOrder[0]!);
      if (oldest === undefined) this.#retainedOrder.shift();
      else this.#drop(oldest);
    }
  }

  /** Whether `entry` is still retained under the release of `generation`, held by nobody. */
  #isRetained(entry: Entry, generation: number): boolean {
    return (
      this.#entries.get(entry.key.sessionId) === entry &&
      entry.host === undefined &&
      entry.generation === generation
    );
  }

  #drop(entry: Entry): void {
    if (this.#entries.get(entry.key.sessionId) === entry) this.#entries.delete(entry.key.sessionId);
    this.#retainedOrder = this.#retainedOrder.filter((id) => id !== entry.key.sessionId);
    entry.unwatch?.();
    entry.unwatch = undefined;
    entry.host = undefined;
    // A later release of this entry finds a newer generation and does nothing.
    entry.generation += 1;
    entry.session.dispose();
    entry.destroyRoot();
  }
}

/** A page's session, and the attach it started: none when the session was retained. */
export type OpenedChatSession = HeldChatSession & {
  /** Whether the attach found a run to join; `false` at once for a new chat or live reacquisition. */
  readonly attached: Promise<boolean>;
};

/**
 * Holds the session for a chat page. A session retained from an earlier visit while its transport
 * is open is already reading its run, so it is not attached again. A retained parked session has
 * no open transport: re-read it, because a decision made while the route was away replaces its
 * waiting row with the durable receipt.
 */
export function openChatSession(
  registry: ChatSessionRegistry,
  key: ChatSessionKey,
  host: ChatSessionHost,
): OpenedChatSession {
  const held = registry.acquire(key, host);
  const attached =
    key.unopened === true || (held.reacquired && held.session.transportActive)
      ? Promise.resolve(false)
      : held.session.attach();
  return { ...held, attached };
}

/** The application's sessions, shared by every chat page. */
export const chatSessions = new ChatSessionRegistry();
