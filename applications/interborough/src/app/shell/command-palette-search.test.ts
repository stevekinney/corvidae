/**
 * The command palette's search. It searches schedules only when the principal
 * holds `schedules:read`, which `weft.schedules.list` requires; without it the
 * read is skipped rather than sent and answered with a fault.
 */
import { rejectionOf } from '@lostgradient/testing';
import type { HttpClient } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import type { AgentSummary, ChatContext } from '../../lib/bureau-client.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import type { CatalogRow } from '../../lib/workflow-catalog.ts';
import type { NotificationItem } from '../notifications.svelte.ts';
import {
  matchActions,
  matchAgents,
  matchChats,
  matchDefinitions,
  matchNewChats,
  matchTools,
  matchWaiting,
  memoizeRead,
  newChatLabel,
  NO_RESULTS as NOTHING,
  parseQuery,
  searchConsole,
  toolPath,
  waitingLabel,
  type CatalogTool,
} from './command-palette-search.ts';

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

function row(overrides: Partial<CatalogRow>): CatalogRow {
  return {
    name: 'order',
    kind: 'code',
    agent: null,
    description: null,
    engine: false,
    runs: null,
    trigger: null,
    file: null,
    problem: null,
    failure: null,
    ...overrides,
  };
}

function tool(overrides: Partial<CatalogTool>): CatalogTool {
  return {
    name: 'issue-refund',
    description: 'Refunds an order to the card it was paid with.',
    shortDescription: null,
    inputSchema: null,
    tier: 'mutating',
    defaultApproval: 'ask',
    source: 'host',
    plugin: null,
    users: [],
    ...overrides,
  };
}

function waitingItem(overrides: Partial<NotificationItem>): NotificationItem {
  return {
    id: 'review:a',
    kind: 'approval',
    tier: 'warning',
    icon: 'shield-question-mark',
    title: 'echo needs your approval',
    identifiers: ['echo'],
    detail: 'Refund order 1234',
    joiner: ' in ',
    href: '/chats/refund',
    emittedAtMs: 2_000,
    read: false,
    ...overrides,
  };
}

describe('parseQuery', () => {
  test('reads > as actions and @ as agents, and the rest as everything', () => {
    expect(parseQuery('>go to')).toEqual({ mode: 'actions', text: 'go to' });
    expect(parseQuery('  > new chat ')).toEqual({ mode: 'actions', text: 'new chat' });
    expect(parseQuery('@ech')).toEqual({ mode: 'agents', text: 'ech' });
    expect(parseQuery('@')).toEqual({ mode: 'agents', text: '' });
    expect(parseQuery(' ech ')).toEqual({ mode: 'all', text: 'ech' });
    expect(parseQuery('a>b@c')).toEqual({ mode: 'all', text: 'a>b@c' });
  });
});

describe('the workflow and tool matches', () => {
  test('a workflow type matches on its name or description, and a type the Bureau runs itself is left out', () => {
    const rows = [
      row({ name: 'order-sync', description: 'Syncs orders nightly' }),
      row({ name: 'digest' }),
      row({ name: 'agentRun', engine: true }),
    ];
    expect(matchDefinitions(rows, 'order').map((match) => match.name)).toEqual(['order-sync']);
    expect(matchDefinitions(rows, 'nightly').map((match) => match.name)).toEqual(['order-sync']);
    expect(matchDefinitions(rows, 'agentrun')).toEqual([]);
  });

  test('a tool matches on its name, or on the line a person is shown for it', () => {
    const tools = [
      tool({}),
      tool({ name: 'send-email', shortDescription: 'Emails the customer', description: 'x' }),
    ];
    expect(matchTools(tools, 'refund').map((match) => match.name)).toEqual(['issue-refund']);
    expect(matchTools(tools, 'customer').map((match) => match.name)).toEqual(['send-email']);
    expect(toolPath('a b')).toBe('/capabilities?tool=a%20b');
  });
});

describe('what is waiting and the actions', () => {
  test('lists only what needs a decision or an answer, the oldest first, and every one for an empty query', () => {
    const items = [
      waitingItem({
        id: 'review:new',
        emittedAtMs: 3_000,
        title: 'tool-runner needs your approval',
      }),
      waitingItem({
        id: 'review:old',
        emittedAtMs: 1_000,
        kind: 'question',
        title: 'echo asked a question',
      }),
      waitingItem({ id: 'task:done', kind: 'answered', tier: 'info', title: 'echo answered' }),
      waitingItem({ id: 'task:failed', kind: 'failed', title: 'echo failed' }),
    ];
    expect(matchWaiting(items, '').map((item) => item.id)).toEqual(['review:old', 'review:new']);
    expect(matchWaiting(items, 'tool-runner').map((item) => item.id)).toEqual(['review:new']);
    expect(matchWaiting(items, 'refund order').map((item) => item.id)).toEqual([
      'review:old',
      'review:new',
    ]);
    expect(matchWaiting(items, 'zzz')).toEqual([]);
    expect(waitingLabel(items[0]!)).toBe('tool-runner needs your approval in Refund order 1234');
    expect(waitingLabel(waitingItem({ detail: '' }))).toBe('echo needs your approval');
  });

  test('an action matches on its name, and an empty query lists them all up to the limit', () => {
    const run = () => {};
    const actions = Array.from({ length: 12 }, (_, index) => ({
      label: index === 3 ? 'Go to Reviews' : `Do thing ${String(index)}`,
      keys: ['G', 'V'],
      run,
    }));
    expect(matchActions(actions, 'reviews').map((action) => action.label)).toEqual([
      'Go to Reviews',
    ]);
    expect(matchActions(actions, '')).toHaveLength(8);
    expect(matchActions(actions, '', 20)).toHaveLength(12);
  });
});

describe('searchConsole by kind and scope', () => {
  const noAgents = () =>
    installFetchImplementation(async (_input, init) => {
      const call = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
        id?: unknown;
        method?: string;
      };
      const result =
        call.method === 'bureau.contexts.list'
          ? { contexts: [ECHO_CHAT], nextOffset: null }
          : { agents: [ECHO_AGENT, agent({ name: 'tool-runner' })] };
      return Response.json({ jsonrpc: '2.0', id: call.id, result });
    });

  test('finds workflow types and tools beside the other kinds', async () => {
    const restore = noAgents();
    try {
      const results = await searchConsole(fakeClient({ schedules: 0 }), 'refund', {
        scheduleReadGate: OPEN,
        readWorkflows: async () => [row({ name: 'refund-flow' }), row({ name: 'digest' })],
        readTools: async () => [
          tool({}),
          tool({ name: 'send-email', description: 'Emails the customer' }),
        ],
      });

      expect(results.definitions.map((match) => match.name)).toEqual(['refund-flow']);
      expect(results.tools.map((match) => match.name)).toEqual(['issue-refund']);
    } finally {
      restore();
    }
  });

  test('reads no workflow, run, review or worker without the scope that lets it', async () => {
    const restore = noAgents();
    const reads: string[] = [];
    const client = {
      list: async () => {
        reads.push('runs');
        return { items: [], total: 0 };
      },
      listSchedules: async () => ({ items: [] }),
      listReviews: async () => {
        reads.push('reviews');
        return [];
      },
      operations: {
        'weft.workers.list': async () => {
          reads.push('workers');
          return { items: [] };
        },
      },
    } as unknown as HttpClient;
    try {
      const results = await searchConsole(client, 'nightly', {
        scheduleReadGate: OPEN,
        workflowReadGate: LOCKED,
        reviewReadGate: LOCKED,
        systemReadGate: LOCKED,
        readWorkflows: async () => {
          reads.push('workflows');
          return [];
        },
        readTools: async () => [],
      });

      expect(reads).toEqual([]);
      expect(results.definitions).toEqual([]);
    } finally {
      restore();
    }
  });

  test('> reads only the agents, for the chats each can be opened with, and @ lists the agents', async () => {
    const restore = noAgents();
    try {
      const actions = await searchConsole(fakeClient({ schedules: 0 }), '>new chat with ec', {
        scheduleReadGate: OPEN,
      });
      expect(actions.newChats.map((match) => match.name)).toEqual(['echo']);
      expect(actions.chats).toEqual([]);

      const everyone = await searchConsole(fakeClient({ schedules: 0 }), '@', {
        scheduleReadGate: OPEN,
      });
      expect(everyone.agents.map((match) => match.name)).toEqual(['echo', 'tool-runner']);
      expect(everyone.chats).toEqual([]);

      const one = await searchConsole(fakeClient({ schedules: 0 }), '@runner', {
        scheduleReadGate: OPEN,
      });
      expect(one.agents.map((match) => match.name)).toEqual(['tool-runner']);
    } finally {
      restore();
    }
  });
});

describe('memoizeRead', () => {
  test('answers a second read within the window from the first, and reads again after it', async () => {
    let reads = 0;
    const read = memoizeRead(async () => (reads += 1), 60_000);
    expect(await read()).toBe(1);
    expect(await read()).toBe(1);
    expect(reads).toBe(1);
    const stale = memoizeRead(async () => (reads += 1), -1);
    await stale();
    await stale();
    expect(reads).toBe(3);
  });

  test('does not keep a read that failed', async () => {
    let reads = 0;
    const read = memoizeRead(async () => {
      reads += 1;
      if (reads === 1) throw new Error('did not answer');
      return reads;
    }, 60_000);
    expect(await rejectionOf(read())).toBeInstanceOf(Error);
    expect(await read()).toBe(2);
  });
});
