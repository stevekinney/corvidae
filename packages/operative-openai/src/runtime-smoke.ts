import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import {
  createOpenAIProvider,
  type OpenAIChatCompletionCreateRequest,
  type OpenAIClient,
} from './index.ts';

/** Exercises OpenAI request configuration without reaching the network. */
export async function runRuntimeSmoke(): Promise<void> {
  let requests = 0;
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    if (init?.method !== 'POST') throw new Error('OpenAI request was not a POST.');
    return new Response('{}');
  };
  const client: OpenAIClient = {
    chat: {
      completions: {
        async create(params: OpenAIChatCompletionCreateRequest) {
          await fetch('https://provider.invalid/chat/completions', {
            method: 'POST',
            body: JSON.stringify(params),
          });
          return {
            choices: [{ message: { content: 'portable' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          };
        },
      },
    },
  };
  const conversation = new Conversation();
  conversation.appendUserMessage('Hello');
  await createOpenAIProvider({ model: 'gpt-4o-mini', client })({
    conversation,
    step: 0,
    toolbox: createToolbox([]),
  });
  if (requests !== 1) throw new Error('OpenAI provider did not construct one request.');
}
