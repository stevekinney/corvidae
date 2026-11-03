import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

export type TimelineOrientation = 'vertical' | 'horizontal';
export type TimelineGroupBy = 'none' | 'day' | 'week';
export type TimelineWeekStartsOn = 'sunday' | 'monday';
export type TimelineTone = 'info' | 'success' | 'warning' | 'error' | 'pending';
/**
 * What an entry is. `event` is an ordinary marker row. `now` is the marker for the current moment
 * (an accent pill, a rule, and the time at the right), placed between the upcoming and the past.
 * `separator` is a quiet labelled rule between two rows, for a break the reader should not
 * mistake for a gap, such as the day daylight saving time ended.
 */
export type TimelineEntryKind = 'event' | 'now' | 'separator';
/**
 * `rail` is the default: a vertical rail with a connector from marker to marker. `list` is the
 * same entries as compact rows, with no connector, a hairline between rows and the time first.
 */
export type TimelineVariant = 'rail' | 'list';
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
   * it marks. Neither draws a marker, a connector, a body or actions. @default "event"
   */
  kind?: TimelineEntryKind | undefined;
  /** Optional day/week group label override. The first entry in a group wins. */
  groupLabel?: string | undefined;
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
  /** Rail with connectors, or compact rows with none. @default "rail" */
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
  /** Rail with connectors, or compact rows with none. @default "rail" */
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
