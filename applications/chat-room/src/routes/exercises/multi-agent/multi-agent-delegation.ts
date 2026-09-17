import { createToolbox } from '@repo/armorer';
import { appendUserMessage, createConversationHistory, type ConversationHistory } from '@repo/chat';
import {
  createAgent,
  createSubagentTool,
  type GenerateContext,
  type StepResult,
} from '@repo/operative';
import { z } from 'zod';

const CHILD_SENTENCE = 'The staging bucket was retained. ';
const CHILD_ANSWER = CHILD_SENTENCE.repeat(30);
const QUESTION = 'What did we decide about the staging bucket?';

const condense = (text: string): string =>
  `condensed from ${text.length} characters: ${text.split('.')[0]}.`;

const CUSTOM_SUMMARY = condense(CHILD_ANSWER);

function verbatimPrefixLength(candidate: string, source: string): number {
  let index = 0;
  while (index < candidate.length && index < source.length && candidate[index] === source[index]) {
    index += 1;
  }
  return index;
}

export type Delegation = {
  parentGenerateCalls: number;
  childGenerateCalls: number;
  toolExecutions: number;
  childReceived: string;
  finishReason: string;
  returnedLength: number;
  keepsWholeAnswer: boolean;
  shortenedFromChild: boolean;
  keepsChildOpening: boolean;
  verbatimPrefixLength: number;
  cutsMidSentence: boolean;
  matchesCustomSummary: string;
  transcriptRoles: string;
  history: ConversationHistory;
};

export async function delegate(
  id: string,
  options: { returnMode: 'summary' | 'full'; useCustomSummarizer?: boolean },
): Promise<Delegation> {
  let childGenerateCalls = 0;
  let parentGenerateCalls = 0;
  let childReceived = '';

  const child = createAgent({
    name: 'researcher',
    generate: async (context: GenerateContext) => {
      childGenerateCalls += 1;
      const messages = context.conversation.getMessages();
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (!message) continue;
        if (message.role === 'user' && typeof message.content === 'string') {
          childReceived = message.content;
          break;
        }
      }
      return { content: CHILD_ANSWER, toolCalls: [] };
    },
  });

  const consultResearcher = createSubagentTool({
    name: 'consult_researcher',
    description: 'Delegate a question to the researcher subagent.',
    agent: child,
    agentName: 'researcher',
    input: z.object({ question: z.string() }),
    toAgentInput: (input) => input.question,
    returnMode: options.returnMode,
    summaryTokenCap: 40,
    ...(options.useCustomSummarizer === true
      ? { summarizer: (result: { content: string }) => condense(result.content) }
      : {}),
  });

  const parent = createAgent({
    name: 'orchestrator',
    generate: async () => {
      parentGenerateCalls += 1;
      if (parentGenerateCalls === 1) {
        return {
          content: '',
          toolCalls: [
            {
              id: `${id}-call`,
              name: 'consult_researcher',
              arguments: { question: QUESTION },
            },
          ],
        };
      }
      return { content: 'Relaying what the researcher found.', toolCalls: [] };
    },
    toolbox: createToolbox([consultResearcher]),
    stopWhen: [(step: StepResult) => step.toolCalls.length === 0],
  });

  const conversation = appendUserMessage(
    createConversationHistory({ id: `exercise-multi-agent-${id}` }),
    `Ask the researcher: ${QUESTION}`,
  );
  const result = await parent.run({ conversation }).result();
  const messages = result.conversation.getMessages();
  const executions = result.steps.flatMap((step) => step.results);
  const execution = executions.find((entry) => entry.toolCallId === `${id}-call`);
  const returned = typeof execution?.content === 'string' ? execution.content : '';
  const prefix = verbatimPrefixLength(returned, CHILD_ANSWER);

  return {
    parentGenerateCalls,
    childGenerateCalls,
    toolExecutions: executions.length,
    childReceived,
    finishReason: result.finishReason,
    returnedLength: returned.length,
    keepsWholeAnswer: returned === CHILD_ANSWER,
    shortenedFromChild: returned.length < CHILD_ANSWER.length,
    verbatimPrefixLength: prefix,
    cutsMidSentence: prefix > 0 && prefix % CHILD_SENTENCE.length !== 0,
    keepsChildOpening: returned.startsWith(CHILD_ANSWER.slice(0, 32)),
    matchesCustomSummary: returned === CUSTOM_SUMMARY ? 'yes' : 'no',
    transcriptRoles: messages.map((message) => message.role).join(', '),
    history: result.conversation.current,
  };
}
