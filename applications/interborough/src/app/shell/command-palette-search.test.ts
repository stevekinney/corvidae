/**
 * The command palette's search. It lists the five kinds the board draws for "refund" (design row
 * 03g) and the identifier-led kinds beside them; it never reads schedules or workflow types, so a
 * sample world's "order-refund" workflow and "Weekly refund audit" schedule do not appear.
 */
import { rejectionOf } from '@lostgradient/testing';
import type { HttpClient } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import type { AgentSummary, ChatContext } from '../../lib/bureau-client.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';
import type { NotificationItem } from '../notifications.svelte.ts';
import {
  matchActions,
  matchAgents,
  matchChats,
  matchNewChats,
  matchRuns,
  matchTools,
  matchWaiting,
  memoizeRead,
  newChatAboutPath,
  newChatLabel,
  newChatTopic,
  NO_RESULTS as NOTHING,
  parseQuery,
  runMeta,
  runTitle,
  searchConsole,
  toolPath,
  waitingLabel,
  waitingMeta,
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

const LOCKED = { disabled: true, title: 'Requires the scope' } as const;

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
  test('searches workflow runs by identifier, workers and reviews, and never reads schedules', async () => {
    const calls = { schedules: 0 };

    const results = await searchConsole(fakeClient(calls), 'nightly', {});

    expect(results.workflows.map((workflow) => workflow.id)).toEqual(['nightly-order']);
    expect(results.workers.map((worker) => worker.id)).toEqual(['nightly-worker']);
    expect(results.reviews.map((review) => review.reviewId)).toEqual(['nightly-review']);
    // A schedule whose identifier matches is not listed, and the schedules are not even read.
    expect(calls.schedules).toBe(0);
    expect(results).not.toHaveProperty('schedules');
    expect(results).not.toHaveProperty('definitions');
  });

  test('returns nothing for an empty query, and does not call the client', async () => {
    const calls = { schedules: 0 };

    const results = await searchConsole(fakeClient(calls), '', {});

    expect(results).toEqual(NOTHING);
    expect(calls.schedules).toBe(0);
  });

  test('does not search workflows by id prefix for a query that is not an id prefix', async () => {
    const results = await searchConsole(fakeClient({ schedules: 0 }), 'nightly rollup', {});

    expect(results.workflows).toEqual([]);
  });

  test('treats a domain whose search fails (for example a 403) as no rows, and names it as failed', async () => {
    const refuse = async (): Promise<never> => {
      throw new Error('403 Forbidden');
    };
    const failing = {
      list: refuse,
      listSchedules: refuse,
      listReviews: refuse,
      operations: { 'weft.workers.list': refuse },
    } as unknown as HttpClient;

    const results = await searchConsole(failing, 'nightly', {
      readTools: refuse,
    });

    expect(results).toEqual({ ...NOTHING, failed: expect.any(Array) });
    expect(results.failed).toEqual(expect.arrayContaining(['Workers', 'Reviews', 'Runs', 'Tools']));
  });

  test('a domain that was read, even with no match, is not named as failed', async () => {
    const results = await searchConsole(fakeClient({ schedules: 0 }), 'nightly rollup', {
      readTools: async () => [],
    });

    expect(results.failed).not.toContain('Tools');
    expect(results.failed).not.toContain('Workers');
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

  test('an agent matches on its name or display name, and never on a description its row does not show', () => {
    const named = agent({ name: 'tool-runner', displayName: 'Tool runner' });
    expect(matchAgents([named, ECHO_AGENT], 'ech').map((match) => match.name)).toEqual(['echo']);
    expect(matchAgents([named, ECHO_AGENT], 'runner').map((match) => match.name)).toEqual([
      'tool-runner',
    ]);
    // ECHO_AGENT's description reads "Repeats the last message it was sent."
    expect(matchAgents([named, ECHO_AGENT], 'last message')).toEqual([]);
    const refunds = agent({
      name: 'tool-runner',
      displayName: 'Tool runner',
      description: 'Helps with orders and refunds.',
    });
    expect(matchAgents([refunds], 'refund')).toEqual([]);
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
      const results = await searchConsole(fakeClient({ schedules: 0 }), 'ech', {});

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
    title: null,
    skill: null,
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
    detail: 'Refund order 1234',
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

describe('the tool matches', () => {
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
  test('lists only what needs a decision or an answer, the newest first, and every one for an empty query', () => {
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
      waitingItem({
        id: 'alert:storage',
        kind: 'alert',
        tier: 'info',
        title: 'Storage passed its warning level',
      }),
      waitingItem({ id: 'task:failed', kind: 'failed', title: 'echo failed' }),
    ];
    expect(matchWaiting(items, '').map((item) => item.id)).toEqual(['review:new', 'review:old']);
    expect(matchWaiting(items, 'tool-runner').map((item) => item.id)).toEqual(['review:new']);
    expect(matchWaiting(items, 'refund order').map((item) => item.id)).toEqual([
      'review:new',
      'review:old',
    ]);
    expect(matchWaiting(items, 'zzz')).toEqual([]);
    expect(waitingLabel(items[0]!)).toBe('tool-runner needs your approval · Refund order 1234');
    expect(waitingLabel(waitingItem({ detail: '' }))).toBe('echo needs your approval');
  });

  test('a waiting item is found by the title of the chat it is about as well as by what it asks', () => {
    const items = [
      waitingItem({ id: 'review:a', title: 'Run issue-refund?', chat: 'Please refund order 4471' }),
    ];

    expect(matchWaiting(items, 'order 4471').map((item) => item.id)).toEqual(['review:a']);
    expect(matchWaiting(items, 'issue-refund').map((item) => item.id)).toEqual(['review:a']);
    expect(matchWaiting(items, 'nothing like it')).toEqual([]);
  });

  test('an action matches on its name, and an empty query lists them all up to the limit', () => {
    const run = () => {};
    const actions = Array.from({ length: 12 }, (_, index) => ({
      label: index === 3 ? 'Go to Reviews' : `Do thing ${String(index)}`,
      keys: ['G', 'R'],
      group: 'Go to',
      run,
    }));
    expect(matchActions(actions, 'reviews').map((action) => action.label)).toEqual([
      'Go to Reviews',
    ]);
    expect(matchActions(actions, '')).toHaveLength(8);
    expect(matchActions(actions, '', 20)).toHaveLength(12);
  });
});

describe('the order of the actions (row 03c)', () => {
  const run = () => {};
  const action = (label: string, group: string) => ({ label, keys: [], group, run });
  const registered = [
    action('Show keyboard shortcuts', 'General'),
    action('New chat', 'Chat'),
    action('Go to Home', 'Go to'),
    action('Do a thing', 'Elsewhere'),
    action('Go to Chat', 'Go to'),
  ];

  test('lists the Go to rows, then New chat, then the rest, with the shortcut map last', () => {
    expect(matchActions(registered, '').map((match) => match.label)).toEqual([
      'Go to Home',
      'Go to Chat',
      'New chat',
      'Do a thing',
      'Show keyboard shortcuts',
    ]);
  });

  test('reads the topic of a "New chat about" action from what was typed', () => {
    expect(newChatTopic('  refund ')).toBe('refund');
    expect(newChatTopic('   ')).toBeUndefined();
    expect(newChatAboutPath('refund & more')).toBe('/chats/new?about=refund%20%26%20more');
  });
});

describe('what a waiting row says after its sentence (rows 03c, 03g)', () => {
  test('an approval is "Approval · waiting" and a question is "Question"', () => {
    expect(waitingMeta(waitingItem({ kind: 'approval' }))).toBe('Approval · waiting');
    expect(waitingMeta(waitingItem({ kind: 'question' }))).toBe('Question');
  });
});

describe('runs (row 03g)', () => {
  const refundChat = chat({
    id: 'refund-chat',
    agentName: 'tool-runner',
    title: 'Please refund order 4471, it arrived damaged.',
  });
  const task = (overrides: Record<string, unknown>) =>
    ({
      id: 'run-1',
      contextId: 'refund-chat',
      agentName: 'tool-runner',
      owner: 'me',
      actor: null,
      kind: 'chat',
      status: 'input-required',
      finishReason: null,
      statusMessage: null,
      createdAt: '2026-11-02T16:42:00.000Z',
      updatedAt: '2026-11-02T16:42:00.000Z',
      cleanup: null,
      openWaits: [{ kind: 'tool-approval', reviewId: 'review-1', callId: 'call-1' }],
      ...overrides,
    }) as Parameters<typeof matchRuns>[0][number];
  const names = new Map([['tool-runner', 'Tool runner']]);

  test('a run is called after the first clause of the chat that began it', () => {
    expect(runTitle(refundChat, 'Tool runner')).toBe('Refund order 4471');
    expect(runTitle(chat({ title: 'Please refund order 4472, $18.50.' }), undefined)).toBe(
      'Refund order 4472',
    );
    expect(runTitle(chat({ title: 'Ship the release notes fix.' }), undefined)).toBe(
      'Ship the release notes fix',
    );
    expect(runTitle(chat({ title: 'Say hello' }), undefined)).toBe('Say hello');
    expect(runTitle(chat({ title: 'Check v1.2 today' }), undefined)).toBe('Check v1.2 today');
  });

  test('a run no chat began is called after its agent, and a run with neither is "Run"', () => {
    expect(runTitle(undefined, 'Tool runner')).toBe('Tool runner');
    expect(runTitle(chat({ title: null }), undefined)).toBe('Run');
  });

  test('finds a run by its title, its agent or its identifier, and says what it waits on', () => {
    const tasks = [
      task({}),
      task({ id: 'run-2', contextId: 'other', status: 'completed', openWaits: [] }),
    ];
    const [found] = matchRuns(tasks, [refundChat], names, 'refund order');
    expect(found).toEqual({
      id: 'run-1',
      title: 'Refund order 4471',
      agentName: 'tool-runner',
      status: 'input-required',
      waiting: 'approval',
    });
    expect(matchRuns(tasks, [refundChat], names, 'Tool runner').map((run) => run.id)).toEqual([
      'run-1',
      'run-2',
    ]);
    expect(matchRuns(tasks, [refundChat], names, 'run-2').map((run) => run.id)).toEqual(['run-2']);
    expect(matchRuns(tasks, [refundChat], names, 'zzz')).toEqual([]);
  });

  test('an identifier finds its run from its start, never from its middle (row 03g)', () => {
    const goalAttempt = task({
      id: 'goal-abc-sample-goal-summarize-open-refunds-a1',
      contextId: 'goal-attempt',
      kind: 'catalog',
      status: 'canceled',
      openWaits: [],
    });
    expect(matchRuns([goalAttempt], [], names, 'refund')).toEqual([]);
    expect(matchRuns([goalAttempt], [], names, 'goal-abc').map((run) => run.id)).toEqual([
      goalAttempt.id,
    ]);
  });

  test('only the newest run of a chat is called after the chat; an earlier one is called after its agent (row 03g)', () => {
    const tasks = [
      task({ id: 'run-new' }),
      task({ id: 'run-old', status: 'completed', openWaits: [] }),
    ];
    expect(matchRuns(tasks, [refundChat], names, 'refund').map((run) => run.id)).toEqual([
      'run-new',
    ]);
    expect(matchRuns(tasks, [refundChat], names, 'Tool runner')).toEqual([
      expect.objectContaining({ id: 'run-new', title: 'Refund order 4471' }),
      expect.objectContaining({ id: 'run-old', title: 'Tool runner' }),
    ]);
  });

  test('a run row says its agent, then how it stands, and never names its agent twice', () => {
    const run = {
      id: 'run-1',
      title: 'Refund order 4471',
      agentName: 'tool-runner',
      status: 'input-required' as const,
      waiting: 'approval' as const,
    };
    expect(runMeta(run, 'Tool runner')).toBe('Tool runner · waiting for approval');
    expect(runMeta({ ...run, waiting: 'answer' }, 'Tool runner')).toBe(
      'Tool runner · waiting for your answer',
    );
    expect(runMeta({ ...run, status: 'completed', waiting: null }, 'Tool runner')).toBe(
      'Tool runner · done',
    );
    expect(
      runMeta({ ...run, title: 'Tool runner', status: 'canceled', waiting: null }, 'Tool runner'),
    ).toBe('canceled');
    expect(runMeta({ ...run, agentName: null }, undefined)).toBe('waiting for approval');
  });

  test('a run that waits for an answer says so, and one that is over waits for nothing', () => {
    const answer = task({ openWaits: [{ kind: 'human-wait', reviewId: 'r', signalName: 's' }] });
    const done = task({ status: 'completed', openWaits: [] });
    expect(matchRuns([answer], [], names, '')[0]?.waiting).toBe('answer');
    expect(matchRuns([done], [], names, '')[0]?.waiting).toBeNull();
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

  test('finds tools beside the other kinds', async () => {
    const restore = noAgents();
    try {
      const results = await searchConsole(fakeClient({ schedules: 0 }), 'refund', {
        readTools: async () => [
          tool({}),
          tool({ name: 'send-email', description: 'Emails the customer' }),
        ],
      });

      expect(results.tools.map((match) => match.name)).toEqual(['issue-refund']);
    } finally {
      restore();
    }
  });

  test('reads no workflow run, review or worker without the scope that lets it', async () => {
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
      await searchConsole(client, 'nightly', {
        workflowReadGate: LOCKED,
        reviewReadGate: LOCKED,
        systemReadGate: LOCKED,
        readTools: async () => [],
      });

      expect(reads).toEqual([]);
    } finally {
      restore();
    }
  });

  test('> reads only the agents, for the chats each can be opened with, and @ lists the agents', async () => {
    const restore = noAgents();
    try {
      const actions = await searchConsole(fakeClient({ schedules: 0 }), '>new chat with ec', {});
      expect(actions.newChats.map((match) => match.name)).toEqual(['echo']);
      expect(actions.chats).toEqual([]);

      const everyone = await searchConsole(fakeClient({ schedules: 0 }), '@', {});
      expect(everyone.agents.map((match) => match.name)).toEqual(['echo', 'tool-runner']);
      expect(everyone.chats).toEqual([]);

      const one = await searchConsole(fakeClient({ schedules: 0 }), '@runner', {});
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
