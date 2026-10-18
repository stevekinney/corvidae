import { describe, expect, it } from 'bun:test';

import { toOpenAIMessages } from '../src/adapters/openai/outbound';
import { appendMessages, createConversationHistory } from '../src/conversation';

/**
 * COR-716: cross-provider modality, source, role, and rejection matrix. Every
 * row ends in a no-silent-loss assertion: an adapter either carries the
 * caller's payload through to the provider request or rejects before the
 * provider call. It never substitutes marker prose, an empty string, or text
 * alone.
 */
const PDF_BASE64 = 'JVBERi0xLjQKJcfsj6IKJSVFT0YK';

function expectNoSilentLoss(exportRequest: () => unknown, payload: string): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(exportRequest());
  } catch (error) {
    // A pre-provider rejection must be a real, named error, not a bare
    // `Error` that any bug would also produce.
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).not.toBe('Error');
    return;
  }
  expect(serialized).toContain(payload);
  expect(serialized).not.toContain('base64 data omitted');
  expect(serialized).not.toContain('[Document:');
}

describe('provider conversion matrix', () => {
  it('OpenAI user document (base64, user role) is delivered or rejected, never marker prose', () => {
    let conversation = createConversationHistory();
    conversation = appendMessages(conversation, {
      role: 'user',
      content: [
        { type: 'text', text: 'Summarize the attached file.' },
        {
          type: 'document',
          name: 'requirements.pdf',
          mimeType: 'application/pdf',
          source: { kind: 'inline', data: PDF_BASE64, encoding: 'base64' },
        },
      ],
    });

    expectNoSilentLoss(() => toOpenAIMessages(conversation), PDF_BASE64);
  });
});
