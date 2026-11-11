/**
 * The Runs list of a schedule's page, over a client the test fakes (COR-2018, rows 72k, 72v, 72w,
 * 73a, 73b, 73f, 73g, 73h, 73k, 73l, 73m): the rows of a run that is going and one that failed
 * with their second lines, Skip on the next run only, the skipped run crossed out with no Undo, the
 * band of misses and its Run once now, and what a schedule that has not run says below Now.
 */
import { cleanup, fireEvent, render, waitFor, within } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { quietFor, waitUntil } from '@lostgradient/testing/wait-until';
import type { HttpClient, ScheduleSummary, WorkflowSummary } from '@lostgradient/weft';

import { ConnectionMonitor } from '../../app/connection.svelte.ts';

import type { MissedFire } from '../../lib/bureau-schedules.ts';
import type { RowBlocker } from './schedule-row-model.ts';
import ScheduleRunsHarness from './schedule-runs-test-harness.test-harness.svelte';

afterEach(cleanup);

// Monday, Nov 2, 2026, 10:46 AM in Central time.
const NOW = Date.parse('2026-11-02T16:46:00.000Z');

function schedule(overrides: Partial<ScheduleSummary> = {}): ScheduleSummary {
  return {
    id: 'daily',
    // A workflow's own type, so the engine's missed fires are read and no Bureau is asked.
    workflowType: 'digest',
    status: 'active',
    cronExpression: '0 9 * * *',
    timeZone: 'UTC',
    overlap: 'skip',
    backfill: false,
    revisionPolicy: 'active-at-fire',
    revision: 1,
    createdAt: NOW,
    updatedAt: NOW,
    missedFireCount: 0,
    skippedCount: 0,
    nextFireAt: Date.parse('2026-11-03T09:00:00.000Z'),
    queuedRuns: [],
    ...overrides,
  };
}

function run(id: string, createdAt: string, status: WorkflowSummary['status'], tookMs = 14_000) {
  const at = Date.parse(createdAt);
  return { id, type: 'agentRun', status, version: '1', createdAt: at, updatedAt: at + tookMs };
}

function client(options: {
  runs?: WorkflowSummary[];
  missed?: MissedFire[];
  manual?: boolean;
  error?: string;
  timeline?: Array<{ step: number; stepIndex: number; status: string; operationLabel: string }>;
}): HttpClient {
  return {
    baseUrl: 'http://localhost:1',
    headers: {},
    list: async () => ({
      items: options.runs ?? [],
      total: options.runs?.length ?? 0,
      nextCursor: null,
    }),
    get: async () => ({ error: options.error }),
    getTimeline: async () => options.timeline ?? [],
    operations: {
      'weft.schedules.missed': async () => ({ missed: options.missed ?? [] }),
      'weft.workflows.scheduleprovenance.get': async () =>
        options.manual === true ? { scheduleId: 'daily', manual: true } : null,
    },
  } as unknown as HttpClient;
}

const ACTIVE = { status: 'active', allBlockers: [], workflowLabel: 'Chat with an agent' } as const;

function rows(container: HTMLElement, kind: string): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`li[data-cinder-kind="${kind}"]`));
}

describe('a run that is going and a run that failed (rows 73f and 73k)', () => {
  test('say how they started and where they are or stopped on a second line, with how long', async () => {
    const { container } = render(ScheduleRunsHarness, {
      props: {
        client: client({
          runs: [
            run('going', '2026-11-02T16:45:00.000Z', 'running', 0),
            run('failed', '2026-10-30T16:00:00.000Z', 'failed', 3_000),
          ],
          manual: true,
          error:
            'Agent "assistant" failed (finish reason "error"): {"cause":{"message":"GitHub didn’t answer (HTTP 503)"}}',
          timeline: [{ step: 1, stepIndex: 1, status: 'failed', operationLabel: 'Collect' }],
        }),
        schedule: schedule(),
        row: ACTIVE,
        now: NOW,
      },
    });

    await waitFor(() => expect(rows(container, 'run')).toHaveLength(2));
    const [going, failed] = rows(container, 'run');
    expect(going?.textContent).toContain('Running');
    expect(going?.textContent).toContain('1 min so far');
    await waitFor(() => expect(going?.textContent).toContain('Started with Run now'));
    expect(failed?.textContent).toContain('Failed');
    expect(failed?.textContent).toContain('3 s');
    await waitFor(() => expect(failed?.textContent).toContain('Failed at step 2'));
    expect(failed?.textContent).toContain('GitHub didn’t answer');
    expect(failed?.textContent).not.toContain('HTTP 503');
    // Both rows link to their run.
    for (const row of [going, failed]) {
      expect(row?.querySelector('a')?.getAttribute('href')).toMatch(/^\/runs\//);
    }
  });
});

describe('Skip, and a skipped run (rows 72k, 73a, 73g and 73p)', () => {
  test('is on every upcoming run, and names the run it skips', async () => {
    const skipped: number[] = [];
    const { findAllByRole, container } = render(ScheduleRunsHarness, {
      props: {
        client: client({}),
        schedule: schedule(),
        row: ACTIVE,
        now: NOW,
        onSkip: (occurrence: number) => skipped.push(occurrence),
      },
    });

    const skips = await findAllByRole('button', { name: /^Skip / });
    expect(skips.map((button) => button.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^Skip Thu Nov 5/),
      expect.stringMatching(/^Skip Wed Nov 4/),
      expect.stringMatching(/^Skip Tue Nov 3/),
    ]);
    expect(container.querySelectorAll('button')).toHaveLength(3);
    await fireEvent.click(skips[1]!);
    expect(skipped).toEqual([Date.parse('2026-11-04T09:00:00.000Z')]);
  });

  test('crosses the skipped run out, says Skipped and offers Undo where its Skip was, and keeps Skip on the others', async () => {
    const unskipped: number[] = [];
    const { container, findByText, getAllByRole, getByRole } = render(ScheduleRunsHarness, {
      props: {
        client: client({}),
        schedule: schedule({ skippedOccurrences: [Date.parse('2026-11-03T09:00:00.000Z')] }),
        row: ACTIVE,
        now: NOW,
        onUnskip: (occurrence: number) => unskipped.push(occurrence),
      },
    });

    await findByText('Skipped');
    const struck = container.querySelectorAll('time[data-cinder-struck]');
    expect(struck).toHaveLength(1);
    expect(struck[0]?.getAttribute('datetime')).toBe('2026-11-03T09:00:00.000Z');
    expect(
      getAllByRole('button', { name: /^Skip / }).map((button) => button.getAttribute('aria-label')),
    ).toEqual([expect.stringMatching(/^Skip Thu Nov 5/), expect.stringMatching(/^Skip Wed Nov 4/)]);
    const undo = getByRole('button', { name: /^Undo skipping Tue Nov 3/ });
    expect(undo.textContent?.trim()).toBe('Undo');
    expect(undo.getAttribute('data-cinder-variant')).toBe('ghost-accent');
    expect(undo.querySelector('svg')).not.toBeNull();
    await fireEvent.click(undo);
    expect(unskipped).toEqual([Date.parse('2026-11-03T09:00:00.000Z')]);
  });

  test('keeps Skip on both runs of a schedule held for its workflow, the one that will not start included', async () => {
    const blockers: RowBlocker[] = [
      { kind: 'cannot-load', workflowType: 'order-refund', label: 'Order refund' },
      { kind: 'provider' },
    ];
    const { findAllByRole } = render(ScheduleRunsHarness, {
      props: {
        client: client({}),
        schedule: schedule({
          status: 'paused',
          cronExpression: '0 17 * * 1',
          nextFireAt: Date.parse('2026-11-02T17:00:00.000Z'),
        }),
        row: { status: 'active', allBlockers: blockers, workflowLabel: 'Order refund' },
        now: NOW,
      },
    });

    const skips = await findAllByRole('button', { name: /^Skip / });
    expect(skips.map((button) => button.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^Skip Mon Nov 9/),
      expect.stringMatching(/^Skip Mon Nov 2/),
    ]);
  });

  test('is not offered, nor is Undo, without the scope to write', async () => {
    const { findByText, queryByRole } = render(ScheduleRunsHarness, {
      props: {
        client: client({}),
        schedule: schedule({ skippedOccurrences: [Date.parse('2026-11-03T09:00:00.000Z')] }),
        row: ACTIVE,
        now: NOW,
        canSkip: false,
      },
    });

    await findByText('Now');
    expect(queryByRole('button', { name: /^Skip / })).toBeNull();
    expect(queryByRole('button', { name: /^Undo / })).toBeNull();
  });

  test('turns Skip and Undo off while a write is in flight', async () => {
    const { findAllByRole, getByRole } = render(ScheduleRunsHarness, {
      props: {
        client: client({}),
        schedule: schedule({ skippedOccurrences: [Date.parse('2026-11-03T09:00:00.000Z')] }),
        row: ACTIVE,
        now: NOW,
        busy: true,
      },
    });

    const skips = await findAllByRole('button', { name: /^Skip / });
    expect(skips.every((button) => button.hasAttribute('disabled'))).toBe(true);
    expect(getByRole('button', { name: /^Undo / }).hasAttribute('disabled')).toBe(true);
  });
});

describe('the missed runs (rows 72i, 73l and 73m)', () => {
  const MISSED: MissedFire[] = [
    '2026-11-02T09:00:00.000Z',
    '2026-11-01T09:00:00.000Z',
    '2026-10-31T09:00:00.000Z',
    '2026-10-30T09:00:00.000Z',
  ].map((at) => ({
    occurrence: Date.parse(at),
    reason: 'late',
    count: 1,
    recordedAt: Date.parse(at),
  }));

  test('are one band, and open to each miss with one Run once now that starts one run', async () => {
    let started = 0;
    const { container, findByRole, findByText } = render(ScheduleRunsHarness, {
      props: {
        client: client({
          missed: MISSED,
          runs: [run('done', '2026-10-29T09:00:00.000Z', 'completed')],
        }),
        schedule: schedule(),
        row: ACTIVE,
        now: NOW,
        runOnce: { reason: null, disabled: false, onRun: () => (started += 1) },
      },
    });

    await findByText('Missed 4 times since Oct 30');
    const toggle = await findByRole('button', { name: /Show each/ });
    await fireEvent.click(toggle);
    const band = rows(container, 'band')[0];
    if (band === undefined) throw new Error('expected the band');
    expect(within(band).getAllByText(/^Missed, Interborough was off$/)).toHaveLength(4);
    await fireEvent.click(within(band).getByRole('button', { name: 'Run once now' }));
    expect(started).toBe(1);
  });

  test('keep Run once now off, with its reason, while Run now is', async () => {
    const { container, findByRole } = render(ScheduleRunsHarness, {
      props: {
        client: client({ missed: MISSED }),
        schedule: schedule(),
        row: ACTIVE,
        now: NOW,
        runOnce: {
          reason: 'No model provider is connected.',
          disabled: true,
          onRun: () => undefined,
        },
      },
    });

    await fireEvent.click(await findByRole('button', { name: /Show each/ }));
    const button = within(rows(container, 'band')[0] as HTMLElement).getByRole('button', {
      name: 'Run once now',
    });
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('title')).toBe('No model provider is connected.');
  });

  test('offer nothing beside the misses for a schedule that offers no Run now', async () => {
    const { container, findByRole, queryByRole } = render(ScheduleRunsHarness, {
      props: { client: client({ missed: MISSED }), schedule: schedule(), row: ACTIVE, now: NOW },
    });

    await fireEvent.click(await findByRole('button', { name: /Show each/ }));
    expect(rows(container, 'band')).toHaveLength(1);
    expect(queryByRole('button', { name: 'Run once now' })).toBeNull();
  });
});

describe('a schedule that is paused, and one that has never run (rows 72v, 72w, 73a and 73b)', () => {
  test('says there are no upcoming runs while paused, has no Now marker, and still lists its past runs', async () => {
    const { container, findByTestId } = render(ScheduleRunsHarness, {
      props: {
        client: client({
          runs: [
            run('a', '2026-10-24T13:00:00.000Z', 'completed', 41_000),
            run('b', '2026-10-23T13:00:00.000Z', 'completed', 38_000),
          ],
        }),
        schedule: schedule({ status: 'paused' }),
        row: { ...ACTIVE, status: 'paused' },
        now: NOW,
      },
    });

    const note = await findByTestId('schedule-no-upcoming');
    expect(note.textContent).toBe('No upcoming runs while the schedule is paused.');
    await waitFor(() => expect(rows(container, 'run')).toHaveLength(2));
    expect(rows(container, 'now')).toHaveLength(0);
    expect(rows(container, 'run').map((row) => row.textContent)).toEqual([
      expect.stringContaining('41 s'),
      expect.stringContaining('38 s'),
    ]);
  });

  test('says below Now why it will not start, and the due run says so on a second line', async () => {
    const due = schedule({
      cronExpression: '0 17 * * 1',
      nextFireAt: Date.parse('2026-11-02T17:00:00.000Z'),
    });
    const { container, findByRole } = render(ScheduleRunsHarness, {
      props: {
        client: client({}),
        schedule: due,
        row: {
          status: 'active',
          workflowLabel: 'Order refund',
          allBlockers: [
            { kind: 'cannot-load', workflowType: 'order-refund', label: 'Order refund' },
            { kind: 'provider' },
          ],
        },
        now: NOW,
      },
    });

    const empty = await findByRole('group', { name: 'No runs yet.' });
    expect(empty.textContent).toContain(
      'It won’t start until Order refund loads and a provider is connected.',
    );
    expect(container.querySelector('[data-testid="schedule-fire-note"]')?.textContent).toBe(
      'won’t start, Order refund can’t load, no provider',
    );
    // Now sits between the upcoming runs and the empty state.
    expect(rows(container, 'now')).toHaveLength(1);
  });

  test('says when the first run starts for a schedule that is not held', async () => {
    const { findByRole } = render(ScheduleRunsHarness, {
      props: { client: client({}), schedule: schedule(), row: ACTIVE, now: NOW },
    });

    const empty = await findByRole('group', { name: 'No runs yet.' });
    expect(empty.textContent).toMatch(/The first run starts Tue Nov 3, .*\./);
  });
});

describe('a list that could not be read', () => {
  test('says which, and the upcoming runs are still there', async () => {
    const failing = {
      ...(client({}) as unknown as Record<string, unknown>),
      list: async () => {
        throw new Error('down');
      },
    } as unknown as HttpClient;
    const { container, findByText } = render(ScheduleRunsHarness, {
      props: { client: failing, schedule: schedule(), row: ACTIVE, now: NOW },
    });

    await findByText('Past runs could not be loaded', { exact: false });
    expect(container.querySelectorAll('li[data-cinder-tone="pending"]')).toHaveLength(3);
  });

  test('says nothing of its own while the server does not answer: the shell says it once (row 73p)', async () => {
    let asked = false;
    const failing = {
      ...(client({}) as unknown as Record<string, unknown>),
      list: async () => {
        asked = true;
        throw new Error('down');
      },
    } as unknown as HttpClient;
    const monitor = new ConnectionMonitor({
      probe: () => new Promise(() => {}),
      probeDelayMs: () => 3_600_000,
    });
    monitor.reportUnreachable();
    try {
      const { container } = render(ScheduleRunsHarness, {
        props: {
          client: failing,
          connection: monitor,
          schedule: schedule(),
          row: ACTIVE,
          now: NOW,
        },
      });

      await waitUntil(() => asked);
      await waitFor(() =>
        expect(container.querySelectorAll('li[data-cinder-tone="pending"]')).toHaveLength(3),
      );
      // The read has failed; the banner it would draw does not appear, however long it is given.
      await quietFor(50);
      expect(container.textContent).not.toContain('Past runs could not be loaded');
      expect(container.querySelector('.weft-schedules-fault-banner')).toBeNull();
    } finally {
      monitor.dispose();
    }
  });
});
