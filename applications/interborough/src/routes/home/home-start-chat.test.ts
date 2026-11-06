/**
 * What Home's Start a chat card decides before it hands off to New chat (design row 01k): it starts
 * with Assistant, and Send opens New chat with the agent and the typed message.
 */
import { describe, expect, test } from 'bun:test';

import { newChatAddress, startingAgent } from './home-start-chat.ts';

describe('startingAgent', () => {
  test('is Assistant, or a plugin’s copy of it, wherever it is listed', () => {
    expect(startingAgent([{ name: 'echo' }, { name: 'assistant' }])).toBe('assistant');
    expect(startingAgent([{ name: 'echo' }, { name: 'demo:assistant' }])).toBe('demo:assistant');
  });

  test('is the first agent when there is no Assistant, and none when there are no agents', () => {
    expect(startingAgent([{ name: 'echo' }, { name: 'tool-runner' }])).toBe('echo');
    expect(startingAgent([])).toBeUndefined();
  });
});

describe('newChatAddress', () => {
  test('opens New chat with the agent and the message, trimmed and encoded', () => {
    expect(newChatAddress('assistant', '  What did I approve yesterday?  ')).toBe(
      '/chats/new?agent=assistant&message=What+did+I+approve+yesterday%3F',
    );
    expect(newChatAddress('demo:assistant', 'a & b')).toBe(
      '/chats/new?agent=demo%3Aassistant&message=a+%26+b',
    );
  });

  test('opens New chat with the agent alone when nothing is typed', () => {
    expect(newChatAddress('assistant', '')).toBe('/chats/new?agent=assistant');
    expect(newChatAddress('assistant', '   \n ')).toBe('/chats/new?agent=assistant');
  });
});
