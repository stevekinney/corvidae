/**
 * The agent the end-to-end suite uses when a case needs a chat turn to store a memory it can tell
 * apart from every other: it answers with the text of the user's last message. A memory is stored
 * from an agent's final answer, so a case that sends a unique label gets a memory holding exactly
 * that label, whatever else the suite has stored for the seeded agents (whose scripted replies are
 * identical every time).
 */
import { createAgent, stopWhen, type GenerateFunction } from '@lostgradient/operative';

/** The name the e2e host publishes the echo agent under. */
export const ECHO_AGENT_NAME = 'echo';

const echo: GenerateFunction = async ({ conversation }) => {
  const last = conversation.getMessages().findLast((message) => message.role === 'user');
  return {
    content: typeof last?.content === 'string' ? last.content : 'Nothing to echo.',
    toolCalls: [],
  };
};

export function createEchoAgents() {
  return {
    [ECHO_AGENT_NAME]: createAgent({
      name: ECHO_AGENT_NAME,
      description: 'Answers with the text of the last message.',
      generate: echo,
      stopWhen: stopWhen.noToolCalls(),
    }),
  };
}
