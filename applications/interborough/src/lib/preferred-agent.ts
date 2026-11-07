/**
 * The agent a person chose for new chats (Settings › General, "Default agent for new chats"). It is
 * a preference of this browser, kept in `localStorage` as the theme and the sidebar are, and it is
 * read where a new chat picks its agent (`default-agent.ts`). A name the Bureau no longer lists, or
 * whose plugin is not running, is not used, so the choice never leaves a chat without an agent.
 */
const PREFERRED_AGENT_KEY = 'interborough-default-agent';

/** The agent the person chose, or `undefined` for none or storage that cannot be read. */
export function readPreferredAgent(storage?: Storage): string | undefined {
  try {
    const value = (storage ?? window.localStorage).getItem(PREFERRED_AGENT_KEY);
    return value === null || value === '' ? undefined : value;
  } catch {
    return undefined;
  }
}

/** Remembers the agent, or forgets the choice for `undefined`. Storage that refuses keeps nothing. */
export function writePreferredAgent(name: string | undefined, storage?: Storage): void {
  try {
    const target = storage ?? window.localStorage;
    if (name === undefined || name === '') target.removeItem(PREFERRED_AGENT_KEY);
    else target.setItem(PREFERRED_AGENT_KEY, name);
  } catch {
    // Storage that is full or blocked keeps the choice for nothing; the first agent that can run applies.
  }
}
