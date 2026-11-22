/**
 * Two scripted agents for the failure explanation in Chat (COR-2543): one whose run always fails,
 * and one that asks the Bureau to explain it. The failing agent's model throws, so its run settles
 * `failed` with a stored failure; the explainer reads the id of the run out of the person's message
 * (`Explain run <id>`), calls `bureau:tasks-explain` on it, and says it is done. Chat opens the
 * failure explanation panel inline over that call. Neither uses a provider.
 */
import type { BureauOwnTools } from '@lostgradient/bureau';
import { createAgent, stopWhen, type GenerateFunction } from '@lostgradient/operative';

/** The agent whose run always fails. */
export const FAILING_AGENT_NAME = 'e2e-failing';

/** The agent that explains a failed run. */
export const EXPLAINER_AGENT_NAME = 'failure-explainer';

/** The failing agent, in the shape the host's `extraAgents.agents` takes. */
export function createFailingAgents() {
  return {
    [FAILING_AGENT_NAME]: createAgent({
      name: FAILING_AGENT_NAME,
      description: 'Fails every run, for the failure explanation specs.',
      generate: (async () => {
        throw new Error('The scripted model failed.');
      }) satisfies GenerateFunction,
    }),
  };
}

/** The explainer, built from Bureau's own tools, in the shape `withBureauTools` takes. */
export const failureExplainerAgent = (tools: BureauOwnTools) =>
  createAgent({
    name: EXPLAINER_AGENT_NAME,
    description: 'Explains why a failed run failed, for Chat.',
    tools: { 'bureau:tasks-explain': tools['bureau:tasks-explain']! },
    generate: (async ({ conversation }) => {
      const messages = conversation.getMessages();
      if (messages.some((message) => message.toolResult !== undefined)) {
        return { content: 'That run failed; the explanation is above.', toolCalls: [] };
      }
      const opener = messages.find((message) => message.role === 'user');
      const text = typeof opener?.content === 'string' ? opener.content : '';
      const runId = /Explain run (\S+)/.exec(text)?.[1];
      if (runId === undefined) return { content: 'Name the run to explain.', toolCalls: [] };
      return {
        content: '',
        toolCalls: [
          {
            id: 'failure-explanation-call',
            name: 'bureau__tasks-explain',
            arguments: { runId },
          },
        ],
      };
    }) satisfies GenerateFunction,
    stopWhen: stopWhen.noToolCalls(),
  });
