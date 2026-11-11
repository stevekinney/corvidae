/**
 * What each problem on the attention list says on Health (rows 76g to 76k, 77a to 77m). The rows
 * keep the Bureau's order, one glyph per kind, a secondary action each, and never a capacity or a
 * threshold figure.
 */
import { describe, expect, test } from 'bun:test';

import type { AttentionItem } from '../../lib/bureau-attention.ts';
import { attentionRow, attentionRows, statusWords } from './attention-rows.ts';

const AT = Date.UTC(2026, 10, 2, 15, 5);

const storage: AttentionItem = {
  kind: 'alert',
  area: 'storage',
  at: AT,
  metric: 'storage.size',
  currentValue: 1_717_986_918,
  threshold: 1_073_741_824,
};

describe('the rows', () => {
  test('the provider row names the provider that was removed and sends you to Models', () => {
    const row = attentionRow({
      kind: 'no-provider',
      area: 'providers',
      at: AT,
      provider: 'anthropic',
    });
    expect(row.glyph).toBe('provider');
    expect(row.title).toBe('No model provider connected');
    expect(row.description).toMatch(
      /^Agents can’t answer until one is connected\. The Anthropic key was removed at \d{1,2}:\d{2} (AM|PM)\.$/,
    );
    expect(row.actions).toEqual([{ label: 'Connect a provider', href: '/settings/models' }]);
  });

  test('a provider row with no known provider or time says only what is wrong', () => {
    const row = attentionRow({ kind: 'no-provider', area: 'providers', at: null, provider: null });
    expect(row.description).toBe('Agents can’t answer until one is connected.');
  });

  test('the storage row states what was measured and no threshold, with two actions', () => {
    const row = attentionRow(storage);
    expect(row.glyph).toBe('storage');
    expect(row.title).toBe('Storage is over its warning level, 1.6 GB');
    expect(row.description).toMatch(/^Alert firing since \d{1,2}:\d{2} (AM|PM)\.$/);
    expect(`${row.title} ${row.description}`).not.toMatch(/GB of|limit|capacity|threshold|1\.0 GB/);
    expect(row.actions.map((action) => action.label)).toEqual(['View storage', 'Change retention']);
    expect(row.actions.map((action) => action.href)).toEqual([
      '/health/storage',
      '/settings/data-and-retention',
    ]);
  });

  test('a missed-runs row names the schedule, how many, since when, and every day it was due', () => {
    const row = attentionRow({
      kind: 'missed-runs',
      area: 'schedules',
      at: AT,
      scheduleId: 'schedule-1',
      scheduleName: 'Daily summary',
      count: 4,
      since: Date.UTC(2026, 9, 30, 12),
      occurrences: [
        { occurrence: Date.UTC(2026, 9, 30, 12), count: 1 },
        { occurrence: Date.UTC(2026, 9, 31, 12), count: 1 },
        { occurrence: Date.UTC(2026, 10, 1, 12), count: 1 },
        { occurrence: Date.UTC(2026, 10, 2, 12), count: 1 },
      ],
    });
    expect(row.glyph).toBe('schedule');
    expect(row.title).toBe('Daily summary missed 4 runs since Oct 30');
    expect(row.description).toBe(
      'Interborough was off when it was due on Oct 30, Oct 31, Nov 1 and Nov 2.',
    );
    expect(row.actions).toEqual([{ label: 'View schedule', href: '/schedules/schedule-1' }]);
  });

  test('a hook whose last delivery failed says what the receiver answered', () => {
    const row = attentionRow({
      kind: 'hook-failed',
      area: 'hooks',
      at: AT,
      hookId: 'hook-1',
      hookName: 'Notify Slack when a review is waiting',
      gaveUp: false,
      status: 410,
      host: 'hooks.slack.com',
      attempts: 1,
      error: null,
    });
    expect(row.glyph).toBe('hook');
    expect(row.title).toBe(
      'Notify Slack when a review is waiting’s last delivery failed, 410 Gone',
    );
    expect(row.description).toMatch(
      /^hooks\.slack\.com answered 410 Gone on its last try at \d{1,2}:\d{2} (AM|PM)\.$/,
    );
    expect(row.actions).toEqual([{ label: 'View hook', href: '/hooks/hook-1' }]);
  });

  test('a hook that gave up says how many tries it made and when it stopped', () => {
    const row = attentionRow({
      kind: 'hook-failed',
      area: 'hooks',
      at: Date.UTC(2026, 9, 30, 15),
      hookId: 'hook-2',
      hookName: 'Page on-call when a run fails',
      gaveUp: true,
      status: 410,
      host: 'hooks.example.test',
      attempts: 8,
      error: null,
    });
    expect(row.title).toBe('Page on-call when a run fails gave up, 410 Gone');
    expect(row.description).toBe('Stopped after 8 tries on Oct 30. The URL may have been removed.');
  });

  test('a hook nobody answered for says why instead of a status', () => {
    const row = attentionRow({
      kind: 'hook-failed',
      area: 'hooks',
      at: AT,
      hookId: 'hook-3',
      hookName: null,
      gaveUp: false,
      status: null,
      host: null,
      attempts: 2,
      error: 'The connection was refused.',
    });
    expect(row.title).toBe('A hook’s last delivery failed');
    expect(row.description).toMatch(/^The connection was refused\. Its last try was at /);
  });

  test('a plugin that did not load is named and sends you to Plugins', () => {
    const row = attentionRow({
      kind: 'plugin-not-loaded',
      area: 'plugins',
      at: AT,
      plugin: 'web-search',
      problems: ['load-failed'],
    });
    expect(row.glyph).toBe('plugin');
    expect(row.title).toBe('Web search didn’t load');
    expect(row.description).toMatch(
      /^Its tools aren’t available to agents until it loads\. Interborough couldn’t start it at \d/,
    );
    expect(row.actions).toEqual([{ label: 'Open Plugins', href: '/settings/plugins' }]);
  });

  test('a disconnected worker says what waits on its queue, when it was last heard from, and opens the worker', () => {
    const row = attentionRow({
      kind: 'worker-disconnected',
      area: 'workers',
      at: Date.UTC(2026, 10, 2, 15, 41),
      workerId: 'reports-worker',
      workerName: 'Reports worker',
      queue: 'reports',
      waiting: 12,
      failedForGood: 2,
    });
    expect(row.glyph).toBe('worker');
    expect(row.title).toBe('Reports worker is disconnected');
    expect(row.description).toMatch(
      /^12 tasks are waiting for the reports queue and 2 failed for good\. It was last heard from at \d{1,2}:\d{2} (AM|PM) and reconnects by itself when its process starts again\.$/,
    );
    expect(row.actions).toEqual([
      { label: 'View worker', href: '/health/workers?worker=reports-worker' },
    ]);
  });

  test('a worker with no name is called by the queue it serves, and one waiting task is singular', () => {
    const row = attentionRow({
      kind: 'worker-disconnected',
      area: 'workers',
      at: AT,
      workerId: 'w/1',
      workerName: null,
      queue: 'billing',
      waiting: 1,
      failedForGood: 0,
    });
    expect(row.title).toBe('The billing worker is disconnected');
    expect(row.description).toContain('1 task is waiting for the billing queue and 0 failed');
    expect(row.actions[0]?.href).toBe('/health/workers?worker=w%2F1');
  });

  test('another alert rule opens Alerts, and a rule this build has no sentence for says its metric', () => {
    const failing = attentionRow({
      kind: 'alert',
      area: 'runs',
      at: AT,
      metric: 'workflow.failure_rate',
      currentValue: 0.25,
      threshold: 0.1,
    });
    expect(failing.title).toBe('Workflow failure rate is over its warning level, 25%');
    expect(failing.actions).toEqual([{ label: 'Open alerts', href: '/health?advanced=alerts' }]);
    const unknown = attentionRow({
      kind: 'alert',
      area: 'runs',
      at: AT,
      metric: 'something.new',
      currentValue: 1,
      threshold: 1,
    } as unknown as AttentionItem);
    expect(unknown.title).toBe('something.new is over its warning level');
  });
});

describe('the list', () => {
  test('keeps the order it was given, and gives every row an identifier of its own', () => {
    const rows = attentionRows([
      { kind: 'no-provider', area: 'providers', at: AT, provider: 'anthropic' },
      storage,
    ]);
    expect(rows.map((row) => row.glyph)).toEqual(['provider', 'storage']);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
  });

  test('words a status the way the receiver would', () => {
    expect(statusWords(410)).toBe('410 Gone');
    expect(statusWords(599)).toBe('599');
    expect(statusWords(null)).toBeNull();
  });
});
