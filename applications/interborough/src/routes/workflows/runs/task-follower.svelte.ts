/**
 * Follows one task through `bureau.tasks.events` for the task's page: it keeps the answer the
 * stream carries (the management plane's task view has none), tells the page when an element
 * arrives so the page reads the task again, and keeps the stream open across a network drop.
 *
 * ## Resuming
 *
 * Every element names its position in the Bureau's durable history, its `cursor`, and a stream
 * opened with that cursor in `Last-Event-ID` carries on from it. The follower keeps the last one it
 * was given, so a dropped connection resumes where it stopped instead of starting over. It also
 * keeps the cursor, and the answer, in `sessionStorage`, so a reloaded page resumes from there: a
 * stream resumed from a cursor sends no snapshot and no replay of what came before, so the answer
 * a finished task gave must be kept with the cursor that passed it. A snapshot's cursor names no
 * position (`-1`) and is never kept.
 *
 * ## Reconnecting
 *
 * A stream that drops or fails to open is opened again after the shared reconnect backoff, and at
 * once when the browser reports it is back online. A stream the Bureau ends cleanly is not a drop,
 * and what it means depends on what is known (`#run`): after a terminal status it is the end; a
 * session run that was given a position is resumed from it after the first backoff step, because
 * the Bureau ends every stream at the subscription route's time limit; and a task started with
 * `bureau.run()` streams one snapshot and ends while it is going, so the page reads it until it is
 * over and then collects its answer with one more stream (`collect`). A refusal
 * that retrying cannot change (the task is not there, the Bureau keeps no history to follow, the
 * caller may not read it) ends the following for good.
 */
import { z } from 'zod';

import type { Fetcher } from '../../../lib/bureau-client.ts';
import {
  followTaskEvents,
  isTerminalState,
  SNAPSHOT_CURSOR,
  taskArtifactSchema,
  type TaskArtifact,
  type TaskEvent,
  type TaskState,
} from '../../../lib/bureau-tasks.ts';
import { classifyFault } from '../../../lib/faults.ts';
import { computeReconnectDelayMs } from '../../../lib/live-source/backoff.ts';

/** Where the follower stands, for the page to say. */
export type TaskFollowState =
  'connecting' | 'live' | 'reconnecting' | 'ended' | 'unavailable' | 'not-found';

/** The `sessionStorage` key one task's cursor is kept under. */
export function taskCursorKey(taskId: string): string {
  return `interborough:task-cursor:${taskId}`;
}

const keptSchema = z.object({ cursor: z.string(), artifact: taskArtifactSchema.nullable() });

type KeptCursor = z.infer<typeof keptSchema>;

type TaskStorage = Pick<Storage, 'getItem' | 'setItem'>;

/** `sessionStorage` where the browser lets a page read it, and nothing where it does not. */
function defaultStorage(): TaskStorage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function readKept(storage: TaskStorage | undefined, taskId: string): KeptCursor | undefined {
  try {
    const text = storage?.getItem(taskCursorKey(taskId));
    if (text === null || text === undefined) return undefined;
    const parsed = keptSchema.safeParse(JSON.parse(text));
    return parsed.success && parsed.data.cursor !== SNAPSHOT_CURSOR ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function sleepFor(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

export type TaskFollowerOptions = {
  readonly taskId: string;
  /** Called with every element, after the follower has taken what it keeps from it. */
  readonly onElement?: (element: TaskEvent) => void;
  /**
   * Whether the page has read the task as over. A stream resumed past a task's end has nothing to
   * send, so it ends with no status to say why.
   */
  readonly isOver?: () => boolean;
  readonly storage?: TaskStorage | undefined;
  readonly fetch?: Fetcher;
  /** Waits out a backoff. Tests stand a sleep they release themselves in for the timer. */
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
};

export class TaskFollower {
  state = $state<TaskFollowState>('connecting');
  /** The answer the stream carried, or the one a reloaded page kept. */
  artifact = $state<TaskArtifact | null>(null);
  /** The last status the stream reported. */
  lastStatus = $state<TaskState | undefined>(undefined);
  /** The last position the Bureau gave, which a reconnect resumes from. */
  lastCursor = $state<string | undefined>(undefined);
  /** Whether the Bureau said the task was removed. */
  removed = $state(false);

  readonly #options: TaskFollowerOptions;
  readonly #storage: TaskStorage | undefined;
  readonly #controller = new AbortController();
  #started = false;
  #removed = false;
  #collected = false;

  constructor(options: TaskFollowerOptions) {
    this.#options = options;
    this.#storage = 'storage' in options ? options.storage : defaultStorage();
    const kept = readKept(this.#storage, options.taskId);
    if (kept !== undefined) {
      this.lastCursor = kept.cursor;
      this.artifact = kept.artifact;
    }
  }

  /** Opens the stream, and keeps it open until the task is over or the follower is disposed. */
  start(): void {
    if (this.#started) return;
    this.#started = true;
    void this.#run();
  }

  /**
   * Opens one more stream to collect the answer of a task that finished after its stream ended. A
   * task the Bureau started with `bureau.run()` carries its answer only in the snapshot of a
   * subscription made once it is finished, and its task view has none. It is asked for once.
   */
  collect(): void {
    if (this.#collected || this.state !== 'ended' || this.#disposed) return;
    this.#collected = true;
    this.state = 'connecting';
    void this.#run();
  }

  /** Stops following, closes the stream, and stops any reconnect that is waiting. */
  dispose(): void {
    this.#controller.abort();
  }

  get #disposed(): boolean {
    return this.#controller.signal.aborted;
  }

  #keep(element: TaskEvent): void {
    if (element.kind === 'task.snapshot' || element.kind === 'task.status') {
      this.lastStatus = element.status;
      if (element.artifact !== undefined && element.artifact !== null) {
        this.artifact = element.artifact;
      }
    }
    if (element.kind === 'task.removed') {
      this.#removed = true;
      this.removed = true;
    }
    if (element.cursor === SNAPSHOT_CURSOR) return;
    this.lastCursor = element.cursor;
    try {
      this.#storage?.setItem(
        taskCursorKey(this.#options.taskId),
        JSON.stringify({ cursor: element.cursor, artifact: this.artifact } satisfies KeptCursor),
      );
    } catch {
      // Storage the browser will not let a page write is a convenience lost, not a failure.
    }
  }

  /** Waits out a backoff, or until the browser reports it is back online, or until disposed. */
  async #wait(milliseconds: number): Promise<void> {
    const signal = this.#controller.signal;
    let onOnline: (() => void) | undefined;
    const online = new Promise<void>((resolve) => {
      onOnline = resolve;
      window.addEventListener('online', onOnline, { once: true });
    });
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => resolve(), { once: true });
    });
    try {
      await Promise.race([
        (this.#options.sleep ?? sleepFor)(milliseconds, signal),
        online,
        aborted,
      ]);
    } finally {
      if (onOnline !== undefined) window.removeEventListener('online', onOnline);
    }
  }

  get #over(): boolean {
    return (
      this.#removed ||
      (this.lastStatus !== undefined && isTerminalState(this.lastStatus)) ||
      this.#options.isOver?.() === true
    );
  }

  async #run(): Promise<void> {
    let attempt = 0;
    while (!this.#disposed) {
      try {
        const elements = followTaskEvents(this.#options.taskId, {
          signal: this.#controller.signal,
          ...(this.lastCursor === undefined ? {} : { cursor: this.lastCursor }),
          ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
          onOpen: () => {
            attempt = 0;
            this.state = 'live';
          },
        });
        for await (const element of elements) {
          this.#keep(element);
          this.#options.onElement?.(element);
          if (this.#removed) break;
        }
        if (this.#disposed) return;
        // The Bureau ended the stream, which is not a dropped connection. What it means depends on
        // what the follower knows:
        //  - the task is over (a terminal status was seen, the Bureau removed it, or the page has
        //    read it as over): the end;
        //  - no position was ever given (a task the Bureau started with `bureau.run()` streams one
        //    snapshot and ends while it is going): the end of this stream, and the page reads the
        //    task until it is over and then collects the answer with `collect()`;
        //  - a position was given and the task is going (a session run, whose stream the Bureau
        //    ends at the subscription route's time limit expecting `Last-Event-ID` next): the
        //    stream is resumed from that position after the first backoff step, which also keeps
        //    an unforeseen cause of clean ends from becoming a tight loop.
        if (this.#over || this.lastCursor === undefined) {
          this.state = 'ended';
          return;
        }
        await this.#wait(computeReconnectDelayMs(1));
        continue;
      } catch (error) {
        if (this.#disposed) return;
        const treatment = classifyFault(error);
        if (treatment?.kind === 'not-found') {
          this.state = 'not-found';
          return;
        }
        // The Bureau keeps no history to follow, or the caller may not read this task's.
        if (treatment?.kind === 'not-supported' || treatment?.kind === 'unauthorized') {
          this.state = 'unavailable';
          return;
        }
      }
      attempt += 1;
      this.state = 'reconnecting';
      await this.#wait(computeReconnectDelayMs(attempt));
    }
  }
}
