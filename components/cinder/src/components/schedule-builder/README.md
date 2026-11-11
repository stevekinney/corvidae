# ScheduleBuilder

A recurrence-definition control that reads a schedule the way a person says it: **Repeats** (Every day, Weekdays, Weekends, Custom days, Monthly on a day, Every few minutes or hours, or Custom cron as the escape hatch), **At** (a time of day, hidden for an interval), and **Time zone** (a searchable list of IANA zones, defaulting to the browser's). The schedule is read back in a Runs panel as a sentence, such as "Weekdays at 9:00 AM Pacific time.", above the next runs.

The emitted value is either `{ cron, timeZone }` or, for Every few minutes or hours, `{ every: { unit, count }, timeZone }`. An interval counts from the schedule's start, matching the duration form Weft's and the Bureau's `schedules.create` take, so an uneven interval such as every 7 hours is exact; a cron step would restart at midnight.

`ScheduleBuilder` ships no date, cron-parsing, or scheduling library. The "next runs" preview is entirely consumer-supplied via `computeNextFires`, and the preview section is not rendered at all when that prop is omitted. Scope is recurrence, plus two optional policy selects whose values the consumer owns (see "Policies"). Jitter and backfill windows belong to the consumer's surrounding form.

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

| Choice                     | Fields                    | Emits                        |
| -------------------------- | ------------------------- | ---------------------------- |
| Every day                  | At                        | `M H * * *`                  |
| Weekdays                   | At                        | `M H * * 1-5`                |
| Weekends                   | At                        | `M H * * 0,6`                |
| Custom days                | A joined day group, At    | `M H * * 1,3,5`              |
| Monthly on a day           | Day of month, At          | `M H D * *`                  |
| Every few minutes or hours | Every, Unit               | `{ every: { unit, count } }` |
| Custom cron                | Five labelled cron fields | the expression               |

A value reopens as the choice that produces it, so `0 9 * * 1,2,3,4,5` opens as Weekdays and `30 14 * * 2,4` as Custom days. A cron no choice produces, such as a step like `0 */6 * * *`, opens as Custom cron. Switching choices keeps what was chosen: Custom days starts from the days the previous choice ran on, and Custom cron from the expression it lowered to. An invalid custom cron is not emitted.

Custom cron is five plain, labelled fields (Minute, Hour, Day of month, Month, Day of week) in one row, each with its range beneath. A field that needs fixing turns red and one message at the fields says which and how ("Day of week must be 0 to 6 (0 is Sunday). Cron uses minute, hour, day of month, month and day of week."); the Runs panel then reads "No preview until the cron expression is valid." and lists no next runs.

An interval has no time zone, because it counts from when it starts: At and Time zone are hidden and a line says so.

An omitted `value` opens on every day at 9:00 AM in the browser's time zone. The time zone list defaults to every zone the runtime knows; pass `timeZones` to offer fewer. The value's own zone is always offered.

## Time zone

Time zone is a searchable picker over every zone the runtime knows. Each row reads the zone's sentence-case name and its city ("Central time, Chicago") with its offset at the trailing edge ("UTC−6"); the chosen zone leads, then the common zones, and the footer counts what is shown ("Showing 5 of 418 zones. Type to narrow."). Typing searches every zone by name, city or IANA id.

## Policies

Pass `overlap` to draw the select for what happens when a run is still going as the next is due, and `catchUp` to draw the select for what happens to occurrences missed while the app was off. Each is drawn only when its value is set, as two plain bordered selects sharing a row below the Runs panel, and each reports through `onOverlapChange` and `onCatchUpChange`. The values are not part of `ScheduleValue`: the builder only draws and reports them. `overlapOptions` replaces the default choices (`skip`, `allow`), `catchUpOptionLabels` the words of the two catch-up choices, and `overlapLabel` and `catchUpLabel` the labels, which is where the product is named ("If Interborough was off").

```svelte
<ScheduleBuilder
  {value}
  onValueChange={(next) => (value = next)}
  {computeNextFires}
  {overlap}
  onOverlapChange={(next) => (overlap = next)}
  {catchUp}
  onCatchUpChange={(next) => (catchUp = next)}
  catchUpLabel="If Interborough was off"
/>
```

## Variants

`variant="compact"` fits a form that already says what runs, such as a workflow's trigger: Repeats, At and Time zone share one row (the closed Time zone field shows the zone's name alone, "Central time"), the policy selects follow, and Next runs is a plain list with no Runs sentence and no panel.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `catchUp` | `boolean` | no | — | Whether to catch up on occurrences missed while the app was off. The select is drawn only when this is set. |
| `catchUpLabel` | `string` | no | `"If the app was off"` | Label of the catch-up select. |
| `class` | `string` | no | — | Additional CSS classes applied to the root element. |
| `label` | `string` | no | — | Accessible label for the whole control. Defaults to "Schedule". |
| `overlap` | `string` | no | — | The chosen overlap policy. The overlap select is drawn only when this is set. |
| `overlapLabel` | `string` | no | `"If a run is still going"` | Label of the overlap select. |
| `previewCount` | `integer` | no | — | How many upcoming fires to request from `computeNextFires`. Defaults to 5. |
| `timeZones` | `string`[] | no | — | The time zones the Time zone field offers. Defaults to every zone the runtime knows. |
| `value` | { cron: `string`; timeZone: `string` } \| { every: { count: `integer`; unit: `"minutes"` \| `"hours"` }; timeZone: `string` } | no | — | The current recurrence value (controlled). When omitted, the component starts from every day at 9:00 AM (`0 9 * * *`) in the browser's time zone. |
| `variant` | `"default"` \| `"compact"` | no | `"default"` | How the block is laid out: the full block with a Runs panel (`default`), or one row of fields and a plain Next runs list (`compact`). |
| `catchUpOptionLabels` | `(opaque)` | no | — | The words of the catch-up select's two choices. Not expressible in JSON Schema; see the component types for the signature. |
| `computeNextFires` | `(opaque)` | no | — | Injected next-fires computation. The component passes the current value and the requested count and renders whatever fires the consumer returns. When omitted, the preview list is hidden (the component ships no date logic). Not expressible in JSON Schema; see the component types for the signature. |
| `onCatchUpChange` | `(opaque)` | no | — | Called with `true` or `false` when the catch-up select changes. Not expressible in JSON Schema; see the component types for the signature. |
| `onOverlapChange` | `(opaque)` | no | — | Called with the picked choice's `value` when the overlap select changes. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | Called whenever the user edits the recurrence. Receives the next {@link ScheduleValue}; an invalid custom cron is not emitted. The consumer owns persistence. Not expressible in JSON Schema; see the component types for the signature. |
| `overlapOptions` | `(opaque)` | no | — | The choices of the overlap select. Defaults to skip and allow. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
