import { describe, expect, test } from 'bun:test';

import type { AgentSummary } from '../../lib/bureau-client.ts';
import {
  agentFacts,
  canChat,
  chatCountText,
  chatUsageByAgent,
  lastChatText,
  memoryActionText,
  newChatPath,
  shortVersion,
  toolCountText,
} from './agent-presentation.ts';

const agent = (publishState: AgentSummary['publishState']): AgentSummary => ({
  name: 'research bot',
  displayName: 'Research bot',
  description: null,
  definitionRevision: 1,
  kind: 'file',
  publishState,
  media: null,
});

const MEDIA = { modalities: {}, mimeFamilies: [], mediaLimits: [] };

describe('an agent as the agents views show it', () => {
  test('can be chatted with only when it is published', () => {
    expect(canChat(agent('published'))).toBe(true);
    expect(canChat(agent('withdrawn'))).toBe(false);
    expect(canChat(agent('unpublished'))).toBe(false);
  });

  test('opens a new chat at an address that names it, encoded', () => {
    expect(newChatPath('research bot')).toBe('/chat/new?agent=research%20bot');
  });
});

describe('what an agent’s chats say of its use', () => {
  const NOW = Date.parse('2026-10-23T12:00:00.000Z');

  test('counts the sessions of each agent and dates the latest one', () => {
    const usage = chatUsageByAgent([
      { agentName: 'echo', updatedAt: '2026-10-23T11:00:00.000Z' },
      { agentName: 'tool-runner', updatedAt: '2026-10-20T11:00:00.000Z' },
      { agentName: 'echo', updatedAt: '2026-10-23T11:57:00.000Z' },
      { agentName: 'echo', updatedAt: '2026-10-22T11:00:00.000Z' },
    ]);

    expect(usage.get('echo')).toEqual({
      count: 3,
      lastChatAt: Date.parse('2026-10-23T11:57:00.000Z'),
    });
    expect(usage.get('tool-runner')?.count).toBe(1);
    expect(usage.has('assistant')).toBe(false);
  });

  test('counts a session whose time cannot be read without dating it by it', () => {
    const usage = chatUsageByAgent([
      { agentName: 'echo', updatedAt: 'not a time' },
      { agentName: 'echo', updatedAt: '2026-10-23T11:57:00.000Z' },
      { agentName: 'echo', updatedAt: 'also not a time' },
    ]);

    expect(usage.get('echo')).toEqual({
      count: 3,
      lastChatAt: Date.parse('2026-10-23T11:57:00.000Z'),
    });
    expect(
      lastChatText(chatUsageByAgent([{ agentName: 'echo', updatedAt: 'nope' }]).get('echo')),
    ).toBe(undefined);
  });

  test('words the count and the last chat, and says nothing of the last chat of an agent that has had none', () => {
    const usage = { count: 1, lastChatAt: NOW - 3 * 60_000 };

    expect(chatCountText(usage)).toBe('1 chat');
    expect(chatCountText({ ...usage, count: 12 })).toBe('12 chats');
    expect(chatCountText(undefined)).toBe('No chats yet');
    expect(lastChatText(usage, NOW)).toBe('Last chat 3m ago');
    expect(lastChatText(undefined, NOW)).toBeUndefined();
  });
});

describe('an agent’s facts', () => {
  const definition = (tools: readonly string[]) => ({
    name: 'Researcher',
    description: null,
    model: 'anthropic/sonnet',
    models: null,
    tools: [...tools],
    skills: [{ id: 'cite', name: 'Cite', description: '', tags: [] }],
    published: true,
    instructions: '',
  });

  test('a file agent has the model, tools and skills of its definition, and none known before it is read', () => {
    expect(
      agentFacts({ kind: 'file', media: null }, definition(['lookup-order']), undefined),
    ).toEqual({
      model: { kind: 'model', name: 'anthropic/sonnet' },
      tools: ['lookup-order'],
      skills: ['Cite'],
    });
    expect(agentFacts({ kind: 'file', media: null }, undefined, undefined)).toEqual({
      model: { kind: 'unknown' },
      tools: null,
      skills: [],
    });
  });

  test('a code agent that names no model is Scripted, and its tools are not known, not none', () => {
    const facts = agentFacts({ kind: 'code', media: null }, undefined, undefined);

    expect(facts.model).toEqual({ kind: 'scripted' });
    expect(facts.tools).toBeNull();
  });

  test('a code agent that names a model shows its default, or its one allowed model, and otherwise none', () => {
    const choice = { provider: 'anthropic', model: 'claude-haiku', displayName: 'claude-haiku' };
    const code = { kind: 'code', media: MEDIA } as const;

    expect(
      agentFacts(code, undefined, {
        selectable: false,
        models: [choice],
        default: { provider: 'anthropic', model: 'claude-haiku' },
      }).model,
    ).toEqual({ kind: 'model', name: 'claude-haiku' });
    expect(
      agentFacts(code, undefined, { selectable: false, models: [choice], default: null }).model,
    ).toEqual({ kind: 'model', name: 'claude-haiku' });
    // A routed agent answers no default and no single model: nothing is claimed, not Scripted.
    expect(
      agentFacts(code, undefined, { selectable: false, models: [], default: null }).model,
    ).toEqual({ kind: 'unknown' });
    expect(agentFacts(code, undefined, undefined).model).toEqual({ kind: 'unknown' });
  });

  test('counts tools, says none for an empty list, and says nothing for an unknown one', () => {
    expect(toolCountText(['lookup-order'])).toBe('1 tool');
    expect(toolCountText(['a-tool', 'b-tool'])).toBe('2 tools');
    expect(toolCountText([])).toBe('No tools');
    expect(toolCountText(null)).toBeUndefined();
  });
});

describe('an agent’s memory action and file version', () => {
  test('carries the count once it is known, with a plus when pages are unread', () => {
    expect(memoryActionText(undefined, false)).toBe('Memory');
    expect(memoryActionText(0, false)).toBe('Memory');
    expect(memoryActionText(12, false)).toBe('Memory (12)');
    expect(memoryActionText(20, true)).toBe('Memory (20+)');
  });

  test('names a file version by the short form of its hash', () => {
    expect(shortVersion('0123456789abcdef')).toBe('01234567');
    expect(shortVersion('abc')).toBe('abc');
  });
});
