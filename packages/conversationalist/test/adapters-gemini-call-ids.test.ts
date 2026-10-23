import { describe, expect, it } from 'bun:test';

import { fromGeminiMessages } from '../src/adapters/gemini/inbound';
import { toGeminiMessages } from '../src/adapters/gemini/outbound';
import { fromMarkdown, toMarkdown } from '../src/index';
import { createToolCallConversation, requireRecord } from './adapter-test-fixtures';

function idsOf(parts: ReadonlyArray<unknown>, key: 'functionCall' | 'functionResponse') {
  return parts
    .filter((part) => key in requireRecord(part))
    .map((part) => requireRecord(requireRecord(part)[key]).id);
}

const sameNamePayload = {
  contents: [
    {
      role: 'model' as const,
      parts: [
        { functionCall: { id: 'a', name: 'search', args: { q: '1' } } },
        { functionCall: { id: 'b', name: 'search', args: { q: '2' } } },
      ],
    },
    {
      role: 'user' as const,
      parts: [
        { functionResponse: { id: 'b', name: 'search', response: { result: 'B' } } },
        { functionResponse: { id: 'a', name: 'search', response: { result: 'A' } } },
      ],
    },
  ],
};

describe('Gemini function-call ids (COR-1671)', () => {
  it('pairs same-name calls by id on import and records the id on the tool call', () => {
    const messages = Object.values(fromGeminiMessages(sameNamePayload).messages);
    const calls = messages.filter((m) => m.role === 'tool-call');
    const results = messages.filter((m) => m.role === 'tool-result');
    expect(calls.map((m) => m.toolCall?.providerCallId)).toEqual(['a', 'b']);
    expect(results.map((m) => m.toolResult?.callId)).toEqual([
      calls[1]?.toolCall?.id,
      calls[0]?.toolCall?.id,
    ]);
  });

  it('echoes each id on its functionCall and functionResponse after a round trip', () => {
    const parts = toGeminiMessages(fromGeminiMessages(sameNamePayload)).contents.flatMap(
      (c) => c.parts,
    );
    expect(idsOf(parts, 'functionCall')).toEqual(['a', 'b']);
    expect(idsOf(parts, 'functionResponse')).toEqual(['b', 'a']);
    const first = requireRecord(parts.find((p) => 'functionResponse' in p));
    expect(requireRecord(first.functionResponse).response).toEqual({ result: 'B' });
  });

  it('emits no id when Gemini issued none, never the internal id', () => {
    const parts = toGeminiMessages(createToolCallConversation()).contents.flatMap((c) => c.parts);
    expect(idsOf(parts, 'functionCall')).toEqual([undefined]);
    expect(idsOf(parts, 'functionResponse')).toEqual([undefined]);
    expect(JSON.stringify(parts)).not.toContain('call-123');
  });

  it('echoes an id only for the call that had one in a mixed history', () => {
    const imported = fromGeminiMessages({
      contents: [
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'a', name: 'search', args: {} } },
            { functionCall: { name: 'search', args: {} } },
          ],
        },
        {
          role: 'user',
          parts: [
            { functionResponse: { id: 'a', name: 'search', response: { result: 1 } } },
            { functionResponse: { name: 'search', response: { result: 2 } } },
          ],
        },
      ],
    });
    const parts = toGeminiMessages(imported).contents.flatMap((c) => c.parts);
    expect(idsOf(parts, 'functionCall')).toEqual(['a', undefined]);
    expect(idsOf(parts, 'functionResponse')).toEqual(['a', undefined]);
  });

  it('keeps the id through a Markdown round trip', () => {
    const imported = fromGeminiMessages(sameNamePayload);
    const restored = fromMarkdown(toMarkdown(imported, { includeMetadata: true }));
    const calls = Object.values(restored.messages).filter((m) => m.role === 'tool-call');
    expect(calls.map((m) => m.toolCall?.providerCallId)).toEqual(['a', 'b']);
    const parts = toGeminiMessages(restored).contents.flatMap((c) => c.parts);
    expect(idsOf(parts, 'functionCall')).toEqual(['a', 'b']);
  });
});
