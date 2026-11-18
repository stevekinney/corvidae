# RelativeTime

<!-- generated:a11y-record:required -->

`RelativeTime` renders a localized relative timestamp and can keep it current as time passes.

## Usage

```svelte
<script lang="ts">
  import { RelativeTime } from '@lostgradient/cinder';
</script>

<RelativeTime date="2026-08-28T18:00:00Z" />
```

It reads in the viewer's time zone on one 12-hour clock: "just now", "4 min ago", "1 h ago", then "Yesterday, 4:12 PM" and "Sun Nov 1, 4:12 PM". Set `format="absolute"` for a label that is never relative ("Today, 10:44 AM"); the tooltip then carries the relative reading, and the relative label's tooltip carries the full dated reading. The same formats are exported as functions: `formatRelativeTime`, `formatDateTime`, `formatDayHeading` ("Today, Central time"), `formatTimeZoneLabel` ("CST" or "Central time") and `formatScheduleTime` ("3:00 AM (9:00 AM UTC)").

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-relative-time`. |
| `dayWords` | `false` \| `true` \| `"today"` | no | — | Which days the label may name with a word. `true` says "Today", "Yesterday" and "Tomorrow"; `'today'` says only "Today" and names every other day ("Sun Nov 1, 4:12 PM"); `false` always names the calendar day. Defaults to `'today'` for `format="absolute"` and `true` for `relative`. |
| `format` | `"relative"` \| `"absolute"` | no | — | `relative` reads "4 min ago", "1 h ago", then "Yesterday, 4:12 PM". `absolute` always reads the clock ("Today, 10:44 AM", "Sun Nov 1, 4:12 PM"). The tooltip carries the other reading. |
| `locale` | `string` \| `string`[] | no | — | Locale for the label. Defaults to the surrounding locale context, then the browser's language. |
| `seconds` | `boolean` | no | `false` | Counts the first minute in seconds ("4 s ago", and "just now" before the third second), for a time that is a heartbeat or a pulse, such as a worker last heard from. The label then ticks every second during that minute. Applies to the `relative` format. |
| `tick` | `boolean` | no | — | Recalculate the label on an interval. Set false to disable ticking. |
| `timeZone` | `string` | no | — | IANA time zone the label is read in. Defaults to the viewer's zone. |
| `children` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `date` | `(opaque)` | no | — | The moment to show: a `Date`, an ISO string or epoch milliseconds. Defaults to now. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->

Before publishing this component, complete the live [component authoring pre-flight](../../../README.md#component-authoring-checklist).
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
