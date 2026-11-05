import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

import type { StatusDotWord } from '../status-dot/status-dot.words.ts';

export type TimelineOrientation = 'vertical' | 'horizontal';
export type TimelineGroupBy = 'none' | 'day' | 'week';
export type TimelineWeekStartsOn = 'sunday' | 'monday';
export type TimelineTone = 'info' | 'success' | 'warning' | 'error' | 'pending';
/**
 * What an entry is. `event` is an ordinary marker row. `now` is the marker for the current moment
 * (an accent pill, a rule, and the time at the right), placed between the upcoming and the past.
 * `separator` is a quiet labelled rule between two rows, for a break the reader should not
 * mistake for a gap, such as the day daylight saving time ended. `band` is one collapsed group
 * row with a tinted band, a chevron, the title, muted `detail` and a disclosure label: the missed
 * runs of a schedule, shown once below Now. Its `children` are the details the band opens. `run` is
 * a past run as the status-first two-line row: its `status` word and dot lead, `timestamp` is the
 * bold time, `detail` is the muted second line, `duration` and a chevron sit at the right, and
 * `href` makes the whole row the link.
 */
export type TimelineEntryKind = 'event' | 'now' | 'separator' | 'band' | 'run';
/**
 * `rail` is the default: a vertical rail with a connector from marker to marker. `list` is the
 * same entries as compact rows, with no connector, a hairline between rows and the time first.
 * `rows` keeps the rail's marker column and connector but draws nothing else: each entry is a
 * single row whose whole content is the `children` snippet, with no timestamp or title header, for
 * a sequence that has nothing to date (the tool calls of one chat turn). Its `datetime` and
 * `timestamp` are not read, so they may be empty, and `title` is only the entry's name.
 */
export type TimelineVariant = 'rail' | 'list' | 'rows';
export type TimelineHeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export type TimelineEntry = {
  /** Stable id used as the keyed list identity. */
  id: string;
  /** Machine-readable ISO datetime rendered into `<time datetime>`. */
  datetime: string;
  /** Visible timestamp label rendered inside `<time>`. */
  timestamp: string;
  /** Visible event title. */
  title: string;
  /**
   * Semantic marker tone. `pending` is a hollow neutral ring for something that has not happened
   * yet (an upcoming run), the same ring a status dot draws for Waiting. @default "info"
   */
  tone?: TimelineTone | undefined;
  /**
   * What the entry is. For `now`, `title` is the pill's text ("Now") and `timestamp` the time at
   * the right. For `separator`, `title` is the label and `timestamp` and `datetime` say what moment
   * it marks. Neither draws a marker, a connector, a body or actions. For `band`, `tone` tints the
   * band (`warning` is amber, anything else neutral) and `title` is its bold text. @default "event"
   */
  kind?: TimelineEntryKind | undefined;
  /** Optional day/week group label override. The first entry in a group wins. */
  groupLabel?: string | undefined;
  /** For a `band`: the muted text after the title ("Interborough was off"). */
  detail?: string | undefined;
  /** For a `band`: the text of the button that opens it. @default "Show" */
  expandLabel?: string | undefined;
  /** For a `band`: the text of the button that closes it. @default "Hide" */
  collapseLabel?: string | undefined;
  /** For a `band`: whether it starts open. The `onexpandedchange` of the timeline hears each change. @default false */
  expanded?: boolean | undefined;
  /** For a `run`: the status word that leads the row ("Done", "Running", "Failed"), which sets its dot and its tone. */
  status?: StatusDotWord | undefined;
  /** For a `run`: where the row links to. The whole row is the link. */
  href?: string | undefined;
  /** For a `run`: the text at the right of the row, before its chevron ("14 s", "38 s so far"). */
  duration?: string | undefined;
  /** For an `event`: draws the timestamp struck through, for something that will not happen. @default false */
  struck?: boolean | undefined;
  /**
   * For an `event`: draws no marker, so the row starts at the inline start. In the `list` variant
   * a `warning` tone colours the title instead of the marker ("Missed · Interborough was off").
   * @default false
   */
  plain?: boolean | undefined;
};

/**
 * Event-rail list for workflow events, audit logs, run histories, and
 * timestamp-first sequences. Timeline is not a live region; use Feed for
 * streaming activity that assistive technology should announce.
 */
export type TimelineProps = Omit<
  HTMLAttributes<HTMLOListElement>,
  'class' | 'children' | 'role'
> & {
  /**
   * Timeline entries rendered in source order.
   * @schemaObject
   */
  entries: TimelineEntry[];
  /** Layout orientation. @default "vertical" */
  orientation?: TimelineOrientation | undefined;
  /** Rail with connectors, compact rows with none, or a rail whose rows `children` draws whole. @default "rail" */
  variant?: TimelineVariant | undefined;
  /** Optional adjacent UTC day/week grouping mode. @default "none" */
  groupBy?: TimelineGroupBy | undefined;
  /** Week start used for UTC week grouping. @default "monday" */
  weekStartsOn?: TimelineWeekStartsOn | undefined;
  /** Heading level applied to rendered group headers. @default 3 */
  groupHeaderLevel?: TimelineHeadingLevel | undefined;
  /** Hide the following connector when adjacent valid timestamps exceed this gap (in minutes). */
  gapThresholdMinutes?: number | undefined;
  /** Fallback accessible label used only when aria-label and aria-labelledby are absent. */
  label?: string | undefined;
  /** Additional class names merged with `.cinder-timeline`. */
  class?: string | undefined;
  /** Optional per-entry body content. */
  children?: Snippet<[TimelineEntry]> | undefined;
  /**
   * Optional per-entry controls, drawn at the inline end of the entry's row (a "Skip" button on an
   * upcoming run). Unlike `marker`, they are interactive and in the tab order. Not drawn for a
   * `now` or `separator` entry.
   */
  actions?: Snippet<[TimelineEntry]> | undefined;
  /** Decorative per-entry marker content. Must not contain interactive descendants. */
  marker?: Snippet<[TimelineEntry]> | undefined;
  /** Called when a `band` entry is opened or closed, with the entry and whether it is now open. */
  onexpandedchange?: ((entry: TimelineEntry, expanded: boolean) => void) | undefined;
};

/** Schema generator surface for Timeline — excludes snippet props. */
export interface TimelineSchemaProps {
  /**
   * Timeline entries rendered in source order.
   * @schemaObject
   */
  entries: TimelineEntry[];
  /** Layout orientation. @default "vertical" */
  orientation?: TimelineOrientation | undefined;
  /** Rail with connectors, compact rows with none, or a rail whose rows `children` draws whole. @default "rail" */
  variant?: TimelineVariant | undefined;
  /** Optional adjacent UTC day/week grouping mode. @default "none" */
  groupBy?: TimelineGroupBy | undefined;
  /** Week start used for UTC week grouping. @default "monday" */
  weekStartsOn?: TimelineWeekStartsOn | undefined;
  /** Heading level applied to rendered group headers. @default 3 */
  groupHeaderLevel?: TimelineHeadingLevel | undefined;
  /** Hide the following connector when adjacent valid timestamps exceed this gap (in minutes). */
  gapThresholdMinutes?: number | undefined;
  /** Fallback accessible label used only when aria-label and aria-labelledby are absent. */
  label?: string | undefined;
  /** Additional class names merged with `.cinder-timeline`. */
  class?: string | undefined;
}
