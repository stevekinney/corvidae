/**
 * Values that name something in Interborough: a chat, an agent and a run link under their own
 * names, plain values stay plain, and an identifier nothing knows is never a dead link.
 */
import { describe, expect, test } from 'bun:test';

import { agentPath } from '../../../lib/agent-paths.ts';
import { chatSessionPath } from '../../../lib/identifier-paths.ts';
import { workflowDetailPath } from '../../../lib/router.svelte.ts';
import {
  NO_LOOKUPS,
  payloadLinkFor,
  payloadReferences,
  payloadValueText,
  shortRunName,
  type PayloadLookups,
} from './run-payload-links.ts';

const field = (key: string, value: unknown, path: string[] = [key]) => ({ path, key, value });

const known: PayloadLookups = {
  chats: new Map([['chat-1', 'Please refund order 4471…']]),
  agents: new Map([['tool-runner', 'Tool runner']]),
  runs: new Set(['run-8f2c0d71']),
};

describe('payloadReferences', () => {
  test('lists the chats, agents and runs a payload’s top-level properties name', () => {
    expect(
      payloadReferences({
        chatId: 'chat-1',
        agent: 'tool-runner',
        orderId: '4471',
        runId: 'run-8f2c0d71',
      }),
    ).toEqual({ chats: ['chat-1'], agents: ['tool-runner'], runs: ['run-8f2c0d71'] });
  });

  test('reads nothing from a payload that is not an object, or from nested or empty values', () => {
    const none = { chats: [], agents: [], runs: [] };
    expect(payloadReferences('chat-1')).toEqual(none);
    expect(payloadReferences(['chat-1'])).toEqual(none);
    expect(payloadReferences(null)).toEqual(none);
    expect(payloadReferences({ nested: { chatId: 'chat-1' }, chatId: '', agent: 7 })).toEqual(none);
  });
});

describe('payloadLinkFor and payloadValueText', () => {
  test('lead a known chat, agent and run to their pages, under their own names', () => {
    expect(payloadLinkFor(field('chatId', 'chat-1'), known)).toBe(chatSessionPath('chat-1'));
    expect(payloadValueText(field('chatId', 'chat-1'), known)).toBe('Please refund order 4471…');
    expect(payloadLinkFor(field('agent', 'tool-runner'), known)).toBe(agentPath('tool-runner'));
    expect(payloadValueText(field('agent', 'tool-runner'), known)).toBe('Tool runner');
    expect(payloadLinkFor(field('runId', 'run-8f2c0d71'), known)).toBe(
      workflowDetailPath('run-8f2c0d71'),
    );
    expect(payloadValueText(field('runId', 'run-8f2c0d71'), known)).toBe('Run 8f2c');
  });

  test('leave a plain value, and an identifier nothing knows, as text', () => {
    expect(payloadLinkFor(field('orderId', '4471'), known)).toBeUndefined();
    expect(payloadValueText(field('orderId', '4471'), known)).toBeUndefined();
    expect(payloadLinkFor(field('chatId', 'chat-gone'), known)).toBeUndefined();
    expect(payloadValueText(field('chatId', 'chat-gone'), known)).toBeUndefined();
    expect(payloadLinkFor(field('agent', 'ghost'), known)).toBeUndefined();
    expect(payloadLinkFor(field('runId', 'run-nope'), known)).toBeUndefined();
    expect(payloadLinkFor(field('runId', 'run-8f2c0d71'), NO_LOOKUPS)).toBeUndefined();
  });

  test('read only a top-level text value', () => {
    expect(payloadLinkFor(field('chatId', 'chat-1', ['order', 'chatId']), known)).toBeUndefined();
    expect(payloadLinkFor(field('chatId', 42), known)).toBeUndefined();
  });

  test('keep a chat’s stored id when the chat has no title to read it as', () => {
    const untitled: PayloadLookups = { ...known, chats: new Map([['chat-1', '']]) };
    expect(payloadLinkFor(field('chatId', 'chat-1'), untitled)).toBe(chatSessionPath('chat-1'));
    expect(payloadValueText(field('chatId', 'chat-1'), untitled)).toBeUndefined();
  });
});

describe('shortRunName', () => {
  test('names a run by the first four characters after run-, or of the id when it has no prefix', () => {
    expect(shortRunName('run-8f2c0d71')).toBe('Run 8f2c');
    expect(shortRunName('abcdef')).toBe('Run abcd');
  });
});
