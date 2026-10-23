/** The words and badges a catalog row carries: what is badged, and what is left out. */
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy.ts';
import { joinCatalog } from '../../lib/workflow-catalog.ts';
import {
  codeDefinition,
  invalidFile,
  readyFile,
  sourceDefinition,
} from '../../lib/workflow-world.test-support.ts';
import {
  definitionDetails,
  hasDefinitionDetails,
  rowBadges,
  runCountsText,
  scheduleLabel,
  schedulesSummary,
  specCadence,
  stepLabel,
  triggerLabel,
  triggerSummary,
} from './workflow-presentation.ts';

function listingOf(file: ReturnType<typeof readyFile>) {
  const { text: _text, schedule: _schedule, ...rest } = file;
  return rest;
}

describe('the badges of a row', () => {
  test('are the code badge for a code-defined type', () => {
    const [row] = joinCatalog([codeDefinition('order-processing')], []);
    expect(row === undefined ? undefined : rowBadges(row).map((badge) => badge.label)).toEqual([
      WORKFLOW_COPY.codeBadge,
    ]);
  });

  test('are agent-authored alone for a file, because its agent is set in monospace beside them', () => {
    const [row] = joinCatalog([sourceDefinition('digest')], [listingOf(readyFile('digest'))]);
    expect(row === undefined ? undefined : rowBadges(row).map((badge) => badge.label)).toEqual([
      WORKFLOW_COPY.agentAuthoredBadge,
    ]);
    expect(row?.agent).toBe('writer');
  });

  test('add the invalid badge for a file the Bureau cannot use', () => {
    const [row] = joinCatalog([], [listingOf(invalidFile('broken'))]);
    expect(row === undefined ? undefined : rowBadges(row).map((badge) => badge.label)).toEqual([
      WORKFLOW_COPY.agentAuthoredBadge,
      WORKFLOW_COPY.invalidBadge,
    ]);
  });

  test('add the paused badge for a paused file, and the failure for a source that failed', () => {
    const [row] = joinCatalog(
      [
        sourceDefinition('digest', {
          state: 'failed',
          lastFailureCategory: 'resource',
          contract: null,
        }),
      ],
      [listingOf(readyFile('digest', { paused: true }))],
    );
    const labels = row === undefined ? [] : rowBadges(row).map((badge) => badge.label);
    expect(labels).toContain(WORKFLOW_COPY.pausedBadge);
    expect(labels).toContain(WORKFLOW_COPY.sourceFailed('resource'));
  });
});

describe('a step, a trigger, and a schedule in words', () => {
  test('names an agent step by its agent and message', () => {
    expect(
      stepLabel({ kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Hi' } }),
    ).toBe(WORKFLOW_COPY.steps.agent('writer', 'Hi'));
  });

  test('names a sleep, a wait for a signal, and any other activity', () => {
    expect(stepLabel({ kind: 'sleep', duration: '5m' })).toBe(WORKFLOW_COPY.steps.sleep('5m'));
    expect(stepLabel({ kind: 'sleep', duration: 30 })).toBe(WORKFLOW_COPY.steps.sleep('30'));
    expect(stepLabel({ kind: 'await-signal', signal: 'approve' })).toBe(
      WORKFLOW_COPY.steps.awaitSignal('approve'),
    );
    expect(stepLabel({ kind: 'activity', handler: 'other' })).toBe(
      WORKFLOW_COPY.steps.activity('other'),
    );
    expect(stepLabel({ kind: 'mystery' })).toBe(WORKFLOW_COPY.steps.unknown('mystery'));
  });

  test('names a schedule trigger by its spec and overlap, and a signal trigger by its name', () => {
    expect(triggerLabel({ kind: 'schedule', spec: '1h', overlap: 'queue' })).toBe(
      WORKFLOW_COPY.triggers.schedule('1h', 'queue'),
    );
    expect(triggerLabel({ kind: 'schedule', spec: '1h' })).toBe(
      WORKFLOW_COPY.triggers.schedule('1h', null),
    );
    expect(triggerLabel({ kind: 'signal', name: 'begin' })).toBe(
      WORKFLOW_COPY.triggers.signal('begin'),
    );
    expect(triggerLabel({ kind: 'other' })).toBe(WORKFLOW_COPY.triggers.unknown('other'));
  });

  test('names a schedule by its cadence, and an interval by its length', () => {
    expect(scheduleLabel({ cronExpression: '*/5 * * * *' })).toContain('5');
    expect(scheduleLabel({ intervalMs: 3_600_000 })).toBeTruthy();
  });
});

describe('a schedule trigger’s spec in words', () => {
  test('reads a duration as an interval, in the units the Bureau accepts', () => {
    expect(specCadence('24h')).toEqual({ intervalMs: 86_400_000 });
    expect(specCadence('1h')).toEqual({ intervalMs: 3_600_000 });
    expect(specCadence('30 seconds')).toEqual({ intervalMs: 30_000 });
    expect(specCadence('5m')).toEqual({ intervalMs: 300_000 });
    expect(specCadence('1.5h')).toEqual({ intervalMs: 5_400_000 });
    expect(specCadence('250ms')).toEqual({ intervalMs: 250 });
    expect(specCadence('2 days')).toEqual({ intervalMs: 172_800_000 });
  });

  test('reads anything else as a cron expression', () => {
    expect(specCadence(' 0 6 * * * ')).toEqual({ cronExpression: '0 6 * * *' });
    expect(specCadence('@daily')).toEqual({ cronExpression: '@daily' });
  });

  test('says the same words the schedules area says', () => {
    expect(triggerSummary({ kind: 'schedule', spec: '1h' })).toEqual({
      kind: 'schedule',
      words: 'Every hour',
    });
    expect(triggerSummary({ kind: 'schedule', spec: '24h' })).toEqual({
      kind: 'schedule',
      words: 'Every day',
    });
    expect(triggerSummary({ kind: 'schedule', spec: '0 6 * * *' })).toEqual({
      kind: 'schedule',
      words: 'Every day at 06:00',
    });
  });

  test('names a signal trigger by its signal, and says nothing for a trigger it cannot read', () => {
    expect(triggerSummary({ kind: 'signal', name: 'deploy' })).toEqual({
      kind: 'signal',
      name: 'deploy',
    });
    expect(triggerSummary({ kind: 'other' })).toBeNull();
    expect(triggerSummary({ kind: 'schedule' })).toBeNull();
    expect(triggerSummary(null)).toBeNull();
  });

  test('says the schedules of a code-defined type: none, one in words, or several by count', () => {
    expect(schedulesSummary(null)).toBeNull();
    expect(schedulesSummary([])).toBeNull();
    expect(schedulesSummary([{ intervalMs: 3_600_000 }])).toEqual({
      kind: 'schedule',
      words: 'Every hour',
    });
    expect(schedulesSummary([{ intervalMs: 3_600_000 }, { cronExpression: '0 6 * * *' }])).toEqual({
      kind: 'schedule',
      words: WORKFLOW_COPY.list.schedules(2),
    });
  });
});

describe('the counts of a row', () => {
  const NOW = Date.parse('2026-10-23T12:00:00.000Z');

  test('say how many ran in the day, how many are running, and when the last began', () => {
    expect(
      runCountsText({ active: 1, last24Hours: 12, lastRunAt: '2026-10-23T11:57:00.000Z' }, NOW),
    ).toEqual({
      runs: '12 runs in 24 hours (1 running)',
      lastRun: 'last run 3m ago',
    });
    expect(
      runCountsText({ active: 0, last24Hours: 1, lastRunAt: '2026-10-23T11:00:00.000Z' }, NOW),
    ).toEqual({ runs: '1 run in 24 hours', lastRun: 'last run 1h ago' });
  });

  test('say a workflow that has never run has not, and one that ran before the day, that it ran none lately', () => {
    expect(runCountsText({ active: 0, last24Hours: 0, lastRunAt: null }, NOW)).toEqual({
      runs: WORKFLOW_COPY.list.neverRun,
      lastRun: null,
    });
    expect(
      runCountsText({ active: 0, last24Hours: 0, lastRunAt: '2026-10-20T12:00:00.000Z' }, NOW),
    ).toEqual({ runs: '0 runs in 24 hours', lastRun: 'last run 3d ago' });
  });
});

describe('the details of a type', () => {
  test('keep only what the contract declares, so nothing is padded with “None”', () => {
    const bare = definitionDetails(
      codeDefinition('bare', {
        signals: null,
        updates: null,
        queries: null,
        contract: null,
      }),
      [],
    );
    expect(bare).toEqual({
      signals: [],
      updates: [],
      queries: [],
      inputSchema: undefined,
      outputSchema: undefined,
    });
    expect(hasDefinitionDetails(bare)).toBe(false);
  });

  test('keep the signals, updates, queries, and each schema it declares', () => {
    const full = definitionDetails(codeDefinition('full', { updates: ['bump'] }), ['approve']);
    expect(full.signals).toEqual(['approve']);
    expect(full.updates).toEqual(['bump']);
    expect(full.queries).toEqual(['progress']);
    expect(full.inputSchema).toContain('orderId');
    expect(full.outputSchema).toContain('shipped');
    expect(hasDefinitionDetails(full)).toBe(true);
    expect(
      hasDefinitionDetails(
        definitionDetails(
          codeDefinition('only-signals', {
            signals: null,
            updates: null,
            queries: null,
            contract: null,
          }),
          ['approve'],
        ),
      ),
    ).toBe(true);
  });
});
