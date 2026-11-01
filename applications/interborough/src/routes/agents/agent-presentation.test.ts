import { describe, expect, test } from 'bun:test';

import {
  agentFacts,
  chatCountText,
  chatUsageByAgent,
  lastChatText,
  memoryTabText,
  newChatPath,
  shortVersion,
  toolCountText,
} from './agent-presentation.ts';

const MEDIA = { modalities: {}, mimeFamilies: [], mediaLimits: [] };

describe('an agent as the agents views show it', () => {
  test('opens a new chat at an address that names it, encoded', () => {
    expect(newChatPath('research bot')).toBe('/chats/new?agent=research%20bot');
  });
});

describe('what an agent’s chats say of its use', () => {
  const NOW = Date.parse('2026-10-23T12:00:00.000Z');

  test('counts the sessions of each agent and dates the latest one', () => {
    const usage = chatUsageByAgent([
      {
        id: 'session-1',
        agentName: 'echo',
        updatedAt: '2026-10-23T11:00:00.000Z',
        activity: 'idle' as const,
      },
      {
        id: 'session-2',
        agentName: 'tool-runner',
        updatedAt: '2026-10-20T11:00:00.000Z',
        activity: 'idle' as const,
      },
      {
        id: 'session-3',
        agentName: 'echo',
        updatedAt: '2026-10-23T11:57:00.000Z',
        activity: 'idle' as const,
      },
      {
        id: 'session-4',
        agentName: 'echo',
        updatedAt: '2026-10-22T11:00:00.000Z',
        activity: 'idle' as const,
      },
    ]);

    expect(usage.get('echo')).toEqual({
      count: 3,
      lastChatAt: Date.parse('2026-10-23T11:57:00.000Z'),
      waiting: 0,
    });
    expect(usage.get('tool-runner')?.count).toBe(1);
    expect(usage.has('assistant')).toBe(false);
  });

  test('counts the chats that wait on the person, so an agent with one shows Needs you', () => {
    const usage = chatUsageByAgent([
      { id: 'a', agentName: 'echo', updatedAt: '2026-10-23T11:00:00.000Z', activity: 'idle' },
      {
        id: 'b',
        agentName: 'echo',
        updatedAt: '2026-10-23T11:10:00.000Z',
        activity: 'awaiting-input',
      },
      { id: 'c', agentName: 'echo', updatedAt: '2026-10-23T11:20:00.000Z', activity: 'running' },
      {
        id: 'd',
        agentName: 'tool-runner',
        updatedAt: '2026-10-23T11:20:00.000Z',
        activity: 'idle',
      },
    ]);

    expect(usage.get('echo')?.waiting).toBe(1);
    expect(usage.get('tool-runner')?.waiting).toBe(0);
  });

  test('counts a session the Bureau gave twice once, as a list that shifted between page reads does', () => {
    const usage = chatUsageByAgent([
      {
        id: 'session-a',
        agentName: 'echo',
        updatedAt: '2026-10-23T11:00:00.000Z',
        activity: 'idle' as const,
      },
      {
        id: 'session-b',
        agentName: 'echo',
        updatedAt: '2026-10-23T11:30:00.000Z',
        activity: 'idle' as const,
      },
      {
        id: 'session-b',
        agentName: 'echo',
        updatedAt: '2026-10-23T11:30:00.000Z',
        activity: 'idle' as const,
      },
    ]);

    expect(usage.get('echo')?.count).toBe(2);
  });

  test('counts a session whose time cannot be read without dating it by it', () => {
    const usage = chatUsageByAgent([
      { id: 'session-5', agentName: 'echo', updatedAt: 'not a time', activity: 'idle' as const },
      {
        id: 'session-6',
        agentName: 'echo',
        updatedAt: '2026-10-23T11:57:00.000Z',
        activity: 'idle' as const,
      },
      {
        id: 'session-7',
        agentName: 'echo',
        updatedAt: 'also not a time',
        activity: 'idle' as const,
      },
    ]);

    expect(usage.get('echo')).toEqual({
      count: 3,
      lastChatAt: Date.parse('2026-10-23T11:57:00.000Z'),
      waiting: 0,
    });
    expect(
      lastChatText(
        chatUsageByAgent([
          { id: 'session-8', agentName: 'echo', updatedAt: 'nope', activity: 'idle' as const },
        ]).get('echo'),
      ),
    ).toBe(undefined);
  });

  test('words the count and the last chat, and says nothing of the last chat of an agent that has had none', () => {
    const usage = { count: 1, lastChatAt: NOW - 3 * 60_000, waiting: 0 };

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
    skillDescriptors: [{ id: 'cite', name: 'Cite', description: '', tags: [] }],
    allowedSkills: null,
    a2a: true,
    stepLimit: null,
    retry: null,
    compaction: null,
    hooks: null,
    references: null,
    guardrails: null,
    costBudget: null,
    toolBudget: null,
    toolApproval: null,
    instructions: '',
  });

  test('a file agent has the model, tools and skills of its definition, and none known before it is read', () => {
    expect(
      agentFacts({ kind: 'file', media: null }, definition(['lookup-order']), undefined),
    ).toEqual({
      model: { kind: 'model', name: 'anthropic/sonnet' },
      tools: ['lookup-order'],
      skills: [{ id: 'cite', name: 'Cite' }],
    });
    expect(agentFacts({ kind: 'file', media: null }, undefined, undefined)).toEqual({
      model: { kind: 'unknown' },
      tools: null,
      skills: [],
    });
  });

  test('keeps each skill’s identifier, so two skills that share a name stay two', () => {
    const twin = (id: string) => ({ id, name: 'Cite', description: '', tags: [] });
    const facts = agentFacts(
      { kind: 'file', media: null },
      { ...definition([]), skillDescriptors: [twin('cite-a'), twin('cite-b')] },
      undefined,
    );

    expect(facts.skills).toEqual([
      { id: 'cite-a', name: 'Cite' },
      { id: 'cite-b', name: 'Cite' },
    ]);
  });

  test('a code agent whose generator the Bureau cannot look inside shows no model, not Scripted, and has the tools its listing names', () => {
    const facts = agentFacts(
      { kind: 'code', media: null, tools: ['search-web'] },
      undefined,
      undefined,
    );

    expect(facts.model).toEqual({ kind: 'unknown' });
    expect(facts.tools).toEqual(['search-web']);
    // Not even a model the Bureau would name for another agent changes it: it is never asked.
    expect(
      agentFacts({ kind: 'code', media: null }, undefined, {
        selectable: false,
        models: [{ provider: 'anthropic', model: 'claude-haiku', displayName: 'claude-haiku' }],
        default: null,
      }).model,
    ).toEqual({ kind: 'unknown' });
  });

  test('an agent whose listing names no tools has an unknown list, not an empty one', () => {
    expect(agentFacts({ kind: 'code', media: null }, undefined, undefined).tools).toBeNull();
    expect(agentFacts({ kind: 'code', media: MEDIA }, undefined, undefined).tools).toBeNull();
    expect(agentFacts({ kind: 'file', media: null }, undefined, undefined).tools).toBeNull();
    expect(
      agentFacts({ kind: 'code', media: null, tools: [] }, undefined, undefined).tools,
    ).toEqual([]);
  });

  test('a file agent’s definition outranks the tools its listing named, and the listing fills in before it is read', () => {
    const listed = { kind: 'file', media: null, tools: ['listed-tool'] } as const;

    expect(agentFacts(listed, definition(['lookup-order']), undefined).tools).toEqual([
      'lookup-order',
    ]);
    expect(agentFacts(listed, undefined, undefined).tools).toEqual(['listed-tool']);
  });

  test('a code agent that names a model shows its default, or its one allowed model, and otherwise none', () => {
    const choice = { provider: 'anthropic', model: 'claude-haiku', displayName: 'claude-haiku' };
    const code = { kind: 'code', media: MEDIA, tools: ['search-web'] } as const;

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
    // A routed agent answers no default and no single model: nothing is claimed.
    expect(
      agentFacts(code, undefined, { selectable: false, models: [], default: null }).model,
    ).toEqual({ kind: 'unknown' });
    expect(agentFacts(code, undefined, undefined).model).toEqual({ kind: 'unknown' });
    expect(agentFacts(code, undefined, undefined).tools).toEqual(['search-web']);
  });

  test('counts tools, says none for an empty list, and says nothing for an unknown one', () => {
    expect(toolCountText(['lookup-order'])).toBe('1 tool');
    expect(toolCountText(['a-tool', 'b-tool'])).toBe('2 tools');
    expect(toolCountText([])).toBe('No tools');
    expect(toolCountText(null)).toBeUndefined();
  });
});

describe('an agent’s Memory tab and file version', () => {
  test('carries the count once it is known, with a plus when pages are unread', () => {
    expect(memoryTabText(undefined, false)).toBe('Memory');
    expect(memoryTabText(0, false)).toBe('Memory');
    expect(memoryTabText(12, false)).toBe('Memory 12');
    expect(memoryTabText(20, true)).toBe('Memory 20+');
  });

  test('names a file version by the short form of its hash', () => {
    expect(shortVersion('0123456789abcdef')).toBe('01234567');
    expect(shortVersion('abc')).toBe('abc');
  });
});
