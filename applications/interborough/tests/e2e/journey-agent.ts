/**
 * The two test models the journey (`90-journey.spec.ts`) needs and no other specification does.
 * Neither calls a model, and no provider key is read.
 *
 * `createJourneyProviderResolver` stands in for the provider path an agent defined in the editor
 * runs through. The host resolves such an agent's `generate` from its model, so a resolver is the
 * seam. An opener that carries {@link JOURNEY_MARKER} gets a script: one call to the workflow tool
 * that writes {@link JOURNEY_WORKFLOW_ID}, then a fixed text once the call has a result. Counting
 * the calls already in the conversation, is what keeps the agent from
 * writing the workflow again on its next step, so it cannot loop. Every other opener gets the
 * resolver it wraps, the provider stub the other specifications use.
 *
 * `echo-recall` is the agent the memory stage chats with. It answers with the text of the memory
 * the run recalled, when it recalled any, and with the person's last message when it recalled none.
 * A memory is stored from an agent's final answer, so the first chat stores exactly the label the
 * journey sent, and a later chat that recalls it is answered with what the Bureau now holds.
 */
import {
  createAgent,
  stopWhen,
  type GenerateContext,
  type GenerateFunction,
  type GenerateResponse,
} from '@lostgradient/operative';

import type { HostOptions } from '../../src/host/host.ts';

/** What the journey's first message to the workflow author carries. */
export const JOURNEY_MARKER = '[journey:write-digest]';

/** The identifier of the workflow the scripted author writes, and the cadence it starts with. */
export const JOURNEY_WORKFLOW_ID = 'journey-digest';
export const JOURNEY_WORKFLOW_CADENCE = '5s';

/** What the scripted author says once the workflow tool has answered. */
export const JOURNEY_AUTHOR_REPLY = 'The journey digest is written and scheduled.';

/** The workflow tool the author uses, as an agent file names it and a tool approval is keyed (COR-1890). */
export const JOURNEY_TOOL_NAME = 'bureau:workflows-create';

/** The name the scripted model calls that tool by: the form a provider sees a namespaced tool in. */
export const JOURNEY_TOOL_CALL_NAME = 'bureau__workflows-create';

type ProviderResolver = NonNullable<HostOptions['resolveProviderGenerate']>;

function openerOf(context: GenerateContext): string | undefined {
  const opener = context.conversation.getMessages().find((message) => message.role === 'user');
  return typeof opener?.content === 'string' ? opener.content : undefined;
}

/** The script for a run that carries the marker. */
function authorResponse(context: GenerateContext): GenerateResponse {
  const calls = context.conversation
    .getMessages()
    .filter((message) => message.toolCall !== undefined).length;
  if (calls > 0) return { content: JOURNEY_AUTHOR_REPLY, toolCalls: [] };
  return {
    content: '',
    toolCalls: [
      {
        id: 'journey-workflows-create-1',
        name: JOURNEY_TOOL_CALL_NAME,
        arguments: {
          name: 'Journey digest',
          id: JOURNEY_WORKFLOW_ID,
          trigger: { kind: 'schedule', spec: JOURNEY_WORKFLOW_CADENCE },
          steps: [
            {
              kind: 'activity',
              handler: 'agent',
              input: { agent: 'assistant', message: 'Write the journey digest.' },
            },
          ],
        },
      },
    ],
  };
}

/**
 * A provider resolver that scripts the runs whose opener carries {@link JOURNEY_MARKER} and hands
 * every other run to `fallback`.
 */
export function createJourneyProviderResolver(fallback: ProviderResolver): ProviderResolver {
  return (definitions, provider, streamEventTarget, streaming) => {
    const stub = fallback(definitions, provider, streamEventTarget, streaming);
    const generate: GenerateFunction = async (context) => {
      const opener = openerOf(context);
      if (opener === undefined || !opener.includes(JOURNEY_MARKER)) return stub(context);
      return authorResponse(context);
    };
    return generate;
  };
}

/** The name the journey host serves the recall echo under. */
export const RECALL_AGENT_NAME = 'echo-recall';

/** What the recall echo says when it was sent nothing it can echo. */
export const RECALL_NOTHING_REPLY = 'Nothing to echo.';

export const recallOrEcho: GenerateFunction = async ({ conversation }) => {
  const messages = conversation.getMessages();
  // The recall hook appends what it admitted as a system row marked `memoryEvidence`.
  const recalled = messages.filter(
    (message) =>
      message.role === 'system' &&
      message.metadata['memoryEvidence'] !== undefined &&
      typeof message.content === 'string',
  );
  if (recalled.length > 0) {
    return {
      content: recalled.map((message) => message.content as string).join('\n'),
      toolCalls: [],
    };
  }
  const last = messages.findLast((message) => message.role === 'user');
  return {
    content: typeof last?.content === 'string' ? last.content : RECALL_NOTHING_REPLY,
    toolCalls: [],
  };
};

export function createRecallAgents() {
  return {
    [RECALL_AGENT_NAME]: createAgent({
      name: RECALL_AGENT_NAME,
      description: 'Answers with what it recalled, or with the text of the last message.',
      generate: recallOrEcho,
      stopWhen: stopWhen.noToolCalls(),
    }),
  };
}
