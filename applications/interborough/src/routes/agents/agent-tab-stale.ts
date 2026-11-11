/**
 * Whether the open tab of an agent's page shows data that its last read failed to refresh (board
 * PageAgent, row 39g). The tab body says so in a banner over the old data, and the header holds
 * back Edit, the one header action that changes something, until a read succeeds. A tab body
 * reports it through this context, which the agent's page provides; outside the page nothing
 * listens.
 */
import { getContext, setContext, untrack } from 'svelte';

const AGENT_TAB_STALE_KEY = Symbol('agent-tab-stale');

/** Marks the open tab as showing old data, and returns the function that takes the mark back. */
export type MarkTabStale = () => () => void;

/** Makes the agent's page the listener for what its tab bodies report. Call it while the page initializes. */
export function provideAgentTabStale(mark: MarkTabStale): void {
  setContext(AGENT_TAB_STALE_KEY, mark);
}

/**
 * The agent page's listener, or one that does nothing for a tab body rendered outside the page.
 * A tab body marks from inside an effect, and the page's listener counts the marks in state it reads
 * to add one, so the mark runs untracked: otherwise the effect would depend on the count it changes
 * and run again without end.
 */
export function useAgentTabStale(): MarkTabStale {
  const mark = getContext<MarkTabStale | undefined>(AGENT_TAB_STALE_KEY);
  if (mark === undefined) return () => () => {};
  return () => untrack(mark);
}
