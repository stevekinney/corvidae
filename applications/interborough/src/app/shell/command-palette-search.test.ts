/**
 * The command palette's search. It searches schedules only when the principal
 * holds `schedules:read`, which `weft.schedules.list` requires; without it the
 * read is skipped rather than sent and answered with a fault.
 */
import type { HttpClient } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import type { AgentSummary, ChatContext } from '../../lib/bureau-client.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import {
  matchAgents,
  matchChats,
  matchNewChats,
  matchPages,
  newChatLabel,
  searchConsole,
  type ConsoleSearchResults,
} from './command-palette-search.ts';

const NOTHING: ConsoleSearchResults = {
  chats: [],
  agents: [],
  newChats: [],
  workflows: [],
  schedules: [],
  workers: [],
  reviews: [],
  pages: [],
};

function chat(overrides: Partial<ChatContext>): ChatContext {
  return {
    id: 'chat-1',
    owner: null,
    agentName: 'assistant',
    title: null,
    lastMessagePreview: null,
    parentContextId: null,
    forkedFromMessageId: null,
    origin: 'chat',
    messageCount: 2,
    createdAt: '2026-10-23T14:00:00.000Z',
    updatedAt: '2026-10-23T14:00:00.000Z',
    activity: 'idle',
    ...overrides,
  };
}

function agent(overrides: Partial<AgentSummary>): AgentSummary {
  return {
    name: 'assistant',
    displayName: 'assistant',
    description: null,
    definitionRevision: 1,
    kind: 'code',
    a2a: false,
    media: null,
    ...overrides,
  };
}

const ECHO_CHAT = chat({ id: 'echo-chat', agentName: 'echo', title: 'Hello echo, say this back' });
const ECHO_AGENT = agent({ name: 'echo', description: 'Repeats the last message it was sent.' });

const OPEN = { disabled: false, title: undefined } as const;
const LOCKED = { disabled: true, title: 'Requires schedules:read' } as const;

function fakeClient(calls: { schedules: number }): HttpClient {
  return {
    list: async () => ({
      items: [
        { id: 'nightly-order', type: 'order' },
        { id: 'weekly-order', type: 'order' },
      ],
      total: 2,
    }),
    listSchedules: async () => {
      calls.schedules += 1;
      return {
        items: [
          { id: 'nightly-rollup', workflowType: 'sweep' },
          { id: 'weekly-digest', workflowType: 'digest' },
        ],
      };
    },
    listReviews: async () => [{ reviewId: 'nightly-review' }, { reviewId: 'other-review' }],
    operations: {
      'weft.workers.list': async () => ({
        items: [
          { id: 'nightly-worker', queue: 'default' },
          { id: 'other-worker', queue: 'default' },
        ],
      }),
    },
  } as unknown as HttpClient;
}

describe('searchConsole', () => {
  test('searches workflows, schedules, workers, and reviews with schedules:read', async () => {
    const calls = { schedules: 0 };

    const results = await searchConsole(fakeClient(calls), 'nightly', { scheduleReadGate: OPEN });

    expect(results.workflows.map((workflow) => workflow.id)).toEqual(['nightly-order']);
    expect(results.schedules.map((schedule) => schedule.id)).toEqual(['nightly-rollup']);
    expect(results.workers.map((worker) => worker.id)).toEqual(['nightly-worker']);
    expect(results.reviews.map((review) => review.reviewId)).toEqual(['nightly-review']);
    expect(calls.schedules).toBe(1);
  });

  test('skips the schedule read, and returns no schedules, without schedules:read', async () => {
    const calls = { schedules: 0 };

    const results = await searchConsole(fakeClient(calls), 'nightly', {
      scheduleReadGate: LOCKED,
    });

    expect(calls.schedules).toBe(0);
    expect(results.schedules).toEqual([]);
    // The other domains are unaffected.
    expect(results.workers.map((worker) => worker.id)).toEqual(['nightly-worker']);
  });

  test('returns nothing for an empty query, and does not call the client', async () => {
    const calls = { schedules: 0 };

    const results = await searchConsole(fakeClient(calls), '', { scheduleReadGate: OPEN });

    expect(results).toEqual(NOTHING);
    expect(calls.schedules).toBe(0);
  });

  test('does not search workflows by id prefix for a query that is not an id prefix', async () => {
    const results = await searchConsole(fakeClient({ schedules: 0 }), 'nightly rollup', {
      scheduleReadGate: OPEN,
    });

    expect(results.workflows).toEqual([]);
  });

  test('treats a domain whose search fails (for example a 403) as no results, not an error', async () => {
    const refuse = async (): Promise<never> => {
      throw new Error('403 Forbidden');
    };
    const failing = {
      list: refuse,
      listSchedules: refuse,
      listReviews: refuse,
      operations: { 'weft.workers.list': refuse },
    } as unknown as HttpClient;

    const results = await searchConsole(failing, 'nightly', { scheduleReadGate: OPEN });

    expect(results).toEqual(NOTHING);
  });
});

describe('the chat and agent matches', () => {
  test('a chat matches on its title, its agent, or its last message', () => {
    const byPreview = chat({ id: 'a', title: null, lastMessagePreview: 'The echo came back' });
    const unrelated = chat({ id: 'b', title: 'Refund order', agentName: 'tool-runner' });

    expect(matchChats([unrelated, ECHO_CHAT, byPreview], 'ech').map((match) => match.id)).toEqual([
      'echo-chat',
      'a',
    ]);
    expect(matchChats([unrelated], 'TOOL-').map((match) => match.id)).toEqual(['b']);
  });

  test('lists at most five chats', () => {
    const many = Array.from({ length: 8 }, (_, index) => chat({ id: `c${index}`, title: 'echo' }));
    expect(matchChats(many, 'echo')).toHaveLength(5);
  });

  test('an agent matches on its name, display name, or description', () => {
    const named = agent({ name: 'tool-runner', displayName: 'Tool runner' });
    expect(matchAgents([named, ECHO_AGENT], 'ech').map((match) => match.name)).toEqual(['echo']);
    expect(matchAgents([named, ECHO_AGENT], 'runner').map((match) => match.name)).toEqual([
      'tool-runner',
    ]);
    expect(matchAgents([named, ECHO_AGENT], 'last message').map((match) => match.name)).toEqual([
      'echo',
    ]);
  });

  test('offers a new chat with every agent, whether or not it opts into A2A, by the words of the command', () => {
    const optedIn = agent({ name: 'echo-draft', a2a: true });
    expect(matchNewChats([ECHO_AGENT, optedIn], 'ech').map((match) => match.name)).toEqual([
      'echo',
      'echo-draft',
    ]);
    expect(matchNewChats([ECHO_AGENT], 'new chat with ec').map((match) => match.name)).toEqual([
      'echo',
    ]);
    expect(matchNewChats([ECHO_AGENT], 'zzz')).toEqual([]);
    expect(newChatLabel('echo')).toBe('New chat with echo');
  });

  test('Go to Reviews is a command, and the engine pages are their own group', () => {
    expect(matchPages('go to rev').map((page) => [page.view, page.group])).toEqual([
      ['reviews', 'command'],
    ]);
    expect(matchPages('audit').map((page) => [page.view, page.group, page.path])).toEqual([
      ['audit', 'engine', '/audit'],
    ]);
    expect(matchPages('zzz')).toEqual([]);
  });
});

describe('searchConsole for chats and agents', () => {
  test('finds the chat and the agent a few letters name, and the command to chat with it', async () => {
    const listed: unknown[] = [];
    const restore = installFetchImplementation(async (_input, init) => {
      const call = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        id?: unknown;
        method?: string;
        params?: unknown;
      };
      if (call.method === 'bureau.contexts.list') listed.push(call.params);
      const result =
        call.method === 'bureau.contexts.list'
          ? {
              contexts: [ECHO_CHAT, chat({ id: 'other', title: 'Refund order' })],
              nextOffset: null,
            }
          : { agents: [ECHO_AGENT, agent({ name: 'tool-runner' })] };
      return Response.json({ jsonrpc: '2.0', id: call.id, result });
    });
    try {
      const results = await searchConsole(fakeClient({ schedules: 0 }), 'ech', {
        scheduleReadGate: OPEN,
      });

      expect(results.chats.map((match) => match.title)).toEqual(['Hello echo, say this back']);
      expect(results.agents.map((match) => match.name)).toEqual(['echo']);
      expect(results.newChats.map((match) => match.name)).toEqual(['echo']);
      // Only the chats a person started are searched, so a goal's session is not a chat result.
      expect(listed).toEqual([expect.objectContaining({ origin: 'chat' })]);
    } finally {
      restore();
    }
  });
});
