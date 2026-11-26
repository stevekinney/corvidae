import { createConversationHistory } from './index.ts';

/** Exercises the root conversation model without a provider or network. */
export function runRuntimeSmoke(): void {
  const history = createConversationHistory();
  if (history === undefined) throw new Error('Conversation history was not created.');
}
