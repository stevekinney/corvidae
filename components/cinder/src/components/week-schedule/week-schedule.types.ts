import type { HTMLAttributes } from 'svelte/elements';

/** One row of a week schedule: a day, the window it runs, and what happens in it. */
export type WeekScheduleDay = {
  /** The day as short text, such as "Mon". It fills the fixed day column. */
  day: string;
  /** When the window starts, as text such as "2:00 pm". */
  start: string;
  /** When the window ends, as text such as "8:00 pm". */
  end: string;
  /** Set when the window ends after midnight, on the following day. The range then reads "next day" after the end time. */
  endsNextDay?: boolean;
  /** What happens in the window, such as "Happy hour". */
  description?: string;
  /** Marks this row as today: it carries a tonal fill and a stronger day name and is announced as the current date. */
  today?: boolean;
  /** Marks the window as running now: an inverted "On now" pill carries the signal instead of colour. */
  live?: boolean;
};

/** Props for the WeekSchedule component. */
export type WeekScheduleProps = Omit<HTMLAttributes<HTMLOListElement>, 'class'> & {
  /** The days in reading order, one row each. */
  days: WeekScheduleDay[];
  /** Accessible name of the list, such as "Weekly schedule". Left unset, the list is unnamed. */
  label?: string;
  /** Text of the live pill. Defaults to "On now". */
  liveLabel?: string;
  /** Custom class merged with `.cinder-week-schedule`. */
  class?: string;
};
