import { describe, expect, it } from 'bun:test';
import type { ConversationHistory } from 'conversationalist';

import { sharedSnapshotMessages } from './ag-ui-messages.ts';

describe('shared thread message projection', () => {
  it('retains visible text while withholding tools, attachments, reasoning, and metadata', () => {
    const history = {
      id: 'shared',
      ids: ['user', 'tool', 'assistant'],
      messages: {
        user: { id: 'user', role: 'user', content: 'See [public](https://example.com). ![asset](/attachments/private.png)' },
        tool: { id: 'tool', role: 'tool-result', content: 'private tool result' },
        assistant: { id: 'assistant', role: 'assistant', content: [{ type: 'thinking', text: 'private reasoning' }, { type: 'text', text: 'Answer with [citation](https://example.com/source).' }], metadata: { approval: 'private' } },
      },
    } as unknown as ConversationHistory;

    expect(sharedSnapshotMessages(history)).toEqual([
      { id: 'user', role: 'user', content: 'See [public](https://example.com). ' },
      { id: 'assistant', role: 'assistant', content: 'Answer with [citation](https://example.com/source).' },
    ]);
  });
});
