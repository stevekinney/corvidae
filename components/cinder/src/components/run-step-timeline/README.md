# RunStepTimeline

Ordered step-by-step execution rail for async operations. Shows pending, running, waiting, waiting approval, succeeded, failed, timed-out, canceled, skipped, and retrying states with per-step durations, attempt counts, action counts, optional progress indicators, nested child-workflow lanes, links, and expandable inline detail panels for logs, payloads, and errors.

Use `RunStepTimeline` for CI jobs, workflow engine runs, import pipelines, deployment flows, and queue workers. Use `Timeline` for timestamp-first event logs. Use `Steps` for interactive wizard navigation.

See the [chronological display boundary decision](https://github.com/stevekinney/cinder/blob/main/docs/decisions/chronological-display-boundaries.md) for the distinction between execution state, event history, schedules, activity feeds, and operational streams.

## Overview

`RunStepTimeline` takes a `steps` array and renders an ordered list. Each step shows:

- A status dot on the rail (color-coded by state, decorative and hidden from assistive technology)
- A status badge (text label so state is not communicated by color alone)
- Start time, end time, and duration when available
- An attempt count badge when the step has been retried
- An action count badge when actions are available
- An optional link rendered with `Link`
- A progress bar for `running`, `retrying`, or `waiting_approval` steps with a known `progress` value
- Indented child-workflow lanes from recursive `children`
- Expandable Collapsible panels for logs, payloads, and errors via the `details` array

The component marks the currently active step with `aria-current="step"`. `running`, `retrying`, and `waiting_approval` are current, non-terminal states.

## Usage

```svelte
<script lang="ts">
  import { RunStepTimeline } from '@lostgradient/cinder';
  import type { RunStep } from '@lostgradient/cinder';

  const steps: RunStep[] = [
    {
      id: 'validate',
      label: 'Validate configuration',
      status: 'succeeded',
      startTime: '2026-06-01T11:00:00Z',
      endTime: '2026-06-01T11:01:30Z',
      duration: '1m 30s',
    },
    {
      id: 'build',
      label: 'Build Docker image',
      status: 'running',
      startTime: '2026-06-01T11:02:00Z',
      progress: 40,
      link: {
        href: '/runs/run-123/build',
        label: 'Open logs',
      },
    },
    {
      id: 'deploy',
      label: 'Deploy to staging',
      status: 'pending',
    },
  ];
</script>

<RunStepTimeline {steps} label="Deployment run" />
```

### With expandable details

```svelte
<RunStepTimeline {steps} label="CI run">
  {#snippet children(step)}
    {#if step.status === 'failed'}
      <p>Contact the platform team if this persists.</p>
    {/if}
  {/snippet}
</RunStepTimeline>
```

### With inline detail panels

```svelte
<script lang="ts">
  import type { RunStep } from '@lostgradient/cinder';

  const steps: RunStep[] = [
    {
      id: 'test',
      label: 'Run unit tests',
      status: 'failed',
      duration: '5m 0s',
      attemptCount: 2,
      details: [
        {
          id: 'test-error-log',
          label: 'Error output',
          type: 'text',
          content: 'AssertionError: expected 1 to equal 2\n  at src/math.test.ts:12',
        },
        {
          id: 'test-env',
          label: 'Environment',
          type: 'text',
          content: 'NODE_ENV=test\nCI=true',
        },
      ],
    },
  ];
</script>
```

### With nested child-workflow lanes

```svelte
<script lang="ts">
  import type { RunStep } from '@lostgradient/cinder';

  const steps: RunStep[] = [
    {
      id: 'workflow',
      label: 'Workflow',
      status: 'running',
      children: [
        {
          id: 'tool',
          label: 'Run repository tool',
          status: 'succeeded',
          actionsCount: 2,
        },
        {
          id: 'approval',
          label: 'Await approval',
          status: 'waiting_approval',
        },
      ],
    },
  ];
</script>
```

### Branch / coordination groups

A top-level entry can be a branch group instead of a step. A branch group fans out into N parallel sub-lanes, each a sequence of steps with an optional `outcome` (`won` / `lost` / `settled`). The winning lane is emphasized, losers are muted, and the group is collapsible (collapsed by default once the lane count reaches `collapseThreshold`, default 3). Branch groups are opt-in via the `kind: 'branch'` discriminator, so existing `RunStep[]` arrays keep working unchanged — widen your array type to `RunStepTimelineEntry[]` to mix them in.

```svelte
<script lang="ts">
  import type { RunStepTimelineEntry } from '@lostgradient/cinder';

  const steps: RunStepTimelineEntry[] = [
    { id: 'plan', label: 'Plan rollout', status: 'succeeded' },
    {
      kind: 'branch',
      id: 'race',
      label: 'Race deploy candidates',
      lanes: [
        {
          id: 'blue',
          label: 'Blue',
          outcome: 'won',
          steps: [{ id: 'b', label: 'Deploy blue', status: 'succeeded' }],
        },
        {
          id: 'green',
          label: 'Green',
          outcome: 'lost',
          steps: [{ id: 'g', label: 'Deploy green', status: 'cancelled' }],
        },
      ],
    },
  ];
</script>
```

### Rewound and compensated steps

Set `rewound: true` on a step that was speculatively executed and then unwound. It renders struck-through and de-emphasized (and announces its rewound state as text) while staying inspectable. Set `compensates: '<forward-step-id>'` on a step that reverses an earlier forward step, as in a saga rollback; the compensating step keeps its own place in execution order and renders inset with a dashed reversal connector and a `Compensates <label>` badge that names the forward step it reverses. The `compensates` id must reference a sibling step (one under the same parent); an unresolved id renders the step in place without the badge.

### Telling a run's story

`variant="narrative"` reads the same steps as a story for someone who wants to know what happened, as on a run page's "What happened". Each step is a drawn marker, the label with a short `time` at its end, and one muted `description`; there are no status chips and no metadata lists, though the status word is still read aloud. Text between backticks in a `description` renders as inline code.

A step that is under way (`running`) draws a ring, `now` as its time, and may carry a `note` that is `streaming`: an open block with a bold title and the lines so far, followed by a text cursor, so the entry reads as partial and growing. Steps that have not started (`pending`) and steps that never ran (`skipped`) draw a dashed ring. A failure (`failed`) draws a red cross, and a `note` with `tone: 'danger'` opens its cause under it. A run blocked on an external signal ends in an open ring (`waiting`), and an event with no outcome of its own, such as the start, is `recorded`.

```svelte
<script lang="ts">
  import { RunStepTimeline, StatusDot } from '@lostgradient/cinder';
  import type { RunStep } from '@lostgradient/cinder';

  const steps: RunStep[] = [
    {
      id: 'started',
      label: 'Started',
      status: 'recorded',
      time: '10:45:20 AM',
      description: 'You started Release notes from the run page',
    },
    {
      id: 'find',
      label: 'Step 1 · Find the last release',
      status: 'succeeded',
      time: '+1.2 s',
      description: 'Found the last release, 1.4.2, on Oct 23',
    },
    {
      id: 'collect',
      label: 'Step 2 · Collect merged changes',
      status: 'running',
      time: 'now',
      description:
        'Reading merged pull requests from GitHub. Streaming, so this entry is partial and grows.',
      note: {
        title: 'Merged since Oct 23, so far',
        lines: ['Fixes the refund total when an order has a promo code'],
        streaming: true,
      },
    },
    {
      id: 'draft',
      label: 'Step 3 · Draft the notes',
      status: 'pending',
      description: 'Waits for step 2',
    },
    {
      id: 'approve',
      label: 'Step 4 · Wait for approval',
      status: 'pending',
      description: 'Waits for step 3. Resumes on the signal `notes-approved`.',
    },
  ];
</script>

<StatusDot word="Live · last event 1 s ago" />
<RunStepTimeline {steps} variant="narrative" label="What happened" />
```

The line above the timeline is a `StatusDot` word, not part of the list: `word="Live · last event 1 s ago"` while the stream is open, and `word="Reconnecting…"` with `label="Reconnecting… last event 40 s ago"` (a hollow ring) while it has dropped. A step whose entry may be behind shows how stale it is as its `time` ("last update 40 s ago").

## Step states

`RunStepStatus` is intentionally domain-agnostic. Map your domain state onto one of these:

- `pending` — not yet started
- `running` — currently executing within its lane
- `waiting_approval` — paused on required approval and expected to continue
- `succeeded` — completed successfully
- `failed` — completed with a terminal error
- `timed-out` — exceeded its allowed execution time
- `cancelled` — stopped before it could complete
- `skipped` — bypassed intentionally
- `retrying` — a prior attempt ended unsuccessfully; a new attempt is in progress
- `waiting` — paused on something that is not a person's approval, such as an external signal
- `recorded` — an event with no outcome of its own, such as the run's start or end

Map engine-specific deadline states such as `timed_out`, `timeout`, or `deadline_exceeded` to `timed-out`. Keep other terminal errors mapped to `failed` so consumers can present deadline expiry distinctly without introducing product-specific status vocabulary.

## Props

### RunStepTimeline props

```
steps      RunStep[]          required  Ordered list of steps to render.
label      string             optional  Accessible label for the list (aria-label).
selectedStepId string | null  optional  Step id to visually mark as selected.
onStepSelect (stepId) => void optional  Fired when a rendered step row is clicked.
variant    "detailed" | "narrative" optional  How a step reads. Defaults to "detailed".
class      string             optional  Additional CSS classes on the root ol element.
children   Snippet<[RunStep]> optional  Per-step body content rendered after step metadata.
```

### RunStep shape

```
id           string           required  Stable identity for keyed reconciliation.
label        string           required  Display label shown in the step header.
status       RunStepStatus    required  Generic execution state.
startTime    string           optional  ISO datetime when the step started.
endTime      string           optional  ISO datetime when the step ended.
duration     string           optional  Human-readable duration string, e.g. "1m 23s".
attemptCount number           optional  Total attempts made; badge shown when greater than 1.
actionsCount number           optional  Total associated actions; badge shown when greater than 0.
progress     number           optional  Determinate progress value (0 to progressMax).
progressMax  number           optional  Upper bound for progress. Defaults to 100.
details      RunStepDetail[]  optional  Expandable inline panels for logs, payloads, errors.
link         RunStepLink      optional  Link rendered in the step header.
description  string           optional  One muted line under the label; `code` between backticks renders as code.
time         string           optional  Short time label at the end of the label line, formatted by the caller.
note         RunStepNote      optional  A block shown open under the description.
children     RunStep[]        optional  Nested child-workflow steps rendered as indented lanes.
```

### RunStepDetail shape

```
id       string              required  Stable identity for this detail panel.
label    string              required  Trigger label on the Collapsible header.
type     "text" | "code"  required  Selects the detail renderer.
content  string              required for text details. Pre-formatted content shown inside the panel.
code     string              required for code details. CodeBlock content shown inside the panel.
language string              optional  CodeBlock language for code details.
languageLabelVisible boolean optional  Whether the CodeBlock language label is visible.
```

### RunStepNote shape

```
title     string                  optional  Bold first line of the block.
lines     string[]                required  The lines of the block, one per line.
tone      "neutral" | "danger"    optional  Danger tints the block for a failure. Defaults to neutral.
streaming boolean                 optional  Follows the last line with a text cursor while lines are still arriving.
```

### RunStepLink shape

```
href   string  required  Destination URL for the step link.
label  string  required  Visible link text.
```

## Accessibility

`RunStepTimeline` renders an `ol` (ordered list) because steps are numbered and sequential. The list takes an accessible name via `label` (used as `aria-label` when neither `aria-label` nor `aria-labelledby` is provided directly).

The active step (`running`, `retrying`, or `waiting_approval`) receives `aria-current="step"` on its `li` element, matching the same pattern used by the `Steps` component. This allows assistive technology to identify which step is current without requiring a live region announcement.

Status dots on the rail are decorative: the marker element is marked `aria-hidden="true"` and `inert`. The status badge rendered as text includes an accessible label such as "Status: Waiting approval", so the step state is communicated to assistive technology through text, not color alone (WCAG 1.4.1).

Progress bars include an `aria-label` derived from the step label (e.g. "Build Docker image progress"), satisfying the ARIA progressbar accessible name requirement.

Expandable detail panels use `Collapsible` which implements the disclosure button pattern with `aria-expanded` and `aria-controls` wiring.
