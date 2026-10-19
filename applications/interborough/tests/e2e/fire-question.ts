/**
 * The model a schedule's fire runs in the end-to-end host. A fire passes only its agent's name into
 * the Bureau-wide runtime, so it runs the Bureau's own `generate` and not the agent's script
 * (`src/host/seed.ts`). This one asks a question when the fire's input is
 * {@link FIRE_QUESTION_INPUT}, and thanks the person once the answer is the last thing in the
 * conversation, as `request-human-input`'s script does for a chat session. Any other input gets the
 * seeded default's reply, so the seeded schedule and goal run as they always have.
 */
import type { GenerateFunction, GenerateResponse } from '@lostgradient/operative';

import { HUMAN_INPUT_SIGNAL, createSeededGenerate } from '../../src/host/seed.ts';

export const FIRE_QUESTION_INPUT = 'Ask which environment the scheduled release goes to';
export const FIRE_QUESTION_PROMPT = 'Which environment should the scheduled release go to?';

export function createFireQuestionGenerate(): GenerateFunction {
  const fallback = createSeededGenerate();
  return async (request) => {
    const messages = request.conversation.getMessages();
    const opener = messages.find((message) => message.role === 'user');
    if (opener?.content !== FIRE_QUESTION_INPUT) return fallback(request);
    const last = messages.at(-1);
    if (
      last?.role === 'user' &&
      typeof last.content === 'string' &&
      last.content.startsWith(`[signal:${HUMAN_INPUT_SIGNAL}]`)
    ) {
      return { content: 'Thanks, the scheduled release will go there.', toolCalls: [] };
    }
    const asked = messages.filter((message) => message.toolCall !== undefined).length;
    const response: GenerateResponse = {
      content: '',
      toolCalls: [
        {
          id: `fire-requestHumanInput-${asked + 1}`,
          name: 'requestHumanInput',
          arguments: { signalName: HUMAN_INPUT_SIGNAL, prompt: FIRE_QUESTION_PROMPT },
        },
      ],
    };
    return response;
  };
}
