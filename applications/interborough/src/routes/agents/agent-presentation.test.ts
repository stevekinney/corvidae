import { describe, expect, test } from 'bun:test';

import {
  agentFacts,
  agentStatusLine,
  allowedToolCount,
  chatCountText,
  chatUsageByAgent,
  newChatPath,
  referenceSizeText,
  shortVersion,
  tabCountText,
  toolCountText,
  versionLine,
} from './agent-presentation.ts';

const MEDIA = { modalities: {}, mimeFamilies: [], mediaLimits: [] };

describe('an agent as the agents views show it', () => {
  test('opens a new chat at an address that names it, encoded', () => {
    expect(newChatPath('research bot')).toBe('/chats/new?agent=research%20bot');
  });
});

describe('the status line under an agent’s description', () => {
  const usage = (waiting: number, running: number, count = 3) => ({
    count,
    lastChatAt: null,
    waiting,
    running,
  });

  test('says a chat waits on the person first, in amber, then the count, with no middle dot', () => {
    expect(agentStatusLine(usage(1, 1), { known: true, unavailable: false })).toEqual({
      tone: 'warning',
      text: 'Waiting on you, 3 chats',
    });
    expect(agentStatusLine(usage(0, 2), { known: true, unavailable: false })).toEqual({
      tone: 'info',
      text: 'Running, 3 chats',
    });
    expect(agentStatusLine(usage(0, 0), { known: true, unavailable: false })).toEqual({
      tone: null,
      text: '3 chats',
    });
    expect(agentStatusLine(usage(1, 0), { known: true, unavailable: false })?.text).not.toContain(
      String.fromCodePoint(0xb7),
    );
  });

  test('says an agent with no chats has none, and says nothing while the chats are not known', () => {
    expect(agentStatusLine(undefined, { known: true, unavailable: false })).toEqual({
      tone: null,
      text: 'No chats yet',
    });
    expect(agentStatusLine(undefined, { known: false, unavailable: false })).toBeUndefined();
  });

  test('says an agent a disabled plugin ships is unavailable, in a neutral tone, whatever its chats do', () => {
    expect(agentStatusLine(usage(1, 0, 1), { known: true, unavailable: true })).toEqual({
      tone: 'neutral',
      text: 'Unavailable, 1 chat',
    });
    expect(agentStatusLine(undefined, { known: false, unavailable: true })).toEqual({
      tone: 'neutral',
      text: 'Unavailable',
    });
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
      running: 0,
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
    expect(usage.get('echo')?.running).toBe(1);
    expect(usage.get('tool-runner')?.running).toBe(0);
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
      running: 0,
    });
    expect(
      chatUsageByAgent([
        { id: 'session-8', agentName: 'echo', updatedAt: 'nope', activity: 'idle' as const },
      ]).get('echo')?.lastChatAt,
    ).toBeNull();
  });

  test('words the count of chats, and says none yet for an agent that has had none', () => {
    const usage = { count: 1, lastChatAt: NOW - 3 * 60_000, waiting: 0, running: 0 };

    expect(chatCountText(usage)).toBe('1 chat');
    expect(chatCountText({ ...usage, count: 12 })).toBe('12 chats');
    expect(chatCountText(undefined)).toBe('No chats yet');
  });
});

describe('an agent’s facts', () => {
  const definition = (tools: readonly string[]) => ({
    name: 'Researcher',
    description: null,
    model: 'anthropic/sonnet',
    models: null,
    effort: null,
    tools: [...tools],
    card: [{ id: 'cite', name: 'Cite', description: '', tags: [] }],
    skills: null,
    a2a: true,
    limits: { steps: null, cost: null, tools: null },
    retry: null,
    compaction: null,
    interceptors: null,
    references: null,
    guardrails: null,
    approvals: null,
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
      { ...definition([]), card: [twin('cite-a'), twin('cite-b')] },
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

describe('an agent’s tab counts and file version', () => {
  test('carries a tab’s count once it is known, zero included, with a plus when pages are unread', () => {
    expect(tabCountText(undefined)).toBeUndefined();
    expect(tabCountText(0)).toBe('0');
    expect(tabCountText(12)).toBe('12');
    expect(tabCountText(20, true)).toBe('20+');
  });

  test('counts the tools an agent may call from its file, its own statement, or its listing', () => {
    const file = { definition: { tools: ['a', 'b', 'c'] }, codeDefinition: null } as never;
    const code = { definition: null, codeDefinition: { tools: ['a', 'b'] } } as never;
    const silent = { definition: null, codeDefinition: null } as never;
    expect(allowedToolCount(file, undefined)).toBe(3);
    expect(allowedToolCount(code, ['x'])).toBe(2);
    expect(allowedToolCount(silent, ['x'])).toBe(1);
    expect(allowedToolCount(undefined, undefined)).toBeUndefined();
  });

  test('names a file version by the short form of its hash', () => {
    expect(shortVersion('0123456789abcdef')).toBe('01234567');
    expect(shortVersion('abc')).toBe('abc');
  });
});

describe('versionLine', () => {
  test('says the version, the day it was saved and that you saved it', () => {
    expect(
      versionLine(
        { revision: 4, savedAt: '2026-10-29T15:00:00.000Z', savedBy: 'anonymous:local' },
        'UTC',
      ),
    ).toBe('Version 4, saved Oct 29 by you');
  });

  test('says a version made by editing the file was saved in the file, and reads the day in the zone given', () => {
    expect(
      versionLine(
        { revision: 2, savedAt: '2026-10-29T01:00:00.000Z', savedBy: null },
        'America/Chicago',
      ),
    ).toBe('Version 2, saved Oct 28 in the file');
  });

  test('says nothing when the time cannot be read', () => {
    expect(
      versionLine({ revision: 1, savedAt: 'not a date', savedBy: null }, 'UTC'),
    ).toBeUndefined();
  });
});

describe('referenceSizeText', () => {
  test('drops the decimal of a whole number of units and keeps the rest', () => {
    expect(referenceSizeText(4096)).toBe('4 KB');
    expect(referenceSizeText(1536)).toBe('1.5 KB');
    expect(referenceSizeText(214_016)).toBe('209 KB');
    expect(referenceSizeText(512)).toBe('512 B');
  });

  test('says nothing when the Bureau did not give a size', () => {
    expect(referenceSizeText(undefined)).toBeUndefined();
  });
});
