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
/**
 * A second echo agent that only one case chats with, so that case can forget the agent's only
 * memory: the first agent's memories are shared by every case that stores one.
 */
export const ECHO_SOLO_AGENT_NAME = 'echo-solo';

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
    [ECHO_SOLO_AGENT_NAME]: createAgent({
      name: ECHO_SOLO_AGENT_NAME,
      description: 'Answers with the text of the last message, for a case of its own.',
      generate: echo,
      stopWhen: stopWhen.noToolCalls(),
    }),
  };
}
