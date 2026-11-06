/**
 * What Home's Start a chat card decides before it hands off to New chat (design row 01k): it starts
 * with Assistant, and Send opens New chat with the agent.
 */
import { describe, expect, test } from 'bun:test';

import { findAssistant, newChatAddress, startingAgent } from './home-start-chat.ts';

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

describe('findAssistant', () => {
  test('is Assistant or a plugin’s copy of it, and nothing on a host that lists none', () => {
    expect(findAssistant([{ name: 'echo' }, { name: 'assistant' }])).toBe('assistant');
    expect(findAssistant([{ name: 'demo:assistant' }])).toBe('demo:assistant');
    expect(findAssistant([{ name: 'echo' }, { name: 'tool-runner' }])).toBeUndefined();
    expect(findAssistant([])).toBeUndefined();
  });
});

describe('newChatAddress', () => {
  test('opens New chat with the agent, and never the message', () => {
    expect(newChatAddress('assistant')).toBe('/chats/new?agent=assistant');
    expect(newChatAddress('demo:assistant')).toBe('/chats/new?agent=demo%3Aassistant');
  });
});
