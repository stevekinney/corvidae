import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { createActiveRun } from '../src/create-run';
import { MediaAdmissionError } from '../src/errors';
import { createGeminiProvider } from '../src/providers/gemini.ts';
import { geminiTextResponse } from '../src/providers/test/gemini-fixtures.ts';
import { createMockGeminiModel } from '../src/providers/test/gemini-mock-clients.ts';

function runWithRemoteImage(model: string) {
  const client = createMockGeminiModel([geminiTextResponse]);
  const conversation = new Conversation();
  conversation.appendUserMessage([
    {
      type: 'image',
      mimeType: 'image/png',
      source: { kind: 'remote-url', url: 'https://example.com/a.png' },
    },
  ]);
  const result = createActiveRun({
    generate: createGeminiProvider({ model, client }),
    toolbox: createToolbox([]),
    conversation,
    stopWhen: () => true,
  }).result;
  return { client, result };
}

describe('a remote URL through Gemini (COR-716)', () => {
  it('is refused before the provider call on a model that does not fetch URLs itself', async () => {
    const { client, result } = runWithRemoteImage('gemini-2.0-flash');

    const outcome = await result;

    expect(outcome.error).toBeInstanceOf(MediaAdmissionError);
    expect((outcome.error as MediaAdmissionError).outcomes[0]).toMatchObject({
      outcome: 'unsupported',
      reason: 'source-form-not-accepted',
    });
    expect(client._calls).toHaveLength(0);
  });

  it('is admitted and sent on a model that does, since Gemini bounds each part', async () => {
    const { client, result } = runWithRemoteImage('gemini-2.5-pro');

    const outcome = await result;

    expect(outcome.finishReason).not.toBe('error');
    expect(JSON.stringify(client._calls[0])).toContain('https://example.com/a.png');
  });
});
