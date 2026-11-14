import { describe, expect, test } from 'bun:test';

import type { RunStep, RunStepBranchLane, RunStepStatus } from './run-step-timeline.types.ts';
import {
  actionsCountLabel,
  badgeVariant,
  branchGroupHasCurrentStep,
  branchOutcomeSummary,
  branchStartsCollapsed,
  describeSegments,
  hasProgress,
  hiddenNestedStepLabel,
  isCurrent,
  isTerminal,
  laneOutcomeBadgeVariant,
  laneOutcomeLabel,
  metadataItems,
  railConnections,
  safeStepLinkHref,
  statusDotStatus,
  statusLabel,
} from './run-step-timeline.utilities.ts';

describe('railConnections', () => {
  test('a flat rail links every row to the next, and the last row has no line', () => {
    expect(railConnections([0, 0, 0])).toEqual([
      { after: 'visible', through: [] },
      { after: 'visible', through: [] },
      { after: 'hidden', through: [] },
    ]);
  });

  test("a parent's line runs past its nested rows to its next sibling", () => {
    // plan, lane, inspect, verify, archive: the lane's line reaches archive's marker.
    expect(railConnections([0, 0, 1, 1, 0])).toEqual([
      { after: 'visible', through: [] },
      { after: 'visible', through: [] },
      { after: 'visible', through: [{ depth: 0, ends: false }] },
      { after: 'hidden', through: [{ depth: 0, ends: false }] },
      { after: 'hidden', through: [] },
    ]);
  });

  test('a last parent runs its line along its nested rows and stops at the last one', () => {
    expect(railConnections([0, 1, 1, 2])).toEqual([
      { after: 'visible', through: [] },
      { after: 'visible', through: [{ depth: 0, ends: false }] },
      { after: 'visible', through: [{ depth: 0, ends: false }] },
      {
        after: 'hidden',
        through: [
          { depth: 0, ends: true },
          { depth: 1, ends: true },
        ],
      },
    ]);
  });

  test('a dedent past two levels closes both lines and the outer one reaches its sibling', () => {
    expect(railConnections([0, 1, 2, 0])).toEqual([
      { after: 'visible', through: [] },
      { after: 'visible', through: [{ depth: 0, ends: false }] },
      {
        after: 'hidden',
        through: [
          { depth: 0, ends: false },
          { depth: 1, ends: true },
        ],
      },
      { after: 'hidden', through: [] },
    ]);
  });
});

const ALL_STATUSES: RunStepStatus[] = [
  'pending',
  'running',
  'succeeded',
  'failed',
  'timed-out',
  'cancelled',
  'skipped',
  'retrying',
  'waiting_approval',
  'waiting',
  'recorded',
];

describe('status mapping', () => {
  test('statusDotStatus maps every status to a StatusDot token', () => {
    const map = Object.fromEntries(ALL_STATUSES.map((s) => [s, statusDotStatus(s)]));
    expect(map).toEqual({
      pending: 'pending',
      running: 'online',
      succeeded: 'success',
      failed: 'danger',
      'timed-out': 'danger',
      cancelled: 'offline',
      skipped: 'neutral',
      retrying: 'warning',
      waiting_approval: 'accent',
      waiting: 'pending',
      recorded: 'neutral',
    });
  });

  test('statusLabel returns a human label for every status', () => {
    for (const status of ALL_STATUSES) {
      expect(statusLabel(status).length).toBeGreaterThan(0);
    }
    expect(statusLabel('waiting_approval')).toBe('Waiting approval');
    expect(statusLabel('timed-out')).toBe('Timed out');
    expect(statusLabel('cancelled')).toBe('Canceled');
    expect(statusLabel('waiting')).toBe('Waiting');
  });

  test('badgeVariant maps every status to a badge variant', () => {
    const map = Object.fromEntries(ALL_STATUSES.map((s) => [s, badgeVariant(s)]));
    expect(map).toEqual({
      pending: 'neutral',
      running: 'info',
      succeeded: 'success',
      failed: 'danger',
      'timed-out': 'danger',
      cancelled: 'neutral',
      skipped: 'neutral',
      retrying: 'warning',
      waiting_approval: 'accent',
      waiting: 'neutral',
      recorded: 'neutral',
    });
  });

  test('isTerminal / isCurrent partition the statuses', () => {
    expect(ALL_STATUSES.filter(isTerminal)).toEqual([
      'succeeded',
      'failed',
      'timed-out',
      'cancelled',
      'skipped',
      'recorded',
    ]);
    expect(ALL_STATUSES.filter(isCurrent)).toEqual([
      'running',
      'retrying',
      'waiting_approval',
      'waiting',
    ]);
    expect(isTerminal('pending')).toBe(false);
    expect(isCurrent('pending')).toBe(false);
  });
});

describe('hasProgress', () => {
  const base: RunStep = { id: 'a', label: 'A', status: 'running' };
  test('true only for current steps with a progress value', () => {
    expect(hasProgress({ ...base, status: 'running', progress: 40 })).toBe(true);
    expect(hasProgress({ ...base, status: 'succeeded', progress: 40 })).toBe(false);
    expect(hasProgress({ ...base, status: 'running' })).toBe(false);
  });
});

describe('metadataItems', () => {
  test('collects present time/duration/attempt fields', () => {
    const items = metadataItems({
      id: 'a',
      label: 'A',
      status: 'succeeded',
      startTime: 's',
      endTime: 'e',
      duration: '1m',
      attemptCount: 3,
    });
    expect(items.map((i) => i.term)).toEqual(['Started', 'Ended', 'Duration', 'Attempts']);
    expect(items.at(-1)?.definition).toBe('3');
  });

  test('omits attemptCount when it is 1 or less, and omits absent fields', () => {
    expect(metadataItems({ id: 'a', label: 'A', status: 'pending', attemptCount: 1 })).toEqual([]);
  });
});

describe('labels', () => {
  test('actionsCountLabel pluralizes', () => {
    expect(actionsCountLabel(1)).toBe('1 action');
    expect(actionsCountLabel(4)).toBe('4 actions');
  });

  test('hiddenNestedStepLabel pluralizes', () => {
    expect(hiddenNestedStepLabel(1)).toBe('1 nested step hidden');
    expect(hiddenNestedStepLabel(5)).toBe('5 nested steps hidden');
  });
});

describe('branch lane outcomes', () => {
  test('laneOutcomeLabel covers won / lost / settled', () => {
    expect(laneOutcomeLabel('won')).toBe('Won');
    expect(laneOutcomeLabel('lost')).toBe('Lost');
    expect(laneOutcomeLabel('settled')).toBe('Settled');
  });

  test('laneOutcomeBadgeVariant covers won / lost / settled', () => {
    expect(laneOutcomeBadgeVariant('won')).toBe('success');
    expect(laneOutcomeBadgeVariant('lost')).toBe('neutral');
    expect(laneOutcomeBadgeVariant('settled')).toBe('info');
  });

  const lane = (outcome: RunStepBranchLane['outcome']): RunStepBranchLane => ({
    id: outcome ?? 'racing',
    steps: [],
    ...(outcome ? { outcome } : {}),
  });

  test('branchOutcomeSummary summarizes mixed outcomes', () => {
    expect(branchOutcomeSummary([lane('won'), lane('lost'), lane('lost')])).toBe('1 won, 2 lost');
    expect(branchOutcomeSummary([lane('settled'), lane('settled')])).toBe('2 settled');
    expect(branchOutcomeSummary([lane(undefined)])).toBe('1 lane racing');
    expect(branchOutcomeSummary([lane(undefined), lane(undefined)])).toBe('2 lanes racing');
    expect(branchOutcomeSummary([lane('won'), lane(undefined)])).toBe('1 won, 1 lane racing');
    expect(branchOutcomeSummary([])).toBe('No lanes');
  });
});

describe('branchGroupHasCurrentStep', () => {
  test('detects an in-flight step in any lane, including nested children', () => {
    expect(
      branchGroupHasCurrentStep({
        kind: 'branch',
        id: 'g',
        label: 'G',
        lanes: [
          { id: 'a', steps: [{ id: 'a1', label: 'A', status: 'succeeded' }] },
          {
            id: 'b',
            steps: [
              {
                id: 'b1',
                label: 'B',
                status: 'succeeded',
                children: [{ id: 'b1a', label: 'B1a', status: 'running' }],
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  test('returns false when every lane step is terminal', () => {
    expect(
      branchGroupHasCurrentStep({
        kind: 'branch',
        id: 'g',
        label: 'G',
        lanes: [
          { id: 'a', steps: [{ id: 'a1', label: 'A', status: 'succeeded' }] },
          { id: 'b', steps: [{ id: 'b1', label: 'B', status: 'failed' }] },
        ],
      }),
    ).toBe(false);
  });
});

describe('branchStartsCollapsed', () => {
  test('an explicit collapsed flag wins over the threshold', () => {
    expect(branchStartsCollapsed(1, undefined, true)).toBe(true);
    expect(branchStartsCollapsed(9, undefined, false)).toBe(false);
  });

  test('collapses once the lane count reaches the threshold (default 3)', () => {
    expect(branchStartsCollapsed(2, undefined, undefined)).toBe(false);
    expect(branchStartsCollapsed(3, undefined, undefined)).toBe(true);
    expect(branchStartsCollapsed(4, 5, undefined)).toBe(false);
    expect(branchStartsCollapsed(5, 5, undefined)).toBe(true);
  });

  test('falls back to the default of 3 for an invalid threshold (0, negative, NaN, fractional)', () => {
    // Invalid thresholds must not collapse everything (0) or behave erratically.
    expect(branchStartsCollapsed(1, 0, undefined)).toBe(false);
    expect(branchStartsCollapsed(3, 0, undefined)).toBe(true);
    expect(branchStartsCollapsed(2, -5, undefined)).toBe(false);
    expect(branchStartsCollapsed(3, Number.NaN, undefined)).toBe(true);
    expect(branchStartsCollapsed(2, 2.5, undefined)).toBe(false);
    expect(branchStartsCollapsed(3, 2.5, undefined)).toBe(true);
  });
});

describe('safeStepLinkHref', () => {
  test('accepts http(s) absolute URLs and relative paths', () => {
    expect(safeStepLinkHref('https://example.com/x')).toBe('https://example.com/x');
    expect(safeStepLinkHref('http://example.com')).toBe('http://example.com');
    expect(safeStepLinkHref('/runs/123')).toBe('/runs/123');
    expect(safeStepLinkHref('  /runs/123  ')).toBe('/runs/123');
  });

  test('rejects empty, control-char, backslash, and protocol-relative hrefs', () => {
    expect(safeStepLinkHref('')).toBeUndefined();
    expect(safeStepLinkHref('   ')).toBeUndefined();
    expect(safeStepLinkHref('/runs\u0001id')).toBeUndefined(); // control character
    expect(safeStepLinkHref('back\\slash')).toBeUndefined();
    expect(safeStepLinkHref('//evil.example.com')).toBeUndefined();
  });

  test('rejects non-http(s) schemes', () => {
    expect(safeStepLinkHref('javascript:alert(1)')).toBeUndefined();
    expect(safeStepLinkHref('mailto:a@b.com')).toBeUndefined();
  });

  test('rejects a scheme-shaped href that is not a parseable URL', () => {
    // Matches the scheme regex but `new URL()` throws → the catch path.
    expect(safeStepLinkHref('http://')).toBeUndefined();
  });
});

describe('exhaustiveness guards', () => {
  // Every status/outcome mapper here switches over a closed union and is
  // exhaustively tested above via ALL_STATUSES / won-lost-settled, so the
  // `default: return assertNever(...)` arm is only reachable by a caller
  // that bypasses the type system (e.g. untyped JS interop) — these guard
  // against exactly that, matching the convention in
  // src/_internal/collection.test.ts's `navigationIntent` exhaustiveness test.
  test('statusDotStatus throws for a status outside the known union', () => {
    expect(() => statusDotStatus('sideways' as never)).toThrow(
      'Unexpected exhaustive value: sideways',
    );
  });

  test('statusLabel throws for a status outside the known union', () => {
    expect(() => statusLabel('sideways' as never)).toThrow('Unexpected exhaustive value: sideways');
  });

  test('badgeVariant throws for a status outside the known union', () => {
    expect(() => badgeVariant('sideways' as never)).toThrow(
      'Unexpected exhaustive value: sideways',
    );
  });

  test('laneOutcomeLabel throws for an outcome outside the known union', () => {
    expect(() => laneOutcomeLabel('sideways' as never)).toThrow(
      'Unexpected exhaustive value: sideways',
    );
  });

  test('laneOutcomeBadgeVariant throws for an outcome outside the known union', () => {
    expect(() => laneOutcomeBadgeVariant('sideways' as never)).toThrow(
      'Unexpected exhaustive value: sideways',
    );
  });
});

describe('describeSegments', () => {
  test('renders the parts between backticks as code', () => {
    expect(
      describeSegments('Waiting for signal `notes-approved`. It starts again when sent.'),
    ).toEqual([
      { text: 'Waiting for signal ', code: false },
      { text: 'notes-approved', code: true },
      { text: '. It starts again when sent.', code: false },
    ]);
  });

  test('keeps plain text, an unmatched backtick and an empty pair as text', () => {
    expect(describeSegments('Found the last release')).toEqual([
      { text: 'Found the last release', code: false },
    ]);
    expect(describeSegments('one ` two')).toEqual([{ text: 'one ` two', code: false }]);
    expect(describeSegments('a `` b')).toEqual([{ text: 'a `` b', code: false }]);
    expect(describeSegments('')).toEqual([]);
  });

  test('handles code at either end and several pairs', () => {
    expect(describeSegments('`a` and `b`')).toEqual([
      { text: 'a', code: true },
      { text: ' and ', code: false },
      { text: 'b', code: true },
    ]);
  });
});
