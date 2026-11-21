/**
 * The rows of Home's activity bands (COR-2227): the fleet rules, the Bureau's words, the one form
 * of an event the application could not word, the glyph table and its one neutral fallback, the
 * tier said once as a StatusDot word, and the newest-first window.
 */
import { Activity, CalendarClock, Server, Workflow } from '@lucide/svelte';
import { describe, expect, test } from 'bun:test';

import type { FormattedBureauEvent } from '../../lib/bureau-event-format.ts';
import type { BureauEventFrame } from '../../lib/live-source/bureau-event-frame.ts';
import type { FleetEventFrame } from '../../lib/live-source/fleet-event-source.svelte.ts';
import {
  ACTIVITY_ROW_LIMIT,
  ACTIVITY_WINDOW_LIMIT,
  activityIcon,
  bureauEntry,
  FLEET_EVENT_RULES,
  fleetEntry,
  lineTwoText,
  listsFleetKind,
  newestFirst,
  tierWord,
  type ActivityEntry,
} from './home-activity-rows.ts';

function envelope(extra: Partial<BureauEventFrame> = {}): BureauEventFrame {
  return {
    kind: 'goal.attempt.started',
    sequence: 1,
    cursor: 'b:1',
    emittedAtMs: 1_000,
    payload: { goalRunId: 'run-goal' },
    ...extra,
  };
}

function formatted(extra: Partial<FormattedBureauEvent> = {}): FormattedBureauEvent {
  return {
    kind: 'review.requested',
    title: 'Refund order 4471 waits on you',
    tier: 'warning',
    formattedBy: 'reviews/review-requested',
    ...extra,
  };
}

function frame(extra: Partial<FleetEventFrame> = {}): FleetEventFrame {
  return {
    kind: 'workflow:started',
    sequence: 1,
    cursor: 'f:1',
    emittedAtMs: 2_000,
    payload: {},
    ...extra,
  };
}

describe('the tier', () => {
  test('is said once, as a StatusDot word for warning and critical, and not at all for info', () => {
    expect(tierWord('warning')).toBe('Warning');
    expect(tierWord('critical')).toBe('Critical');
    expect(tierWord('info')).toBeUndefined();
  });

  test('leads line two with a comma before the body, alone with no body, and the body alone on an info row', () => {
    const base: ActivityEntry = { key: 'k', at: 0, icon: Activity, title: 'T', tier: 'warning' };
    expect(lineTwoText({ ...base, body: 'Two drafts skipped' })).toBe(
      'Warning, Two drafts skipped',
    );
    expect(lineTwoText(base)).toBe('Warning');
    expect(lineTwoText({ ...base, tier: 'info', body: 'Done' })).toBe('Done');
    expect(lineTwoText({ ...base, tier: 'info' })).toBeUndefined();
  });
});

describe('the glyph', () => {
  test('is the formatter’s Lucide icon when the table knows it, by either spelling', () => {
    expect(activityIcon('calendar-clock')).toBe(CalendarClock);
    expect(activityIcon('CalendarClock')).toBe(CalendarClock);
    expect(activityIcon('server')).toBe(Server);
  });

  test('is the one neutral activity glyph for a name that is absent or unknown, whatever the tier', () => {
    expect(activityIcon(undefined)).toBe(Activity);
    expect(activityIcon('not-a-lucide-icon')).toBe(Activity);
    expect(activityIcon('')).toBe(Activity);
  });
});

describe('a Bureau event', () => {
  test('a claimed kind reads in the formatter’s words, with its tier, glyph, body and link', () => {
    const entry = bureauEntry(
      envelope({ kind: 'review.requested', cursor: 'b:7', emittedAtMs: 5 }),
      formatted({ body: 'Tool runner asks', icon: 'user-check', link: '/reviews/7' }),
    );
    expect(entry).toMatchObject({
      key: 'b:7',
      at: 5,
      title: 'Refund order 4471 waits on you',
      tier: 'warning',
      body: 'Tool runner asks',
      href: '/reviews/7',
    });
  });

  test('a claimed kind with no link opens the run its payload names', () => {
    const entry = bureauEntry(envelope(), formatted({ runId: 'run-9' }));
    expect(entry.href).toBe('/runs/run-9');
  });

  test('an unclaimed kind is titled in plain words and links its run', () => {
    // No `formattedBy`: no formatter claimed the kind, so the Bureau's title is the raw kind.
    const unclaimed: FormattedBureauEvent = {
      kind: 'goal.attempt.started',
      title: 'goal.attempt.started',
      tier: 'info',
      runId: 'run-goal',
    };
    const entry = bureauEntry(envelope(), unclaimed);
    expect(entry.title).toBe('Goal attempt started');
    expect(entry.icon).toBe(Activity);
    expect(entry.tier).toBe('info');
    expect(entry.href).toBe('/runs/run-goal');
    expect(lineTwoText(entry)).toBeUndefined();
  });

  test('an event of a format call that failed takes the same form, its run read from the payload', () => {
    const entry = bureauEntry(envelope(), null);
    expect(entry).toMatchObject({
      title: 'Goal attempt started',
      tier: 'info',
      href: '/runs/run-goal',
    });
    expect(entry.icon).toBe(Activity);
    const unlinked = bureauEntry(envelope({ payload: { reviewId: 'r1' } }), null);
    expect(unlinked.href).toBeUndefined();
  });

  test('the tier comes from the formatter only: an info row titled as a failure has no word', () => {
    const entry = bureauEntry(envelope(), formatted({ title: 'Run failed', tier: 'info' }));
    expect(tierWord(entry.tier)).toBeUndefined();
    expect(lineTwoText(entry)).toBeUndefined();
  });
});

describe('a fleet event', () => {
  test('a ruled kind reads in the rule’s words and links the run the frame names', () => {
    const entry = fleetEntry(
      frame({ workflowId: 'wf-1', payload: { workflowId: 'wf-1', workflowType: 'Release notes' } }),
    );
    expect(entry).toMatchObject({
      title: 'Run started',
      tier: 'info',
      body: 'Release notes',
      href: '/runs/wf-1',
    });
    expect(entry.icon).toBe(Workflow);
    const failed = fleetEntry(
      frame({ kind: 'workflow:failed', payload: { workflowId: 'wf-2', error: 'Step 3 threw' } }),
    );
    expect(failed).toMatchObject({ title: 'Run failed', tier: 'critical', body: 'Step 3 threw' });
    expect(failed.href).toBe('/runs/wf-2');
  });

  test('a step that failed says its name and its attempt, then the error', () => {
    const entry = fleetEntry(
      frame({
        kind: 'activity:failed',
        payload: { activityName: 'send-email', attempt: 2, error: 'Timed out' },
      }),
    );
    expect(entry.body).toBe('send-email, attempt 2, Timed out');
    expect(entry.tier).toBe('warning');
  });

  test('a kind with no rule reads as an unclaimed kind does, in plain words', () => {
    const entry = fleetEntry(frame({ kind: 'realm:state-changed', payload: {} }));
    expect(entry).toMatchObject({
      title: 'Realm state changed',
      tier: 'info',
    });
    expect(entry.icon).toBe(Activity);
    expect(listsFleetKind('realm:state-changed')).toBe(true);
  });

  test('telemetry and a run’s steps as it goes are left out, and every listed rule has words', () => {
    for (const kind of ['stream:chunk', 'storage:size-reported', 'queue:depth-changed']) {
      expect(listsFleetKind(kind)).toBe(false);
    }
    expect(listsFleetKind('workflow:failed')).toBe(true);
    expect(listsFleetKind('constructor')).toBe(true);
    for (const [kind, rule] of Object.entries(FLEET_EVENT_RULES)) {
      if ('omit' in rule) continue;
      expect(rule.title, kind).not.toBe('');
      expect(rule.title, kind).not.toMatch(
        new RegExp(`Fleet|Bureau|Engine|${String.fromCodePoint(0xb7)}`),
      );
    }
  });
});

describe('the window', () => {
  const entry = (key: string, at: number): ActivityEntry => ({
    key,
    at,
    icon: Activity,
    title: key,
    tier: 'info',
  });

  test('is newest first, each event once, and keeps at most one format batch', () => {
    const ordered = newestFirst([entry('a', 1), entry('b', 3), entry('c', 2), entry('b', 3)]);
    expect(ordered.map((item) => item.key)).toEqual(['b', 'c', 'a']);
    const many = Array.from({ length: ACTIVITY_WINDOW_LIMIT + 10 }, (_, index) =>
      entry(String(index), index),
    );
    const window = newestFirst(many);
    expect(window).toHaveLength(ACTIVITY_WINDOW_LIMIT);
    expect(window[0]?.key).toBe(String(ACTIVITY_WINDOW_LIMIT + 9));
  });

  test('puts the later of two events of one millisecond first, and shows the Recent chats limit', () => {
    expect(newestFirst([entry('first', 5), entry('second', 5)]).map((item) => item.key)).toEqual([
      'second',
      'first',
    ]);
    expect(ACTIVITY_ROW_LIMIT).toBe(3);
  });
});
