import { describe, expect, test } from 'bun:test';

import {
  agentStatusLine,
  allowedToolCount,
  chatCountText,
  chatUsageByAgent,
  newChatPath,
  referenceSizeText,
  shortVersion,
  tabCountText,
  versionLine,
} from './agent-presentation.ts';

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
