/**
 * Pure logic for tool-tally. Nothing here touches `$`, so the functions are
 * plain TypeScript that a test can call directly.
 */

/** How the tool calls this module has seen ended. */
export type ToolCallTally = {
  /** Calls that reached this hook: requested, not necessarily run. */
  readonly requested: number;
  /** Calls a hook, a rule, or the person refused (`{ deny }`). */
  readonly refused: number;
  /** Calls that ran and reported an error (`isError`). */
  readonly failed: number;
  /** Calls that ran and returned a result. */
  readonly succeeded: number;
};

/** The outcome of one call, read from what `next(e)` resolved to. */
export type ToolCallOutcome = 'refused' | 'failed' | 'succeeded';

export const emptyTally: ToolCallTally = { requested: 0, refused: 0, failed: 0, succeeded: 0 };

/**
 * Classifies a `tool.call` result. A `deny` means the call never ran or its
 * result was withheld; `isError` means it ran and failed. Anything else ran.
 */
export function outcomeOf(result: {
  readonly deny?: unknown;
  readonly isError?: unknown;
}): ToolCallOutcome {
  if (typeof result.deny === 'string') return 'refused';
  if (result.isError === true) return 'failed';
  return 'succeeded';
}

export function countRequested(tally: ToolCallTally): ToolCallTally {
  return { ...tally, requested: tally.requested + 1 };
}

export function countOutcome(tally: ToolCallTally, outcome: ToolCallOutcome): ToolCallTally {
  return { ...tally, [outcome]: tally[outcome] + 1 };
}

/** The reply `/tool-tally` prints, which Claude also reads. */
export function describeTally(tally: ToolCallTally): string {
  const pending = tally.requested - tally.refused - tally.failed - tally.succeeded;
  const parts = [
    `${tally.succeeded} succeeded`,
    `${tally.failed} failed`,
    `${tally.refused} refused`,
  ];
  if (pending > 0) parts.push(`${pending} still running`);
  return `${tally.requested} tool calls since this mod loaded: ${parts.join(', ')}.`;
}
