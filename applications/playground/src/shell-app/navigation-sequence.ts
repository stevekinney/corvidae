/**
 * Keeps at most one navigation pending.
 *
 * `begin()` supersedes the previous navigation: it aborts that navigation's signal and marks it
 * stale. A navigation checks `isCurrent()` after every await and before every effect on the URL,
 * the document, focus, or history, so a response that arrives late never reaches any of them.
 */

export type NavigationTicket = {
  /** Aborted when a newer navigation begins. Pass it to `fetch`. */
  readonly signal: AbortSignal;
  /** True until a newer navigation begins. */
  isCurrent(): boolean;
};

export type NavigationSequencer = {
  begin(): NavigationTicket;
};

export function createNavigationSequencer(): NavigationSequencer {
  let latest: AbortController | null = null;
  return {
    begin() {
      latest?.abort();
      const controller = new AbortController();
      latest = controller;
      return {
        signal: controller.signal,
        isCurrent: () => latest === controller && !controller.signal.aborted,
      };
    },
  };
}

/** Thrown to unwind a superseded navigation without treating it as a failure. */
export class SupersededNavigationError extends Error {
  constructor() {
    super('Navigation was superseded by a newer one.');
    this.name = 'SupersededNavigationError';
  }
}

/** Unwinds the calling navigation when `ticket` is no longer the current one. */
export function assertCurrent(ticket: NavigationTicket): void {
  if (!ticket.isCurrent()) throw new SupersededNavigationError();
}

/**
 * Counts the history steps the reader took (Back, Forward) so a navigation can tell, just before
 * it writes a history entry of its own, that the reader has moved on since it started.
 */
export type HistoryGeneration = {
  /** Record a history step by the reader. */
  advance(): void;
  /** The generation now, to compare against later. */
  read(): number;
};

export function createHistoryGeneration(): HistoryGeneration {
  let generation = 0;
  return {
    advance: () => {
      generation += 1;
    },
    read: () => generation,
  };
}

/**
 * How a failed in-page navigation falls back to a document load. Once the navigation has written
 * history (or the reader's own step already moved it), the document load must replace that entry,
 * not add another after it.
 */
export function fallbackNavigationMethod(historyWritten: boolean): 'assign' | 'replace' {
  return historyWritten ? 'replace' : 'assign';
}
