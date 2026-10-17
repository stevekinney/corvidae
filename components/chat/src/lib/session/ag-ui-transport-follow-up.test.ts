import { describe, expect, test } from 'bun:test';
import { appendMessages, createConversationHistory } from '../components/chat/builders.ts';
import { thisTurnsOutput } from './ag-ui-transport-run.ts';

type SnapshotMessage = Parameters<typeof thisTurnsOutput>[0][number];

const message = (id: string, role: 'user' | 'assistant', content: string): SnapshotMessage => ({
  id,
  role,
  content,
});

describe('AG-UI transport and follow-up rows', () => {
  const base = appendMessages(
    appendMessages(
      createConversationHistory({ id: 'ag-ui-follow-up' }),
      { role: 'user', content: 'opener' },
      { randomId: () => 'opener' },
    ),
    {
      role: 'user',
      content: 'follow-up',
      metadata: { _followUp: true },
    },
    { randomId: () => 'follow-up' },
  );
  const snapshot = [
    message('opener', 'user', 'opener'),
    message('follow-up', 'user', 'follow-up'),
    message('reply', 'assistant', 'the reply'),
  ];

  test("the turn a run's output answers is the opener, not a follow-up row", () => {
    expect(thisTurnsOutput(snapshot, base).map((entry) => entry.id)).toEqual([
      'follow-up',
      'reply',
    ]);
  });

  test('without follow-up rows the last user message still ends the turn', () => {
    const plain = createConversationHistory({ id: 'ag-ui-plain' });

    expect(thisTurnsOutput(snapshot, plain).map((entry) => entry.id)).toEqual(['reply']);
  });
});
