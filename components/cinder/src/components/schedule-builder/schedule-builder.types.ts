import type { HTMLAttributes } from 'svelte/elements';

/**
 * The unit of an "Every N minutes or hours" schedule.
 */
export type ScheduleIntervalUnit = 'minutes' | 'hours';

/**
 * The choices the Repeats field offers. Every choice but `interval` lowers to a cron expression;
 * `interval` emits an `every` value instead, because a cron step such as `*\/7` restarts at the top
 * of each hour or day and so cannot repeat an uneven interval exactly.
 */
export type ScheduleRepeats =
  'daily' | 'weekdays' | 'weekends' | 'custom-days' | 'monthly' | 'interval' | 'cron';

/**
 * The emitted recurrence value. A cron value is read in `timeZone`. An interval value counts
 * `count` units from the moment the schedule starts, matching the duration form Weft's and the
 * Bureau's `schedules.create` take; it carries the zone the person chose so that switching back to
 * a time of day keeps it, but the zone does not change when an interval fires.
 */
export type ScheduleValue =
  | {
      /** The 5-field cron expression, space-separated (minute hour day-of-month month day-of-week). */
      cron: string;
      /** The IANA time zone the expression's wall-clock times are read in, such as `America/Los_Angeles`. */
      timeZone: string;
    }
  | {
      /** How often the schedule fires, counted from its start. */
      every: {
        /** The interval unit. */
        unit: ScheduleIntervalUnit;
        /** How many units between fires. A positive integer. */
        count: number;
      };
      /** The IANA time zone the person chose. An interval ignores it when it fires. */
      timeZone: string;
    };

/**
 * A single computed upcoming fire, as returned by the injected
 * {@link ScheduleBuilderProps.computeNextFires} callback. The component never
 * computes or formats times itself (it ships no date/cron dependency): the
 * consumer returns already-formatted display strings.
 */
export type ScheduleFire = {
  /** Stable identity for the keyed preview list. */
  id: string;
  /** Human-readable label for this fire, e.g. "Mon Jun 1, 09:00". */
  label: string;
};

/**
 * Props for the ScheduleBuilder component.
 *
 * ScheduleBuilder is a presentational recurrence-definition control. It owns
 * no scheduling execution, persistence, or date math. It is date-library-free:
 * the "next N fires" preview is produced by the injected `computeNextFires`
 * callback, and degrades gracefully (the preview is hidden) when the callback
 * is absent. Scope is recurrence only — overlap policy, jitter, and backfill
 * belong to the consumer's surrounding form.
 */
export type ScheduleBuilderProps = Omit<
  HTMLAttributes<HTMLDivElement>,
  'class' | 'children' | 'onchange'
> & {
  /**
   * The current recurrence value (controlled). Pass the value returned from
   * `onValueChange` back in to commit an edit. When omitted, the component starts
   * from every day at 9:00 AM (`0 9 * * *`) in the browser's time zone.
   */
  value?: ScheduleValue | undefined;
  /**
   * Called whenever the user edits the recurrence. Receives the next
   * {@link ScheduleValue}; an invalid custom cron is not emitted. The consumer owns
   * persistence.
   */
  onValueChange?: ((value: ScheduleValue) => void) | undefined;
  /**
   * Injected next-fires computation. The component passes the current value and
   * the requested count and renders whatever fires the consumer returns. When
   * omitted, the preview list is hidden (the component ships no date logic).
   */
  computeNextFires?: ((value: ScheduleValue, count: number) => ScheduleFire[]) | undefined;
  /**
   * How many upcoming fires to request from `computeNextFires`. Defaults to 5.
   */
  previewCount?: number | undefined;
  /**
   * The time zones the Time zone field offers. Defaults to every zone the runtime
   * knows (`Intl.supportedValuesOf('timeZone')`). The value's zone is always offered.
   */
  timeZones?: readonly string[] | undefined;
  /** Accessible label for the whole control. Defaults to "Schedule". */
  label?: string | undefined;
  /** Additional CSS classes applied to the root element. */
  class?: string | undefined;
};

/**
 * Schema-facing mirror of {@link ScheduleValue}.
 * @schemaObject
 */
export type ScheduleValueSchema =
  | { cron: string; timeZone: string }
  | { every: { unit: ScheduleIntervalUnit; count: number }; timeZone: string };

/**
 * Cinder-specific schema surface for ScheduleBuilder.
 *
 * The `onValueChange` and `computeNextFires` props are documented but
 * unsupported by JSON Schema because functions cannot be modeled.
 */
export type ScheduleBuilderSchemaProps = {
  /**
   * The current recurrence value (controlled). When omitted, the component
   * starts from every day at 9:00 AM (`0 9 * * *`) in the browser's time zone.
   * @schemaObject
   */
  value?: ScheduleValueSchema | undefined;
  /**
   * How many upcoming fires to request from `computeNextFires`. Defaults to 5.
   */
  previewCount?: number | undefined;
  /**
   * The time zones the Time zone field offers. Defaults to every zone the runtime knows.
   */
  timeZones?: readonly string[] | undefined;
  /** Accessible label for the whole control. Defaults to "Schedule". */
  label?: string | undefined;
  /** Additional CSS classes applied to the root element. */
  class?: string | undefined;
};
