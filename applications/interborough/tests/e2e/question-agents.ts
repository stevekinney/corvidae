/**
 * The agents the end-to-end suite uses for a run that asks the person more than one thing
 * (COR-1590): `two-questions` asks two questions, and `question-and-approval` asks one and then
 * stops on a tool approval. The Bureau parks a run on one human wait at a time and offers a tool
 * approval only once the run has settled, so a real run asks its questions one after another: each
 * answer is what lets the run raise the next. The chat page treats a run that waits on several
 * things at once the same way, which `run-wiring.test.ts` and `chat-conversation.test.ts` cover
 * against a stub mount; these agents cover the run that really asks in turn, through the real host.
 *
 * Each answers from where the conversation has got to, not from the run's step number, because a
 * resumed run is a new run on the same session. A tool call identifier names one call in a session,
 * so each call carries the number of the calls before it.
 */
import { createAgent, stopWhen, type GenerateFunction } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { z } from 'zod';

export const TWO_QUESTIONS_AGENT_NAME = 'two-questions';
export const QUESTION_AND_APPROVAL_AGENT_NAME = 'question-and-approval';

/** The signals the agents park on, in the order they ask, and what they ask. */
export const ENVIRONMENT_SIGNAL = 'environment';
export const REGION_SIGNAL = 'region';
export const ENVIRONMENT_QUESTION = 'Which environment should the release go to?';
export const REGION_QUESTION = 'Which region should the release go to?';

/** What the agents say once everything they asked has been answered. */
export const TWO_QUESTIONS_THANKS =
  'Thanks, the release will go to the environment and region you named.';
export const RELEASE_SENT = 'The release was sent.';
export const RELEASE_NOT_SENT = 'The release was not sent.';

const RELEASE_TOOL = 'send-release';
const APPROVAL_SECRET = 'end-to-end-question-and-approval-secret';

type Message = ReturnType<Parameters<GenerateFunction>[0]['conversation']['getMessages']>[number];

/** The signal the last row delivered, when the last row is a delivered answer (`[signal:<name>] ...`). */
function deliveredSignal(messages: readonly Message[]): string | undefined {
  const last = messages.at(-1);
  if (last?.role !== 'user' || typeof last.content !== 'string') return undefined;
  const match = /^\[signal:([^\]]+)\] /.exec(last.content);
  return match?.[1];
}

function ask(messages: readonly Message[], signalName: string, prompt: string) {
  const asked = messages.filter((message) => message.toolCall !== undefined).length;
  return {
    content: '',
    toolCalls: [
      {
        id: `ask-${String(asked + 1)}`,
        name: 'requestHumanInput',
        arguments: { signalName, prompt },
      },
    ],
  };
}

const twoQuestions: GenerateFunction = async ({ conversation }) => {
  const messages = conversation.getMessages();
  const delivered = deliveredSignal(messages);
  if (delivered === REGION_SIGNAL) return { content: TWO_QUESTIONS_THANKS, toolCalls: [] };
  return delivered === ENVIRONMENT_SIGNAL
    ? ask(messages, REGION_SIGNAL, REGION_QUESTION)
    : ask(messages, ENVIRONMENT_SIGNAL, ENVIRONMENT_QUESTION);
};

const questionAndApproval: GenerateFunction = async ({ conversation }) => {
  const messages = conversation.getMessages();
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  const turn = messages.slice(lastUser + 1);
  const release = turn.find((message) => message.toolResult !== undefined)?.toolResult;
  if (release !== undefined && release.outcome !== 'action_required') {
    return {
      content: release.outcome === 'success' ? RELEASE_SENT : RELEASE_NOT_SENT,
      toolCalls: [],
    };
  }
  if (deliveredSignal(messages) === ENVIRONMENT_SIGNAL) {
    return {
      content: '',
      toolCalls: [{ id: 'release-1', name: RELEASE_TOOL, arguments: { environment: 'staging' } }],
    };
  }
  return ask(messages, ENVIRONMENT_SIGNAL, ENVIRONMENT_QUESTION);
};

export function createQuestionAgents() {
  return {
    [TWO_QUESTIONS_AGENT_NAME]: createAgent({
      name: TWO_QUESTIONS_AGENT_NAME,
      description: 'Asks which environment, and then which region.',
      generate: twoQuestions,
      // The run ends on each question so it parks, and goes on once the person answers.
      stopWhen: [stopWhen.toolCalled('requestHumanInput'), stopWhen.noToolCalls()],
    }),
    [QUESTION_AND_APPROVAL_AGENT_NAME]: createAgent({
      name: QUESTION_AND_APPROVAL_AGENT_NAME,
      description: 'Asks which environment, and then asks to send the release.',
      generate: questionAndApproval,
      toolbox: createToolbox(
        [
          createTool({
            name: RELEASE_TOOL,
            version: '1.0.0',
            description: 'Send a release. An operator approves each release before it goes.',
            input: z.object({ environment: z.string() }),
            execute: async ({ environment }) => ({ environment, sent: true }),
          }),
        ],
        {
          approvalSecret: APPROVAL_SECRET,
          // Only the release waits for approval: the question the run asks is not a mutation.
          policy: {
            beforeExecute: ({ toolName }) =>
              toolName === RELEASE_TOOL
                ? {
                    allow: false as const,
                    status: 'needs_approval' as const,
                    reason: 'Operator approval required',
                    action: { message: 'Send the release?' },
                  }
                : { allow: true as const },
          },
        },
      ),
      stopWhen: [
        stopWhen.toolCalled('requestHumanInput'),
        stopWhen.pendingApproval(),
        stopWhen.noToolCalls(),
      ],
    }),
  };
}
