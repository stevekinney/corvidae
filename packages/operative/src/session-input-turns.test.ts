import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';

import { stepSessionInputIds } from './session-input-turns';

function delivered(id: string, content: string) {
  return { role: 'user' as const, content, metadata: { sessionInputId: id } };
}

describe('stepSessionInputIds', () => {
  it('names the delivered turns that end the conversation, oldest first', () => {
    const conversation = new Conversation();
    conversation.appendMessages(
      { role: 'user', content: 'Start' },
      { role: 'assistant', content: 'working' },
      delivered('input-a', 'first'),
      delivered('input-b', 'second'),
    );
    expect(stepSessionInputIds(conversation)).toEqual(['input-a', 'input-b']);
  });

  it("stops at the reply in front of them, so an earlier step's inputs are not named again", () => {
    const conversation = new Conversation();
    conversation.appendMessages({ role: 'user', content: 'Start' }, delivered('input-a', 'first'), {
      role: 'assistant',
      content: 'answered',
    });
    expect(stepSessionInputIds(conversation)).toEqual([]);
  });

  it('names nothing for a turn the person started the run with', () => {
    const conversation = new Conversation();
    conversation.appendMessages({ role: 'user', content: 'Start' });
    expect(stepSessionInputIds(conversation)).toEqual([]);
  });
});
