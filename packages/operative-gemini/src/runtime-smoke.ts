import { createToolbox } from 'armorer';
import { Conversation } from 'conversationalist';
import {
  createGeminiProvider,
  type GeminiGenerateContentRequest,
  type GeminiGenerativeModel,
} from './index.ts';

/** Exercises Gemini request configuration without reaching the network. */
export async function runRuntimeSmoke(): Promise<void> {
  let requests = 0;
  const fetch = async (_input: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    if (init?.method !== 'POST') throw new Error('Gemini request was not a POST.');
    return new Response('{}');
  };
  const client: GeminiGenerativeModel = {
    models: {
      async generateContent(params: GeminiGenerateContentRequest) {
        await fetch('https://provider.invalid/generateContent', {
          method: 'POST',
          body: JSON.stringify(params),
        });
        return {
          candidates: [{ content: { parts: [{ text: 'portable' }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        };
      },
    },
  };
  const conversation = new Conversation();
  conversation.appendUserMessage('Hello');
  await createGeminiProvider({ model: 'gemini-2.5-flash', client })({
    conversation,
    step: 0,
    toolbox: createToolbox([]),
  });
  if (requests !== 1) throw new Error('Gemini provider did not construct one request.');
}
