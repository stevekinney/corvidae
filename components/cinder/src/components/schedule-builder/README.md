# ScheduleBuilder

A recurrence-definition control that reads a schedule the way a person says it: **Repeats** (Every day, Weekdays, Weekends, Custom days, Monthly on a day, Every few minutes or hours, or Custom cron as the escape hatch), **At** (a time of day, hidden for an interval), and **Time zone** (a searchable list of IANA zones, defaulting to the browser's). The schedule is read back as a sentence, such as "Weekdays at 9:00 AM Pacific Time".

The emitted value is either `{ cron, timeZone }` or, for Every few minutes or hours, `{ every: { unit, count }, timeZone }`. An interval counts from the schedule's start, matching the duration form Weft's and the Bureau's `schedules.create` take, so an uneven interval such as every 7 hours is exact; a cron step would restart at midnight.

`ScheduleBuilder` ships no date, cron-parsing, or scheduling library. The "next runs" preview is entirely consumer-supplied via `computeNextFires`, and the preview section is not rendered at all when that prop is omitted. Scope is recurrence only — overlap policy, jitter, and backfill belong to the consumer's surrounding form.

## Usage

```svelte
<script lang="ts">
  import { ScheduleBuilder } from '@lostgradient/cinder';
  import type { ScheduleFire, ScheduleValue } from '@lostgradient/cinder';

  let value = $state<ScheduleValue>({ cron: '0 9 * * 1-5', timeZone: 'America/Los_Angeles' });

  // Cinder ships no date math — bring your own cron library here.
  // Labels are illustrative; a real implementation would compute actual fire times.
  function computeNextFires(current: ScheduleValue, count: number): ScheduleFire[] {
    return Array.from({ length: count }, (_, index) => ({
      id: `fire-${index}`,
      label:
        'every' in current
          ? `In ${(index + 1) * current.every.count} ${current.every.unit}`
          : `Next occurrence ${index + 1}`,
    }));
  }
</script>

<ScheduleBuilder
  {value}
  onValueChange={(next) => (value = next)}
  {computeNextFires}
  label="Job schedule"
/>
```

## Repeats

| Choice                     | Fields                      | Emits                        |
| -------------------------- | --------------------------- | ---------------------------- |
| Every day                  | At                          | `M H * * *`                  |
| Weekdays                   | At                          | `M H * * 1-5`                |
| Weekends                   | At                          | `M H * * 0,6`                |
| Custom days                | A day group, At             | `M H * * 1,3,5`              |
| Monthly on a day           | Day of month, At            | `M H D * *`                  |
| Every few minutes or hours | Every, Unit                 | `{ every: { unit, count } }` |
| Custom cron                | Five structured cron fields | the expression               |

A value reopens as the choice that produces it, so `0 9 * * 1,2,3,4,5` opens as Weekdays and `30 14 * * 2,4` as Custom days. A cron no choice produces, such as a step like `0 */6 * * *`, opens as Custom cron. Switching choices keeps what was chosen: Custom days starts from the days the previous choice ran on, and Custom cron from the expression it lowered to. An invalid custom cron is not emitted.

An omitted `value` opens on every day at 9:00 AM in the browser's time zone. The time zone list defaults to every zone the runtime knows; pass `timeZones` to offer fewer. The value's own zone is always offered.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional CSS classes applied to the root element. |
| `label` | `string` | no | — | Accessible label for the whole control. Defaults to "Schedule". |
| `previewCount` | `integer` | no | — | How many upcoming fires to request from `computeNextFires`. Defaults to 5. |
| `timeZones` | `string`[] | no | — | The time zones the Time zone field offers. Defaults to every zone the runtime knows. |
| `value` | { cron: `string`; timeZone: `string` } \| { every: { count: `number`; unit: `"minutes"` \| `"hours"` }; timeZone: `string` } | no | — | The current recurrence value (controlled). When omitted, the component starts from every day at 9:00 AM (`0 9 * * *`) in the browser's time zone. |
| `computeNextFires` | `(opaque)` | no | — | Injected next-fires computation. The component passes the current value and the requested count and renders whatever fires the consumer returns. When omitted, the preview list is hidden (the component ships no date logic). Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | Called whenever the user edits the recurrence. Receives the next {@link ScheduleValue}; an invalid custom cron is not emitted. The consumer owns persistence. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
