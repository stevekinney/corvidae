/**
 * Test-only support for Home's component tests: a Bureau that answers as the sample world does
 * (`fixtures/sample-world-seed.ts`), so each test changes only what it is about. Everything the
 * cards read is here: the reviews waiting, the problems that need attention, the schedules, the
 * agents and their tools, the chats, the runs, and the host's providers.
 */
import { HttpClient } from '@lostgradient/weft';

import type { AttentionItem } from '../../lib/bureau-attention.ts';
import type { ChatContext } from '../../lib/bureau-client.ts';
import {
  contextFixture,
  humanWaitFixture,
  toolApprovalFixture,
} from '../../lib/bureau-fixtures.test-support.ts';
import type { BureauReview } from '../../lib/bureau-reviews.ts';
import type { BureauSchedule } from '../../lib/bureau-schedules.ts';
import { StubFault, urlOf } from '../../lib/bureau-stub.test-support.ts';
import {
  emptyBureauWorld,
  installBureauWorld,
  type BureauWorld,
  type BureauWorldStub,
} from '../../lib/bureau-world.test-support.ts';
import { installFetchImplementation } from '../../lib/live-source/fetch.test-support.ts';

/** The sample world's "now": Monday, Nov 2, 10:46 AM Central time. */
export const HOME_NOW = Date.parse('2026-11-02T10:46:00-06:00');

/** The release question, asked at 9:46 AM. */
export const RELEASE_QUESTION: BureauReview = humanWaitFixture({
  id: 'human-wait:release',
  runId: 'run-release',
  sessionId: 'chat-release',
  requestedAt: HOME_NOW - 60 * 60_000,
});

/** The refund of order 4471, asked at 10:42:20 AM. */
export const REFUND_APPROVAL: BureauReview = toolApprovalFixture({
  id: 'approval:refund',
  runId: 'run-refund',
  sessionId: 'chat-refund',
  requestedAt: HOME_NOW - (3 * 60_000 + 40_000),
  approval: {
    callId: 'call-refund',
    toolName: 'issue-refund',
    arguments: { orderId: '4471', cents: 4200, reason: 'It arrived damaged.' },
    action: {
      type: 'approval',
      message: 'Refund order 4471 for $42.00?',
      risk: 'high',
      operation: { kind: 'other' },
    },
  },
});

/** The three problems of the sample world, in the order the Bureau lists them. */
export const SAMPLE_ATTENTION: readonly AttentionItem[] = [
  { kind: 'no-provider', at: null, provider: null },
  {
    kind: 'alert',
    at: HOME_NOW - 100 * 60_000,
    metric: 'storage.size',
    currentValue: 1.6 * 1024 ** 3,
  },
  {
    kind: 'missed-runs',
    at: HOME_NOW - 5 * 3_600_000,
    scheduleId: 'schedule-daily',
    scheduleName: 'Daily summary',
    count: 4,
    since: Date.parse('2026-10-30T03:00:00-05:00'),
  },
];

/** The daily summary schedule: Assistant, every day at 9:00 UTC, which is 3:00 AM in Central time. */
export const DAILY_SUMMARY: BureauSchedule = {
  id: 'schedule-daily',
  owner: 'anonymous:local',
  agentName: 'assistant',
  inputPreview: 'Summarize the open reviews.',
  workflowType: 'agentRun',
  description: 'Daily summary',
  cronExpression: '0 9 * * *',
  intervalMs: null,
  status: 'active',
  overlap: 'skip',
  revision: 1,
  timeZone: 'UTC',
  nextFireAt: '2026-11-03T09:00:00.000Z',
  skipUntil: null,
  lastFireAt: '2026-10-29T09:00:00.000Z',
  missedFireCount: 4,
  skippedCount: null,
  createdAt: '2026-10-01T09:00:00.000Z',
  updatedAt: '2026-11-02T09:00:00.000Z',
};

/** The three chats of the sample world, newest first. */
export const SAMPLE_CHATS: readonly ChatContext[] = [
  contextFixture('chat-refund', {
    agentName: 'tool-runner',
    title: 'Please refund order 4471, it arrived damaged.',
    lastMessagePreview: 'I found order 4471 ($42.00). I need your approval to refund it.',
    updatedAt: '2026-11-02T10:42:20-06:00',
    activity: 'awaiting-input',
  }),
  contextFixture('chat-release', {
    agentName: 'request-human-input',
    title: 'Ship the release notes fix.',
    lastMessagePreview: 'Which environment should the release go to?',
    updatedAt: '2026-11-02T09:46:00-06:00',
    activity: 'awaiting-input',
  }),
  contextFixture('chat-hello', {
    agentName: 'assistant',
    title: 'Say hello',
    lastMessagePreview: 'Hello! How can I help?',
    updatedAt: '2026-11-01T16:12:00-06:00',
    activity: 'idle',
  }),
];

/** What the sample world's Bureau answers, to be changed by a test through `world`. */
export interface HomeWorld {
  readonly world: BureauWorld;
  attention: readonly AttentionItem[];
  schedules: readonly BureauSchedule[];
  chats: readonly ChatContext[];
  /** Whether any provider holds a key. */
  providerConnected: boolean;
  /** Whether the person made an agent of their own, one defined in a file. */
  fileAgent: boolean;
  /** The runs the engine counts as failed in the last 24 hours. */
  failedRuns: number;
  /** Whether the caller is refused the attention feed (it lacks `bureau.diagnostics:read`). */
  attentionRefused: boolean;
}

/** The sample world: two reviews waiting, three problems, three chats, no provider. */
export function sampleHomeWorld(overrides: Partial<HomeWorld> = {}): HomeWorld {
  return {
    world: emptyBureauWorld({ reviews: [REFUND_APPROVAL, RELEASE_QUESTION] }),
    attention: SAMPLE_ATTENTION,
    schedules: [DAILY_SUMMARY],
    chats: SAMPLE_CHATS,
    providerConnected: false,
    fileAgent: false,
    failedRuns: 0,
    attentionRefused: false,
    ...overrides,
  };
}

/** What Home's component tests drive: the world, the stub over `fetch`, and a client to give the page. */
export interface InstalledHome {
  readonly stub: BureauWorldStub;
  readonly client: HttpClient;
  restore(): void;
}

/** Installs the Bureau stub, with the operations and host routes Home reads, over `fetch`. */
export function installHome(home: HomeWorld): InstalledHome {
  const stub = installBureauWorld(home.world);
  stub.on('bureau.health.attention', () => {
    if (home.attentionRefused) throw new StubFault('Forbidden', 403, 'Forbidden');
    return { items: home.attention, count: home.attention.length, checks: [] };
  });
  stub.on('bureau.schedules.list', () => ({ schedules: home.schedules, nextOffset: null }));
  stub.on('bureau.contexts.list', () => ({ contexts: home.chats, nextOffset: null }));
  stub.on('bureau.agents.list', () => ({
    agents: [
      agent('assistant', 'assistant', null),
      agent('tool-runner', 'tool-runner', {}),
      agent('request-human-input', 'request-human-input', null),
      ...(home.fileAgent ? [agent('researcher', 'Researcher', {}, 'file')] : []),
    ],
  }));
  stub.on('bureau.agents.catalog', () => ({
    models: [],
    tools: [
      {
        name: 'issue-refund',
        description: 'Refund an order.',
        shortDescription: null,
        title: 'Issue refund',
        inputSchema: null,
        tier: 'dangerous',
        defaultApproval: 'ask',
        source: 'bureau',
        plugin: null,
        skill: null,
        users: ['tool-runner'],
      },
    ],
  }));
  const bureauFetch = globalThis.fetch;
  const restoreFetch = installFetchImplementation(async (input, init) => {
    const url = new URL(urlOf(input), 'http://localhost');
    if (url.pathname === '/host/providers') {
      return Response.json({
        configurationRevision: 'fixture',
        providers: home.providerConnected
          ? [{ name: 'anthropic', configured: true, hasKey: true }]
          : [],
        catalog: [],
        models: [],
      });
    }
    if (url.pathname.endsWith('/jsonrpc') && !url.pathname.startsWith('/bureau/')) {
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          total: home.failedRuns,
          groups: home.failedRuns === 0 ? [] : [{ key: 'failed', count: home.failedRuns }],
          truncated: false,
        },
      });
    }
    return bureauFetch(input, init);
  });
  return {
    stub,
    client: new HttpClient({ baseUrl: 'http://localhost/api' }),
    restore: () => {
      restoreFetch();
      stub.restore();
    },
  };
}

/** An agent as `bureau.agents.list` shows it; `media: null` is a scripted agent that needs no model. */
function agent(
  name: string,
  displayName: string,
  media: Record<string, unknown> | null,
  kind: 'code' | 'file' = 'code',
) {
  return {
    name,
    displayName,
    description: null,
    definitionRevision: 1,
    kind,
    a2a: false,
    media: media === null ? null : { modalities: {}, mimeFamilies: [], mediaLimits: [], ...media },
  };
}
