# WeekSchedule

<!-- generated:a11y-record:required -->

`WeekSchedule` displays a recurring week as one row per day: a 56px day column, a time range and a description. Today's row carries a tonal fill and a stronger day name and is announced as the current date. A live window carries an inverted "On now" pill, with no accent colour. A time range never breaks across lines, and a window that ends after midnight says "next day" after its end time.

It only displays a schedule. To edit one, use `ScheduleBuilder`.

## Usage

```svelte
<script lang="ts">
  import { WeekSchedule } from '@lostgradient/cinder';
</script>

<WeekSchedule
  label="Happy hour"
  days={[
    { day: 'Mon', start: '2:00 pm', end: '8:00 pm', description: 'Half-price wells' },
    { day: 'Fri', start: '10:00 pm', end: '2:00 am', endsNextDay: true, today: true },
  ]}
/>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-week-schedule`. |
| `label` | `string` | no | — | Accessible name of the list, such as "Weekly schedule". Left unset, the list is unnamed. |
| `liveLabel` | `string` | no | — | Text of the live pill. Defaults to "On now". |
| `days` | `(opaque)` | yes | — | The days in reading order, one row each. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
