/**
 * What Home's lists say (design rows 01g, 01h, 01i, 01l): the reviews waiting on you with kind first
 * on line two, the system problems as a sentence, a line and one button, and the chats last in. They
 * are read as plain data, in the sample world's zone, so the board's exact sentences are the
 * expectations.
 */
import { describe, expect, test } from 'bun:test';

import type { AttentionItem } from '../../lib/bureau-attention.ts';
import { contextFixture, taskFixture } from '../../lib/bureau-fixtures.test-support.ts';
import { chatStatusWord } from '../chat/session-groups.ts';
import {
  attentionRows,
  checklistSteps,
  missedRunCount,
  needsYouRows,
  recentChatRows,
  runningRows,
  viewerCadence,
} from './home-rows.ts';
import {
  DAILY_SUMMARY,
  HOME_NOW,
  REFUND_APPROVAL,
  RELEASE_QUESTION,
  SAMPLE_ATTENTION,
  SAMPLE_CHATS,
} from './home-test-support.test-support.ts';

const ZONE = 'America/Chicago';
const AGENTS = [
  { name: 'tool-runner', displayName: 'tool-runner' },
  { name: 'request-human-input', displayName: 'request-human-input' },
  { name: 'assistant', displayName: 'assistant' },
];
const TOOLS = [{ name: 'issue-refund', tier: 'dangerous' }];

describe('needsYouRows', () => {
  test('lists the reviews oldest first, each with its kind, who asked and the button that opens it', () => {
    const rows = needsYouRows([REFUND_APPROVAL, RELEASE_QUESTION], {
      agents: AGENTS,
      tools: TOOLS,
    });
    expect(rows.map((row) => row.title)).toEqual([
      'Which environment should the release go to?',
      'Refund order 4471 for $42.00?',
    ]);
    expect(rows[0]).toMatchObject({
      kind: 'Question',
      agent: 'Request human input',
      cantBeUndone: false,
      action: 'Answer',
      href: '/reviews?review=bureau%3Ahuman-wait%3Arelease',
    });
    expect(rows[1]).toMatchObject({
      kind: 'Approval',
      agent: 'Tool runner',
      cantBeUndone: true,
      action: 'Review',
    });
  });

  test('says an approval can’t be undone only for a tool the catalog calls dangerous', () => {
    const [row] = needsYouRows([REFUND_APPROVAL], {
      agents: AGENTS,
      tools: [{ name: 'issue-refund', tier: 'mutating' }],
    });
    expect(row?.cantBeUndone).toBe(false);
    const [unread] = needsYouRows([REFUND_APPROVAL], { agents: AGENTS, tools: undefined });
    expect(unread?.cantBeUndone).toBe(false);
  });

  test('leaves out a review that is not waiting, and says the agent by its identifier until the catalog is read', () => {
    const decided = { ...REFUND_APPROVAL, status: 'approved' as const };
    expect(needsYouRows([decided], { agents: AGENTS, tools: TOOLS })).toEqual([]);
    const [row] = needsYouRows([RELEASE_QUESTION], { agents: undefined, tools: undefined });
    expect(row?.agent).toBe('Request human input');
  });

  test('lists a workflow review as a review with no agent', () => {
    const [row] = needsYouRows(
      [
        {
          source: 'engine',
          kind: 'engine-review',
          id: 'review-1',
          runId: 'run-1',
          requestedAt: HOME_NOW - 60_000,
          ageMilliseconds: 60_000,
          status: 'pending',
          reviewType: 'Contract approval',
          reviewers: [],
          allowPartial: false,
        },
      ],
      { agents: AGENTS, tools: TOOLS },
    );
    expect(row).toMatchObject({
      title: 'Contract approval',
      kind: 'Workflow review',
      agent: undefined,
      action: 'Review',
      href: '/reviews?review=engine%3Areview-1',
    });
  });
});

describe('attentionRows', () => {
  const context = {
    schedules: [DAILY_SUMMARY],
    agents: AGENTS,
    now: HOME_NOW,
    zone: ZONE,
  };

  test('lists the sample world’s three problems as the board does, storage first and the provider last', () => {
    const rows = attentionRows(SAMPLE_ATTENTION, context);
    expect(rows.map((row) => [row.title, row.detail, row.action.label])).toEqual([
      ['Storage is over its warning level', '1.6 GB used', 'Review storage'],
      [
        'Daily summary missed 4 runs since Oct 30',
        'Schedule · Assistant · Every day at 3:00 AM (9:00 AM UTC)',
        'View schedule',
      ],
      [
        'No model provider connected',
        'Model agents can’t answer until one is connected. Assistant works now.',
        'Connect a provider',
      ],
    ]);
    expect(rows.map((row) => row.action.href)).toEqual([
      '/health/storage',
      '/schedules/schedule-daily',
      '/settings/models',
    ]);
  });

  test('states the storage reading and no capacity or threshold', () => {
    const [row] = attentionRows(
      [
        {
          kind: 'alert',
          area: 'storage',
          at: 1,
          metric: 'storage.size',
          currentValue: 1.6 * 1024 ** 3,
          threshold: 0,
        },
      ],
      context,
    );
    expect(`${row?.title} ${row?.detail}`).not.toMatch(/threshold|capacity|limit|of /i);
  });

  test('words the rules this host measures besides storage, and one it has no sentence for', () => {
    const rows = attentionRows(
      [
        {
          kind: 'alert',
          area: 'runs',
          at: 1,
          metric: 'workflow.failure_rate',
          currentValue: 0.123,
          threshold: 0,
        },
        {
          kind: 'alert',
          area: 'runs',
          at: 2,
          metric: 'activity.p99_duration',
          currentValue: 90_000,
          threshold: 0,
        },
        {
          kind: 'alert',
          area: 'runs',
          at: 3,
          metric: 'queue.depth',
          currentValue: 5,
          threshold: 0,
        },
      ],
      context,
    );
    expect(rows.map((row) => row.title)).toEqual([
      'Workflow failure rate is over its warning level',
      'Slowest steps are over their warning level',
      'queue.depth is over its warning level',
    ]);
    expect(rows[0]?.detail).toBe('12.3% of recent runs failed');
    expect(rows[1]?.detail).toBe('Slowest steps take 1m 30s');
    expect(rows[2]?.detail).toBeUndefined();
  });

  test('words a hook that failed or gave up, and a plugin that did not load', () => {
    const items: AttentionItem[] = [
      {
        kind: 'hook-failed',
        area: 'hooks',
        at: 1,
        hookId: 'hook-1',
        hookName: 'Notify Slack',
        gaveUp: false,
        status: 410,
        host: 'hooks.slack.com',
        attempts: 1,
        error: null,
      },
      {
        kind: 'hook-failed',
        area: 'hooks',
        at: 2,
        hookId: 'hook-2',
        hookName: null,
        gaveUp: true,
        status: null,
        host: null,
        attempts: 1,
        error: 'connection refused',
      },
      {
        kind: 'plugin-not-loaded',
        area: 'plugins',
        at: null,
        plugin: 'voyage',
        problems: ['secret-missing'],
      },
    ];
    const rows = attentionRows(items, context);
    expect(rows.map((row) => [row.title, row.detail, row.action.label])).toEqual([
      ['Notify Slack’s last delivery failed', '410 from hooks.slack.com', 'View hook'],
      ['A hook’s delivery gave up', 'connection refused', 'View hook'],
      ['voyage did not load', 'secret-missing', 'View plugins'],
    ]);
    expect(rows[0]?.action.href).toBe('/hooks/hook-1');
  });

  test('orders by kind and keeps the Bureau’s order within one', () => {
    const rows = attentionRows(
      [
        { kind: 'no-provider', area: 'providers', at: null, provider: null },
        { kind: 'plugin-not-loaded', area: 'plugins', at: null, plugin: 'a', problems: [] },
        {
          kind: 'alert',
          area: 'runs',
          at: 2,
          metric: 'queue.depth',
          currentValue: 1,
          threshold: 0,
        },
        {
          kind: 'alert',
          area: 'storage',
          at: 1,
          metric: 'storage.size',
          currentValue: 1,
          threshold: 0,
        },
      ],
      context,
    );
    expect(rows.map((row) => row.title)).toEqual([
      'queue.depth is over its warning level',
      'Storage is over its warning level',
      'a did not load',
      'No model provider connected',
    ]);
  });

  test('says a missed-runs row from the problem alone while the schedules are not read', () => {
    const [row] = attentionRows([SAMPLE_ATTENTION[2]!], { ...context, schedules: undefined });
    expect(row?.title).toBe('Daily summary missed 4 runs since Oct 30');
    expect(row?.detail).toBe('Schedule');
  });

  test('says a schedule with no description of its own as a schedule, and one run as a run', () => {
    const [row] = attentionRows(
      [
        {
          kind: 'missed-runs',
          area: 'schedules',
          at: 1,
          scheduleId: 'x',
          scheduleName: null,
          count: 1,
          since: Date.parse('2026-11-01T09:00:00-06:00'),
          occurrences: [],
        },
      ],
      { ...context, schedules: [] },
    );
    expect(row?.title).toBe('A schedule missed 1 run since Nov 1');
  });
});

describe('viewerCadence', () => {
  test('reads a fixed daily time in the viewer’s zone, and the schedule’s own zone where it differs', () => {
    expect(viewerCadence(DAILY_SUMMARY, ZONE)).toBe('Every day at 3:00 AM (9:00 AM UTC)');
    expect(viewerCadence(DAILY_SUMMARY, 'UTC')).toBe('Every day at 9:00 AM');
  });

  test('says any other cadence in the schedule’s own words', () => {
    expect(
      viewerCadence({ ...DAILY_SUMMARY, cronExpression: null, intervalMs: 3_600_000 }, ZONE),
    ).toBe('Every hour');
    expect(viewerCadence({ ...DAILY_SUMMARY, nextFireAt: null }, ZONE)).toBe('Every day at 09:00');
  });
});

describe('missedRunCount', () => {
  test('sums the runs every schedule missed in the last seven days', () => {
    expect(missedRunCount(SAMPLE_ATTENTION)).toBe(4);
    expect(
      missedRunCount([
        ...SAMPLE_ATTENTION,
        { ...SAMPLE_ATTENTION[2]!, scheduleId: 'other', count: 2 } as AttentionItem,
      ]),
    ).toBe(6);
    expect(missedRunCount([])).toBe(0);
  });
});

describe('recent chats', () => {
  const QUESTIONS = new Map([
    ['chat-refund', 'Refund order 4471 for $42.00?'],
    ['chat-release', 'Which environment should the release go to?'],
  ]);

  test('lists the newest three with a status word, what each says on line two, and the clock time', () => {
    const rows = recentChatRows(SAMPLE_CHATS, QUESTIONS, new Set(), HOME_NOW, ZONE);
    expect(rows.map((row) => [row.status, row.title, row.latest, row.time])).toEqual([
      [
        'Waiting on you',
        'Please refund order 4471, it arrived damaged.',
        // A chat that waits says the question it asks, not the words it last held.
        'Refund order 4471 for $42.00?',
        '10:42 AM',
      ],
      [
        'Waiting on you',
        'Ship the release notes fix.',
        'Which environment should the release go to?',
        '9:46 AM',
      ],
      ['Done', 'Say hello', 'Hello! How can I help?', 'Yesterday, 4:12 PM'],
    ]);
    const four = recentChatRows(
      [...SAMPLE_CHATS, contextFixture('chat-old')],
      QUESTIONS,
      new Set(),
      HOME_NOW,
      ZONE,
    );
    expect(four).toHaveLength(3);
  });

  test('says a chat that waits by its latest message when no question is read for it', () => {
    const [row] = recentChatRows(SAMPLE_CHATS, new Map(), new Set(), HOME_NOW, ZONE);
    expect(row?.latest).toBe('I found order 4471 ($42.00). I need your approval to refund it.');
  });

  test('says a chat with no title or message by its fallbacks, and one with no readable time with none', () => {
    const [row] = recentChatRows(
      [contextFixture('chat-1', { updatedAt: 'not a time', messageCount: 3 })],
      new Map(),
      new Set(),
      HOME_NOW,
      ZONE,
    );
    expect(row).toMatchObject({
      title: 'New chat',
      latest: '3 messages',
      time: '',
      timestamp: null,
    });
  });

  test('words a chat by its activity, its latest run and how it ended', () => {
    const word = (overrides: Parameters<typeof contextFixture>[1], failed = false) =>
      chatStatusWord(contextFixture('c', overrides), failed ? new Set(['c']) : new Set());
    expect(word({ activity: 'awaiting-input' })).toBe('Waiting on you');
    expect(word({ activity: 'running' })).toBe('Running');
    expect(word({ activity: 'idle' }, true)).toBe('Failed');
    expect(word({ activity: 'idle', endReason: 'host-stopped' })).toBe('Ended');
    expect(word({ activity: 'idle' })).toBe('Done');
  });
});

describe('runningRows', () => {
  const daily = taskFixture({
    id: 'run-daily',
    contextId: 'chat-daily',
    agentName: 'assistant',
    actor: 'system:scheduler',
    kind: 'schedule-fire',
    origin: { kind: 'schedule', scheduleId: 'schedule-daily' },
    createdAt: '2026-11-02T10:44:00-06:00',
    updatedAt: '2026-11-02T10:45:00-06:00',
  });
  const context = {
    chats: [],
    schedules: [DAILY_SUMMARY],
    agents: AGENTS,
    now: HOME_NOW,
    zone: ZONE,
  };

  test('titles a schedule’s run by the schedule and says what started it, who runs and when (01x)', () => {
    expect(runningRows([daily], context)).toEqual([
      {
        key: 'run-daily',
        title: 'Daily summary',
        line: 'Running · Schedule · Assistant · started 10:44 AM',
        href: '/runs/run-daily',
      },
    ]);
  });

  test('titles a chat’s run by the chat, and falls back to the agent, then to a plain word', () => {
    const chatRun = taskFixture({
      id: 'run-chat',
      contextId: 'chat-1',
      origin: { kind: 'chat', contextId: 'chat-1' },
    });
    const withChat = runningRows([chatRun], {
      ...context,
      chats: [contextFixture('chat-1', { title: 'Plan the launch' })],
    });
    expect(withChat[0]?.title).toBe('Plan the launch');
    expect(runningRows([chatRun], context)[0]?.title).toBe('Assistant');
    expect(runningRows([{ ...chatRun, agentName: null }], context)[0]?.title).toBe('A run');
  });

  test('waits for the schedules without losing the row: the title falls back until they arrive', () => {
    const rows = runningRows([daily], {
      ...context,
      schedules: undefined,
      chats: [contextFixture('chat-daily', { title: 'Summarize the open reviews.' })],
    });
    expect(rows[0]?.title).toBe('Summarize the open reviews.');
  });

  test('says a start before today by its day, and leaves out what it cannot name', () => {
    const yesterday = { ...daily, createdAt: '2026-11-01T16:12:00-06:00', agentName: null };
    expect(runningRows([yesterday], context)[0]?.line).toBe(
      'Running · Schedule · started Yesterday, 4:12 PM',
    );
  });
});

describe('checklistSteps', () => {
  const none = {
    providers: [],
    agents: [{ name: 'assistant', displayName: 'assistant', kind: 'code' as const }],
    assistantChosen: false,
  };

  test('says what each step asks while it is open', () => {
    expect(
      checklistSteps({ provider: false, agent: false, chat: false }, none).map((step) => [
        step.title,
        step.description,
        step.done,
      ]),
    ).toEqual([
      ['Connect a provider', 'Agents need a model provider before they can answer.', false],
      [
        'Create an agent, or start from Assistant',
        'Assistant works now; other agents need a provider.',
        false,
      ],
      ['Say hello', 'Send a first message to see a chat run end to end.', false],
    ]);
  });

  test('says what is true once a step is done, naming the providers and the agent', () => {
    const steps = checklistSteps(
      { provider: true, agent: true, chat: false },
      {
        providers: [
          { name: 'anthropic', hasKey: true },
          { name: 'openai', hasKey: true },
          { name: 'gemini', hasKey: false },
        ],
        agents: [
          { name: 'assistant', displayName: 'assistant', kind: 'code' },
          { name: 'researcher', displayName: 'Researcher', kind: 'file' },
        ],
        assistantChosen: false,
      },
    );
    expect(steps[0]?.description).toBe('Anthropic and OpenAI are connected.');
    expect(steps[1]?.description).toBe('Researcher is ready to use.');
  });

  test('names Assistant once it was chosen, even beside an agent of the person’s own', () => {
    const steps = checklistSteps(
      { provider: false, agent: true, chat: false },
      {
        providers: [],
        agents: [
          { name: 'assistant', displayName: 'assistant', kind: 'code' },
          { name: 'researcher', displayName: 'Researcher', kind: 'file' },
        ],
        assistantChosen: true,
      },
    );
    expect(steps[1]?.description).toBe('Assistant is ready to use.');
  });

  test('names no Assistant on a host that lists none, and says an agent is ready', () => {
    const noAssistant = {
      providers: [],
      agents: [{ name: 'tool-runner', displayName: 'tool-runner', kind: 'code' as const }],
      assistantChosen: false,
    };
    const open = checklistSteps({ provider: false, agent: false, chat: false }, noAssistant);
    expect([open[1]?.title, open[1]?.description]).toEqual([
      'Create an agent',
      'An agent is a model with instructions and tools.',
    ]);
    // Done by an agent of the person's own, it names that agent.
    const own = checklistSteps(
      { provider: false, agent: true, chat: false },
      {
        ...noAssistant,
        agents: [
          ...noAssistant.agents,
          { name: 'researcher', displayName: 'Researcher', kind: 'file' as const },
        ],
      },
    );
    expect(own[1]?.description).toBe('Researcher is ready to use.');
    // Done by a choice of Assistant that the host no longer lists, it names the first agent it does list.
    const chosen = checklistSteps(
      { provider: false, agent: true, chat: false },
      { ...noAssistant, assistantChosen: true },
    );
    expect(chosen[1]?.description).toBe('Tool runner is ready to use.');
    // With no agent listed at all it says only that one is ready.
    const unnamed = checklistSteps(
      { provider: false, agent: true, chat: false },
      { providers: [], agents: [], assistantChosen: true },
    );
    expect(unnamed[1]?.description).toBe('An agent is ready to use.');
  });

  test('says Anthropic is connected for a single provider', () => {
    expect(
      checklistSteps(
        { provider: true, agent: false, chat: false },
        { ...none, providers: [{ name: 'anthropic', hasKey: true }] },
      )[0]?.description,
    ).toBe('Anthropic is connected.');
  });
});
