/** The address of a new chat, and what it says of where the person came from. */

/** The `from` that says a new chat was started from the Workflows page. */
export const NEW_CHAT_FROM_WORKFLOWS = 'workflows';

/**
 * The address of a new chat started from the Workflows page ("Ask an agent to write one"): an
 * agent that can create workflows is chosen, and the box holds the start of a request for the
 * person to finish. The address names where the person came from and nothing to send, so no link can
 * start a run.
 */
export function newChatFromWorkflowsPath(): string {
  return `/chats/new?${new URLSearchParams({ from: NEW_CHAT_FROM_WORKFLOWS }).toString()}`;
}

/** Whether the address of a new chat says it was started from the Workflows page. */
export function startedFromWorkflows(search: URLSearchParams): boolean {
  return search.get('from') === NEW_CHAT_FROM_WORKFLOWS;
}
