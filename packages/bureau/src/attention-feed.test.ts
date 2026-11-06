import {
  openWorkspacePrivacyBureau,
  workspacePrivacyCall,
  WORKSPACE_PRIVACY_ACTORS,
  type WorkspacePrivacyActor,
} from './http/workspace-privacy-fixtures.test-support.ts';
/**
 * COR-2009 — what needs attention (Health's Needs attention list and its Advanced checks): the kinds
 * the Bureau finds, the one order they are listed in, the checks counted from the same list, and the
 * `bureau.health.attention` operation over a real Bureau with a firing `storage.size` alert.
 */
import {
  StorageSizeReportedEvent,
  type AlertStateSnapshot,
  type ScheduleSummary,
  type WorkspaceIdentity,
} from '@lostgradient/weft';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';
import { workspaceConformanceLedger } from './http/workspace-conformance-ledger.test-support.ts';

import {
  readAttention,
  type AttentionSources,
  type BureauAttentionItem,
} from './attention-feed.ts';
import type { ListedHook } from './hooks/hook-types.ts';
import { BUREAU_HANDLER_OPERATIONS } from './http/create-bureau-handler.ts';
import { healthAttentionOperation } from './http/management/attention-operations.ts';
import {
  openBureau,
  type OpenedBureau,
  rpc,
} from './http/management/management-fixtures.test-support.ts';
import type { PluginListing } from './plugins/plugin-types.ts';

/** Mon Nov 2 2026 in Central time (CST, UTC−6), at hour:minute. */
function today(hour: number, minute: number): number {
  return Date.UTC(2026, 10, 2, hour + 6, minute);
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = today(10, 46);
const PROVIDER_REMOVED = today(10, 45);
const ALERT_FIRED = today(9, 5);
const SERVER_STARTED = today(9, 0);

/** The sample world's 3 a.m. Daily summary occurrences while Interborough was off. */
const DAILY_SUMMARY_MISSED = [
  Date.UTC(2026, 9, 30, 8, 0),
  Date.UTC(2026, 9, 31, 8, 0),
  Date.UTC(2026, 10, 1, 8, 0),
  Date.UTC(2026, 10, 2, 9, 0),
];

function storageAlert(): AlertStateSnapshot {
  return {
    rule: { metric: 'storage.size', threshold: 1_500_000_000, action: 'log' },
    status: 'firing',
    currentValue: 1_600_000_000,
    lastFiredAt: ALERT_FIRED,
  };
}

function dailySummary(lastFireAt = Date.UTC(2026, 9, 29, 9, 0)): ScheduleSummary {
  return {
    id: 'daily-summary',
    workflowType: 'agentRun',
    description: 'Daily summary',
    status: 'active',
    overlap: 'skip',
    backfill: false,
    timeZone: 'America/Chicago',
    revisionPolicy: 'active-at-fire',
    revision: 1,
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 1),
    lastFireAt,
    missedFireCount: 4,
    skippedCount: 0,
    queuedRuns: [],
    nextFireAt: Date.UTC(2026, 10, 3, 9, 0),
  };
}

function webhook(
  overrides: Partial<ListedHook> & Pick<ListedHook, 'lastDelivery' | 'name'>,
): ListedHook {
  return {
    id: overrides.name ?? 'hook',
    owner: 'anonymous:local',
    action: { type: 'webhook', url: 'https://hooks.slack.com/services/T000/B000' },
    events: ['review.requested'],
    enabled: true,
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 1),
    revision: 1,
    ...overrides,
  };
}

/** A hook whose last delivery was answered 410 Gone at `at`, still retrying or given up. */
function failedHook(name: string, at: number, gaveUp: boolean): ListedHook {
  return webhook({
    name,
    lastDelivery: {
      id: `delivery-${name}`,
      kind: 'review.requested',
      test: false,
      status: gaveUp ? 'exhausted' : 'pending',
      lastAttempt: {
        number: gaveUp ? 8 : 3,
        startedAt: at - 200,
        finishedAt: at,
        outcome: 'response',
        status: 410,
      },
      createdAt: at - 60_000,
      updatedAt: at,
    },
  });
}

function plugin(name: string, status: PluginListing['status']): PluginListing {
  return {
    descriptor: {
      name,
      title: name,
      version: '1.0.0',
      description: name,
      required: false,
      enabledByDefault: true,
      secrets: [],
    },
    source: 'package',
    location: `@example/${name}`,
    status,
    problems:
      status === 'skipped'
        ? [{ code: 'setup-failed', message: 'Could not start.' } as never]
        : status === 'needs-setup'
          ? [{ code: 'secret-missing', key: `${name}-api-key` } as never]
          : [],
    contributions: [],
  };
}

const NO_PROVIDER: BureauAttentionItem = {
  kind: 'no-provider',
  area: 'providers',
  at: PROVIDER_REMOVED,
  provider: 'anthropic',
};

/** The sample world: no provider, the storage alert, and Daily summary's missed runs. */
function sampleWorld(overrides: Partial<AttentionSources> = {}): AttentionSources {
  return {
    now: () => NOW,
    activeAlerts: () => [storageAlert()],
    schedules: () => Promise.resolve([dailySummary()]),
    missed: () =>
      Promise.resolve(
        DAILY_SUMMARY_MISSED.toReversed().map((occurrence) => ({
          occurrence,
          count: 1,
          recordedAt: SERVER_STARTED,
        })),
      ),
    hooks: () => Promise.resolve([]),
    plugins: () =>
      Promise.resolve([
        plugin('guardrails', 'running'),
        plugin('anthropic', 'needs-setup'),
        plugin('demo', 'disabled'),
      ]),
    pluginsComposedAt: SERVER_STARTED,
    contributed: () => [NO_PROVIDER],
    ...overrides,
  };
}

describe('what needs attention', () => {
  it('lists the sample world’s three problems, most recent first, and counts them', async () => {
    const attention = await readAttention(sampleWorld());

    expect(attention.items.map((item) => [item.kind, item.at])).toEqual([
      ['no-provider', PROVIDER_REMOVED],
      ['alert', ALERT_FIRED],
      ['missed-runs', SERVER_STARTED],
    ]);
    expect(attention.count).toBe(3);
    expect(attention.items[1]).toEqual({
      kind: 'alert',
      area: 'storage',
      at: ALERT_FIRED,
      metric: 'storage.size',
      currentValue: 1_600_000_000,
      threshold: 1_500_000_000,
    });
    expect(attention.items[2]).toEqual({
      kind: 'missed-runs',
      area: 'schedules',
      at: SERVER_STARTED,
      scheduleId: 'daily-summary',
      scheduleName: 'Daily summary',
      count: 4,
      since: DAILY_SUMMARY_MISSED[0]!,
      occurrences: DAILY_SUMMARY_MISSED.map((occurrence) => ({ occurrence, count: 1 })),
    });
  });

  it('counts the checks from the same list, so Advanced reports what the list does', async () => {
    const attention = await readAttention(sampleWorld());

    expect(attention.checks).toEqual([
      { area: 'storage', count: 1 },
      { area: 'schedules', count: 1 },
      { area: 'providers', count: 1 },
    ]);
    const counted = attention.checks.reduce((total, check) => total + check.count, 0);
    expect(counted).toBe(attention.count);
  });

  it('puts a hook’s failed last delivery between the provider and the storage alert', async () => {
    const slack = failedHook('Notify Slack when a review is waiting', today(10, 42), false);
    const attention = await readAttention(sampleWorld({ hooks: () => Promise.resolve([slack]) }));

    expect(attention.items.map((item) => item.kind)).toEqual([
      'no-provider',
      'hook-failed',
      'alert',
      'missed-runs',
    ]);
    expect(attention.items[1]).toEqual({
      kind: 'hook-failed',
      area: 'hooks',
      at: today(10, 42),
      hookId: 'Notify Slack when a review is waiting',
      hookName: 'Notify Slack when a review is waiting',
      gaveUp: false,
      status: 410,
      host: 'hooks.slack.com',
      attempts: 3,
      error: null,
    });
  });

  it('puts a hook that gave up on Oct 30 last, after today’s problems', async () => {
    const onCall = failedHook('Page on-call when a run fails', Date.UTC(2026, 9, 30, 16, 3), true);
    const attention = await readAttention(sampleWorld({ hooks: () => Promise.resolve([onCall]) }));

    expect(attention.items.map((item) => item.kind)).toEqual([
      'no-provider',
      'alert',
      'missed-runs',
      'hook-failed',
    ]);
    expect(attention.items[3]).toMatchObject({ gaveUp: true, attempts: 8, status: 410 });
    expect(attention.checks.find((check) => check.area === 'hooks')).toEqual({
      area: 'hooks',
      count: 1,
    });
  });

  it('leaves out a hook that delivered, a disabled one, and one that never delivered', async () => {
    const delivered = webhook({
      name: 'Refund audit',
      lastDelivery: {
        id: 'delivered',
        kind: 'run.completed',
        test: false,
        status: 'delivered',
        lastAttempt: {
          number: 1,
          startedAt: NOW - 10,
          finishedAt: NOW,
          outcome: 'response',
          status: 200,
        },
        createdAt: NOW - 10,
        updatedAt: NOW,
      },
    });
    const disabled = { ...failedHook('Off', today(10, 0), true), enabled: false };
    const quiet = webhook({ name: 'Quiet', lastDelivery: null });

    const attention = await readAttention(
      sampleWorld({ hooks: () => Promise.resolve([delivered, disabled, quiet]) }),
    );

    expect(attention.items.some((item) => item.kind === 'hook-failed')).toBe(false);
  });

  it('counts a plugin that did not load, never one that only needs setup', async () => {
    const attention = await readAttention(
      sampleWorld({
        plugins: () =>
          Promise.resolve([plugin('inspectors', 'skipped'), plugin('openai', 'needs-setup')]),
        // The host reports the same plugin; it is listed once.
        contributed: () => [
          NO_PROVIDER,
          {
            kind: 'plugin-not-loaded',
            area: 'plugins',
            at: SERVER_STARTED,
            plugin: 'inspectors',
            problems: [],
          },
        ],
      }),
    );

    const plugins = attention.items.filter((item) => item.kind === 'plugin-not-loaded');
    expect(plugins).toEqual([
      {
        kind: 'plugin-not-loaded',
        area: 'plugins',
        at: SERVER_STARTED,
        plugin: 'inspectors',
        problems: ['setup-failed'],
      },
    ]);
    expect(attention.count).toBe(4);
  });

  it('drops missed runs once the schedule has run since, or once they are a week old', async () => {
    const ranSince = await readAttention(
      sampleWorld({ schedules: () => Promise.resolve([dailySummary(today(10, 0))]) }),
    );
    expect(ranSince.items.some((item) => item.kind === 'missed-runs')).toBe(false);

    const weekLater = await readAttention(sampleWorld({ now: () => NOW + 8 * DAY }));
    expect(weekLater.items.some((item) => item.kind === 'missed-runs')).toBe(false);
  });

  it('lists nothing when all is well, and never a review waiting on a person', async () => {
    const attention = await readAttention({
      now: () => NOW,
      activeAlerts: () => [{ ...storageAlert(), status: 'idle' }],
      schedules: () => Promise.resolve([]),
      missed: () => Promise.resolve(null),
      hooks: () => Promise.resolve([]),
      plugins: () => Promise.resolve([plugin('guardrails', 'running')]),
    });

    expect(attention).toEqual({ items: [], count: 0, checks: [] });
  });

  it('lists a provider that was never connected first, as it has no time', async () => {
    const attention = await readAttention(
      sampleWorld({
        contributed: () => [{ kind: 'no-provider', area: 'providers', at: null, provider: null }],
      }),
    );

    expect(attention.items[0]).toEqual({
      kind: 'no-provider',
      area: 'providers',
      at: null,
      provider: null,
    });
  });
});

describe('bureau.health.attention', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
  });

  async function open(options: Parameters<typeof openBureau>[0] = {}): Promise<OpenedBureau> {
    const opened = await openBureau(options);
    cleanups.push(() => opened.dispose());
    return opened;
  }

  it('is served, and describes the scope it needs', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(healthAttentionOperation);
    expect(healthAttentionOperation.description).toContain('bureau.diagnostics:read');
  });

  it('reports a firing storage.size alert of BureauOptions.alerts, and what the host adds', async () => {
    // The engine runs on the real clock, so the host's item is a day before the alert fires.
    const removedYesterday: BureauAttentionItem = { ...NO_PROVIDER, at: Date.now() - DAY };
    const opened = await open({
      bureauOptions: {
        alerts: { rules: [{ metric: 'storage.size', threshold: 1_000, action: 'log' }] },
        attention: () => [removedYesterday],
      },
    });
    const engine = opened.bureau.durableEngine();
    if (engine === undefined) throw new Error('The Bureau composed no durable engine.');

    // The engine reports its storage size on an interval; a reading is dispatched directly here.
    engine.dispatchEvent(new StorageSizeReportedEvent(1_600));
    await waitUntil(() => engine.getActiveAlerts().length === 1);

    const answered = await rpc(
      opened.handler,
      'bureau.health.attention',
      {},
      'diagnostics-reader-key',
    );

    expect(answered.error).toBeUndefined();
    const result = answered.result as {
      items: BureauAttentionItem[];
      count: number;
      checks: unknown[];
    };
    expect(result.items).toEqual([
      {
        kind: 'alert',
        area: 'storage',
        at: engine.getActiveAlerts()[0]!.lastFiredAt!,
        metric: 'storage.size',
        currentValue: 1_600,
        threshold: 1_000,
      },
      removedYesterday,
    ]);
    expect(result.count).toBe(2);
    expect(result.checks).toEqual([
      { area: 'storage', count: 1 },
      { area: 'providers', count: 1 },
    ]);
  });

  it('refuses a caller without bureau.diagnostics:read', async () => {
    const opened = await open();

    const answered = await rpc(opened.handler, 'bureau.health.attention', {}, 'hooks-reader-key');

    expect(answered.error?.data).toMatchObject({ httpStatus: 403 });
  });

  it('workspace members receive only public configuration notices, not private alert, hook, or schedule data', async () => {
    const opened = await open({
      bureauOptions: {
        attention: async () => {
          const report = await readAttention(
            sampleWorld({
              plugins: () => Promise.resolve([plugin('inspectors', 'skipped')]),
              hooks: () => Promise.resolve([failedHook('private-hook', ALERT_FIRED, false)]),
            }),
          );
          return report.items;
        },
      },
      handlerOptions: {
        workspace: {
          workspaceId: 'workspace-a',
          resolveMembership: async ({ subject }) =>
            ({
              version: 1,
              workspaceId: 'workspace-a',
              actorId: subject ?? 'unknown',
              actorKind: 'user',
              owner: `api-key:${subject ?? 'unknown'}`,
              membershipRevision: 'revision-1',
              capabilities: ['workspace:use', 'workspace:manage'],
            }) satisfies WorkspaceIdentity,
        },
      },
    });

    const answered = await rpc(
      opened.handler,
      'bureau.health.attention',
      {},
      'diagnostics-reader-key',
    );

    expect(answered.error).toBeUndefined();
    expect(answered.result?.['items']).toEqual([
      NO_PROVIDER,
      {
        kind: 'plugin-not-loaded',
        area: 'plugins',
        at: SERVER_STARTED,
        plugin: 'inspectors',
        problems: ['setup-failed'],
      },
    ]);
    expect(answered.result?.['count']).toBe(2);
    expect(answered.result?.['checks']).toEqual([
      { area: 'providers', count: 1 },
      { area: 'plugins', count: 1 },
    ]);
    expect(JSON.stringify(answered)).not.toContain('storage.size');
    expect(JSON.stringify(answered)).not.toContain('daily-summary');
    expect(JSON.stringify(answered)).not.toContain('hooks.slack.com');
  });
});

const witnesses = workspaceConformanceLedger('../attention-feed.test.ts');
it('workspace attention six-actor projections hide private hook alerts and recompute counts', async () => {
  const opened = await openWorkspacePrivacyBureau({
    bureauOptions: {
      attention: async () => {
        const report = await readAttention(
          sampleWorld({
            plugins: () => Promise.resolve([plugin('inspectors', 'skipped')]),
            hooks: () =>
              Promise.resolve([failedHook('PRIVATE-HOOK-ATTENTION-b5fe', ALERT_FIRED, false)]),
          }),
        );
        return report.items;
      },
    },
  });
  try {
    const sentinel = 'PRIVATE-ATTENTION-NEIGHBOR-4e7a';
    const task = await opened.bureau.tasks.start('default', sentinel, {
      principal: WORKSPACE_PRIVACY_ACTORS.owner.owner,
    });
    const owner = await workspacePrivacyCall(opened, 'owner', 'bureau.contexts.get', {
      contextId: task.contextId,
    });
    expect(owner.text).toContain(sentinel);
    witnesses.confirmPrivateSource('bureau.health.attention', owner);
    for (const actor of Object.keys(WORKSPACE_PRIVACY_ACTORS) as WorkspacePrivacyActor[]) {
      const response = await workspacePrivacyCall(opened, actor, 'bureau.health.attention', {});
      expect(response.text).not.toContain(sentinel);
      witnesses.observeWire('bureau.health.attention', actor, response);
      if (actor === 'foreign' || actor === 'removed') expect(response.status).toBe(403);
      else if (actor === 'administrator') {
        expect(response.body?.error).toBeUndefined();
        const items = response.body?.result?.['items'] as unknown[];
        expect(items).toHaveLength(2);
        expect(response.body?.result?.['count']).toBe(2);
        expect(response.body?.result?.['checks']).toEqual([
          { area: 'providers', count: 1 },
          { area: 'plugins', count: 1 },
        ]);
        expect(response.text).toContain('plugin-not-loaded');
        expect(response.text).not.toContain('PRIVATE-HOOK-ATTENTION-b5fe');
      } else expect(response.body?.error?.data?.httpStatus).toBe(403);
    }
  } finally {
    await opened.dispose();
  }
});

it('trusted local deployment operators retain full attention while local members remain redacted', async () => {
  const report = await readAttention(sampleWorld());
  for (const deploymentOperator of [false, true]) {
    const opened = await openBureau({
      localAccess: true,
      bureauOptions: { attention: async () => report.items },
      handlerOptions: {
        workspace: {
          workspaceId: 'workspace-a',
          resolveMembership: async () => ({
            version: 1,
            workspaceId: 'workspace-a',
            actorId: 'local-owner',
            actorKind: 'local',
            owner: 'anonymous:local',
            membershipRevision: '1',
            capabilities: deploymentOperator
              ? ['workspace:use', 'workspace:manage', 'deployment:operate']
              : ['workspace:use', 'workspace:manage'],
          }),
        },
      },
    });
    try {
      const response = await opened.handler(
        new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'bureau.health.attention',
            params: {},
          }),
        }),
      );
      const body = (await response.json()) as { result: typeof report };
      if (deploymentOperator) expect(body.result).toEqual(report);
      else {
        expect(body.result.items).toEqual([NO_PROVIDER]);
        expect(body.result.count).toBe(1);
      }
    } finally {
      await opened.dispose();
    }
  }
});

it('the workspace operation inventory has six executed actor witnesses', () => {
  witnesses.verify();
});
