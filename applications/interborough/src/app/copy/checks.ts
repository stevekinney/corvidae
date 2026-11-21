import type { StatusDotWord } from '@lostgradient/cinder';

import type { CheckKind, CheckOutcome } from '../../lib/bureau-checks.ts';

/**
 * The kinds the filter bar's segments name, in the order it draws them (the agreed design, rows
 * C2-03 and C2-09): All, then each place a check result is kept. A segment is a kind of the
 * operation, except All, which is no kind.
 */
export const CHECK_SEGMENTS = [
  'all',
  'goal',
  'scorer',
  'guardrail',
  'tripwire',
  'session',
] as const;

/** One of {@link CHECK_SEGMENTS}. */
export type CheckSegment = (typeof CHECK_SEGMENTS)[number];

/** The operation's kind each segment asks for; All asks for none. */
export const CHECK_SEGMENT_KINDS: Readonly<Record<Exclude<CheckSegment, 'all'>, CheckKind>> = {
  goal: 'goal.attempt.validated',
  scorer: 'scorer.recorded',
  guardrail: 'run.guardrail',
  tripwire: 'run.tripwire',
  session: 'session.tainted',
};

/** The time presets of the Time chip, in the order it offers them. */
export const CHECK_TIMES = ['hour', 'day', 'week', 'month'] as const;

/** One of {@link CHECK_TIMES}. */
export type CheckTime = (typeof CHECK_TIMES)[number];

/** How far back each time preset reaches, in milliseconds. */
export const CHECK_TIME_MILLISECONDS: Readonly<Record<CheckTime, number>> = {
  hour: 60 * 60 * 1_000,
  day: 24 * 60 * 60 * 1_000,
  week: 7 * 24 * 60 * 60 * 1_000,
  month: 30 * 24 * 60 * 60 * 1_000,
};

/**
 * The status word each outcome is said with, and nothing else is: the one `StatusDot` carries the
 * outcome, with its tone from Cinder's word table (the agreed design, "The exact words"). A raw
 * value such as `pass` or `tainted` is never shown.
 */
export const CHECK_OUTCOME_WORDS: Readonly<Record<CheckOutcome, StatusDotWord>> = {
  pass: 'Check met',
  fail: 'Check not met',
  error: "Couldn't check",
  unavailable: 'Unavailable',
  canceled: 'Canceled',
  indeterminate: 'No verdict',
  block: 'Blocked',
  warn: 'Warned',
  sanitize: 'Sanitized',
  redact: 'Redacted',
  tripwire: 'Tripped',
  tainted: 'Flagged',
};

/** The outcomes each kind can carry, in the order the Outcome chip lists them. */
export const CHECK_KIND_OUTCOMES: Readonly<Record<CheckKind, readonly CheckOutcome[]>> = {
  'goal.attempt.validated': ['pass', 'fail', 'error', 'unavailable', 'canceled', 'indeterminate'],
  'scorer.recorded': ['pass', 'fail', 'error', 'unavailable', 'canceled', 'indeterminate'],
  'run.guardrail': ['block', 'warn', 'sanitize', 'redact'],
  'run.tripwire': ['tripwire'],
  'session.tainted': ['tainted'],
};

/** The words of the Checks page (COR-2114), the agreed design's "Check page" tables, verbatim. */
export const CHECKS_COPY = {
  title: 'Checks',
  description: 'What every check decided about your agents’ work, newest first.',
  filtersLabel: 'Filter checks',
  kindLabel: 'Kind',
  segments: {
    all: 'All',
    goal: 'Goal checks',
    scorer: 'Scorers',
    guardrail: 'Guardrails',
    tripwire: 'Tripwires',
    session: 'Flagged sessions',
  } satisfies Record<CheckSegment, string>,
  facets: {
    check: 'Check',
    outcome: 'Outcome',
    agent: 'Agent',
    time: 'Time',
  },
  times: {
    hour: 'Last hour',
    day: 'Last 24 hours',
    week: 'Last 7 days',
    month: 'Last 30 days',
  } satisfies Record<CheckTime, string>,
  /** Line two's first word: what kind of result the row is. */
  kindWords: {
    'goal.attempt.validated': 'Goal check',
    'scorer.recorded': 'Scorer',
    'run.guardrail': 'Guardrail',
    'run.tripwire': 'Tripwire',
    'session.tainted': 'Session',
  } satisfies Record<CheckKind, string>,
  /** "score 0.82": a scorer's score, to two decimals. */
  score: (formatted: string): string => `score ${formatted}`,
  /** "version 3": the part of a check's id after its last "@". */
  version: (version: string): string => `version ${version}`,
  /** A check's choice in the Check chip: its words, then its version. */
  checkOption: (words: string, version: string | undefined): string =>
    version === undefined ? words : `${words}, version ${version}`,
  rowsLabel: 'Check results',
  loading: 'Loading checks',
  /** The status line under the placeholders when the list is slow to load (row C2-20). */
  stillLoading: 'Still loading checks. This is taking longer than usual.',
  loadingCanceled: {
    title: 'Loading canceled',
    description: 'Checks didn’t finish loading. Nothing is missing; it just wasn’t fetched.',
  },
  loadFailed: {
    title: 'Couldn’t load checks',
  },
  loadMore: 'Load more',
  loadMoreItems: 'checks',
  empty: {
    title: 'No checks yet',
    description:
      'Each time a goal’s check, a scorer or a guardrail decides something about a run, it’s listed here.',
    action: 'New goal',
    path: '/goals/new',
  },
  noMatch: {
    title: 'No checks match these filters',
    description: 'Change or clear the filters to see more checks.',
  },
  clearAction: 'Clear filters',
} as const;
