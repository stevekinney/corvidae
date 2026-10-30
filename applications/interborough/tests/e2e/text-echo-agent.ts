/**
 * The agents the end-to-end memory spec uses when a case needs a chat turn to store a memory it
 * can tell apart from every other: each answers with the text of the user's last message. A memory
 * is stored from an agent's final answer, so a case that sends a unique label gets a memory
 * holding exactly that label, whatever else the suite has stored for the seeded agents (whose
 * scripted replies are identical every time). They are not `echo-image` (`echo-agent.ts`), which sends
 * back images for the attachment specs.
 */
import { createAgent, stopWhen, type GenerateFunction } from '@lostgradient/operative';

/** The name the e2e host serves the text echo agent under. */
export const TEXT_ECHO_AGENT_NAME = 'echo-text';
/**
 * A second text echo agent that only one case chats with, so that case can forget the agent's only
 * memory: the first agent's memories are shared by every case that stores one.
 */
export const TEXT_ECHO_SOLO_AGENT_NAME = 'echo-text-solo';

const echo: GenerateFunction = async ({ conversation }) => {
  const last = conversation.getMessages().findLast((message) => message.role === 'user');
  return {
    content: typeof last?.content === 'string' ? last.content : 'Nothing to echo.',
    toolCalls: [],
  };
};

export function createTextEchoAgents() {
  return {
    [TEXT_ECHO_AGENT_NAME]: createAgent({
      name: TEXT_ECHO_AGENT_NAME,
      description: 'Answers with the text of the last message.',
      generate: echo,
      stopWhen: stopWhen.noToolCalls(),
    }),
    [TEXT_ECHO_SOLO_AGENT_NAME]: createAgent({
      name: TEXT_ECHO_SOLO_AGENT_NAME,
      description: 'Answers with the text of the last message, for a case of its own.',
      generate: echo,
      stopWhen: stopWhen.noToolCalls(),
    }),
  };
}
