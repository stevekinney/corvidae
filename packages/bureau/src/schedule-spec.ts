/**
 * How a schedule's `spec` string becomes a Weft schedule spec. Shared by Bureau's durable schedules
 * (`DurableScheduleDefinition.spec`) and the `schedule` trigger of a workflow file (COR-1527), so
 * both accept exactly the same text.
 *
 * @module schedule-spec
 */

import type { ScheduleSpec } from '@lostgradient/weft';

/**
 * The exact duration grammar weft's `parseDuration` accepts: a number (optionally
 * fractional, optionally space-separated from the unit) followed by a unit, where
 * the unit is `ms`/`s`/`m`/`h`/`d` or its full word (`seconds`, `minutes`, …).
 * Kept in lockstep with weft so we never route a string weft would accept as an
 * interval into the cron branch (and vice-versa). Note: weft does NOT support
 * weeks or ISO-8601 (`PT6H`) durations.
 */
const WEFT_DURATION =
  /^\d+(?:\.\d+)?\s*(?:ms|milliseconds?|s|seconds?|m|minutes?|h|hours?|d|days?)$/i;

/**
 * Normalize a {@link DurableScheduleDefinition.spec} string into a weft
 * {@link ScheduleSpec}. Weft parses a BARE string as a cron expression
 * (`normalizeCronSpec`), so a duration like `'6h'` must be wrapped as `{ every }`
 * or it would be misparsed as cron. A string matching weft's duration grammar →
 * interval; everything else (cron expression, `@macro`) → cron.
 */
export function toScheduleSpec(spec: string): ScheduleSpec {
  const trimmed = spec.trim();
  if (WEFT_DURATION.test(trimmed)) {
    return { every: trimmed };
  }
  return { cron: trimmed };
}
