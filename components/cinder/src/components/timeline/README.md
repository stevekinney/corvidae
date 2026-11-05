# Timeline

Timestamp-first event rail for workflow events, audit logs, run histories, and grouped temporal sequences. Timeline is not a live region; use `Feed` for streaming activity that should be announced to assistive technology.

See the [chronological display boundary decision](https://github.com/stevekinney/cinder/blob/main/docs/decisions/chronological-display-boundaries.md) for the distinction between Timeline, RunStepTimeline, and Feed.

## Usage

```svelte
<script lang="ts">
  import { Timeline } from '@lostgradient/cinder';
  import type { TimelineEntry } from '@lostgradient/cinder';

  const entries: TimelineEntry[] = [
    {
      id: 'created',
      datetime: '2026-05-23T10:00:00Z',
      timestamp: '10:00',
      title: 'Workflow started',
      tone: 'info',
    },
    {
      id: 'completed',
      datetime: '2026-05-23T10:30:00Z',
      timestamp: '10:30',
      title: 'Workflow completed',
      tone: 'success',
    },
  ];
</script>

<Timeline {entries} label="Workflow timeline">
  {#snippet children(entry)}
    {entry.title}
  {/snippet}
</Timeline>
```

### Upcoming and past runs, around Now

`variant="list"` draws the same entries as compact rows: no connector, a hairline between rows, the time first. `variant="rows"` keeps the rail's marker column and connector but draws nothing else of an entry: no timestamp, no title and no body wrapper, only the `marker` and whatever the `children` snippet draws, for a sequence with nothing to date (the tool calls of one chat turn, which `ToolCallRail` draws this way). Its `datetime` and `timestamp` are not read and may be empty. A row is about 1.625rem tall; taller rows move the marker with `--cinder-timeline-row-marker-offset` and the entries with `--cinder-timeline-row-gap`, and the connector follows both. The `pending` tone is a hollow neutral ring for something that has not happened yet. `kind: 'now'` is the marker for the current moment (an accent pill from `title`, a rule, and `timestamp` at the right), and `kind: 'separator'` is a quiet labelled rule, such as the day daylight saving time ended. Neither draws a marker, a connector, a body or actions. `kind: 'band'` is one collapsed group row (the stacked-list-item band: a status dot, a chevron, `title`, muted `detail` and a toggle labelled `expandLabel`, "Show each" for the missed runs); `tone: 'warning'` makes it amber, and the entry's `children` are the details it opens. The `actions` snippet draws controls at the end of an event's row; unlike `marker`, they are interactive.

```svelte
<script lang="ts">
  import { Button, Timeline } from '@lostgradient/cinder';
  import type { TimelineEntry } from '@lostgradient/cinder';

  const entries: TimelineEntry[] = [
    {
      id: 'nov-3',
      datetime: '2026-11-03T09:00:00Z',
      timestamp: 'Tue Nov 3, 3:00 AM',
      title: 'in 16 hours',
      tone: 'pending',
    },
    {
      id: 'now',
      kind: 'now',
      datetime: '2026-11-02T16:46:00Z',
      timestamp: 'Mon Nov 2, 10:46 AM',
      title: 'Now',
    },
    {
      id: 'dst',
      kind: 'separator',
      datetime: '2026-11-01T06:00:00Z',
      timestamp: 'Nov 1',
      title: 'Daylight saving time ended Nov 1',
    },
    {
      id: 'oct-29',
      datetime: '2026-10-29T09:00:00Z',
      timestamp: 'Thu Oct 29, 4:00 AM',
      title: 'Done',
      tone: 'success',
    },
  ];
</script>

<Timeline {entries} variant="list" label="Runs">
  {#snippet actions(entry)}
    {#if entry.tone === 'pending'}
      <Button variant="secondary" size="sm">Skip</Button>
    {/if}
  {/snippet}
</Timeline>
```

Marker snippets are decorative. Do not place focusable or interactive content inside `marker`; the marker wrapper is hidden from assistive technology and marked inert.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-timeline`. |
| `entries` | ({ collapseLabel?: `string`; datetime: `string`; detail?: `string`; expandLabel?: `string`; groupLabel?: `string`; id: `string`; kind?: `"event"` \| `"now"` \| `"separator"` \| `"band"`; timestamp: `string`; title: `string`; tone?: `"info"` \| `"success"` \| `"warning"` \| `"error"` \| `"pending"` })[] | yes | — | Timeline entries rendered in source order. |
| `gapThresholdMinutes` | `number` | no | — | Hide the following connector when adjacent valid timestamps exceed this gap (in minutes). |
| `groupBy` | `"none"` \| `"day"` \| `"week"` | no | `"none"` | Optional adjacent UTC day/week grouping mode. |
| `groupHeaderLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `3` | Heading level applied to rendered group headers. |
| `label` | `string` | no | — | Fallback accessible label used only when aria-label and aria-labelledby are absent. |
| `orientation` | `"vertical"` \| `"horizontal"` | no | `"vertical"` | Layout orientation. |
| `variant` | `"rail"` \| `"list"` \| `"rows"` | no | `"rail"` | Rail with connectors, compact rows with none, or a rail whose rows `children` draws whole. |
| `weekStartsOn` | `"sunday"` \| `"monday"` | no | `"monday"` | Week start used for UTC week grouping. |
| `actions` | `(opaque)` | no | — | Optional per-entry controls, drawn at the inline end of the entry's row (a "Skip" button on an upcoming run). Unlike `marker`, they are interactive and in the tab order. Not drawn for a `now` or `separator` entry. Not expressible in JSON Schema; see the component types for the signature. |
| `children` | `(opaque)` | no | — | Optional per-entry body content. Not expressible in JSON Schema; see the component types for the signature. |
| `marker` | `(opaque)` | no | — | Decorative per-entry marker content. Must not contain interactive descendants. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

- `TimelineItem` — one event entry on the rail.

<!-- generated:subcomponents:end -->
