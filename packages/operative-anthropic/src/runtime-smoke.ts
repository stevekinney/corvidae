import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import {
  createAnthropicProvider,
  type AnthropicClient,
  type AnthropicMessageCreateRequest,
} from './index.ts';

/** Exercises Anthropic request configuration without reaching the network. */
export async function runRuntimeSmoke(): Promise<void> {
  let requests = 0;
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    if (init?.method !== 'POST') throw new Error('Anthropic request was not a POST.');
    return new Response('{}');
  };
  const client: AnthropicClient = {
    messages: {
      async create(params: AnthropicMessageCreateRequest) {
        await fetch('https://provider.invalid/messages', {
          method: 'POST',
          body: JSON.stringify(params),
        });
        return {
          content: [{ type: 'text', text: 'portable' }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 1, output_tokens: 1 },
        };
      },
    },
  };
  const conversation = new Conversation();
  conversation.appendUserMessage('Hello');
  await createAnthropicProvider({ model: 'claude-3-5-sonnet-20241022', client })({
    conversation,
    step: 0,
    toolbox: createToolbox([]),
  });
  if (requests !== 1) throw new Error('Anthropic provider did not construct one request.');
}
