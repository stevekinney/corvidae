# Steps

Step indicator for multi-step wizards and onboarding flows, a first-run checklist whose steps complete in any order, and a status list for the progress of a short job.

## Usage

```svelte
<script lang="ts">
  import { Steps } from '@lostgradient/cinder';
  import type { StepItem } from '@lostgradient/cinder';

  const steps: StepItem[] = [
    { id: 'account', label: 'Account' },
    { id: 'profile', label: 'Profile' },
    { id: 'review', label: 'Review' },
  ];
</script>

<Steps {steps} currentStep={0} label="Onboarding" />
```

## Checklist

`variant="checklist"` is a bordered card of rows for a first-run list. Steps complete in any order, so there is no `currentStep`: mark a step finished with `done`, and the current step is the first one that isn't. The `heading` sits at the start of the header row, and the counter ("0 of 3 done") at the end, which `progressLabel` can reword. Each step can carry an `action` snippet that receives the step's state, so the current step gets the primary button and the others a secondary one. A done step passes no action and swaps its description to say what happened.

```svelte
<script lang="ts">
  import { Button, Steps } from '@lostgradient/cinder';
  import type { StepItem } from '@lostgradient/cinder';

  const steps: StepItem[] = [
    {
      id: 'provider',
      label: 'Connect a provider',
      description: 'Agents need a model provider before they can answer.',
      action: provider,
    },
    {
      id: 'agent',
      label: 'Create an agent, or start from Assistant',
      description: 'Assistant works now; other agents need a provider.',
      action: agent,
    },
    {
      id: 'hello',
      label: 'Say hello',
      description: 'Send a first message to see a chat run end to end.',
      action: hello,
    },
  ];
</script>

{#snippet provider(state)}
  <Button variant={state === 'current' ? 'primary' : 'secondary'} label="Connect a provider" />
{/snippet}
{#snippet agent()}
  <Button variant="secondary" label="Create an agent" />
{/snippet}
{#snippet hello()}
  <Button variant="secondary" label="Start a chat" />
{/snippet}

<Steps {steps} variant="checklist" heading="Get started" />
```

The root is a `<section>` named by the heading rather than a navigation landmark, because a checklist's actions do their own navigating. On a narrow container the action drops under the text.

## Status list

`variant="status"` is a borderless list of progress by step, such as a restart's "Saved your choice, Stopped the server, Starting Interborough, Checking plugins". Mark finished steps with `done`; the first step that isn't done is the one running. Each row shows a green check, a spinner or a hollow circle, and the list is a `role="status"` region, so a change is announced. The state is also written out for assistive technology: `completedLabel`, `currentLabel` ("In progress") and `pendingLabel` ("Pending") are read before each label.

```svelte
<script lang="ts">
  import { Steps } from '@lostgradient/cinder';
  import type { StepItem } from '@lostgradient/cinder';

  const steps: StepItem[] = [
    { id: 'saved', label: 'Saved your choice', done: true },
    { id: 'stopped', label: 'Stopped the server', done: true },
    { id: 'starting', label: 'Starting Interborough' },
    { id: 'plugins', label: 'Checking plugins' },
  ];
</script>

<Steps {steps} variant="status" label="Restart progress" />
```

## Interactive steps

A step is static text by default. Give a `StepItem` an `href` or an `onclick` and its body (label + description) becomes a focusable control — an `<a>` for `href`, a `<button>` for `onclick`. The marker circle and the connector line stay decorative, so only the body region is clickable and the marker never joins the accessible name.

```svelte
<script lang="ts">
  const steps = [
    { id: 'account', label: 'Account', href: '#account' },
    { id: 'profile', label: 'Profile', onclick: () => goToProfile() },
    { id: 'review', label: 'Review' }, // plain, non-interactive
  ];
</script>
```

When a step has both `href` and `onclick`, it renders as a link and still runs the callback on click — the consumer decides whether to `preventDefault` (for SPA routing interception, analytics, or confirmation). For the current step, `aria-current="step"` moves onto the interactive element; static steps keep it on the list item.

## Skipped steps

By default, state is derived from `currentStep`: earlier steps are complete, the matching index is current, and later steps are upcoming. Set `state: 'skipped'` on a `StepItem` when a flow advances past a step without completing it. Skipped steps keep their numeric marker, use neutral styling, and announce the `skippedLabel` text instead of the completed label.

```svelte
<script lang="ts">
  const steps = [
    { id: 'account', label: 'Account' },
    { id: 'profile', label: 'Profile', state: 'skipped' },
    { id: 'review', label: 'Review' },
  ];
</script>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-steps`. |
| `completedLabel` | `string` | no | `"Completed"` | Visually-hidden text prepended to completed steps so screen readers announce state + label. Defaults to 'Completed'. |
| `currentLabel` | `string` | no | `"In progress"` | Visually-hidden text announced for the step in progress in the `'status'` variant. |
| `currentStep` | `number` | no | `0` | Zero-based index of the active step in the `'stepper'` variant. Steps with index < currentStep are "completed". Pass `steps.length` to mark every step as complete (terminal "done" state). The `'checklist'` and `'status'` variants ignore it and read each step's `done` instead. |
| `heading` | `string` | no | — | Title of the `'checklist'` card, such as "Get started". It sits at the start of the card's header row, with the counter at the end, and names the section. |
| `headingLevel` | `1` \| `2` \| `3` \| `4` \| `5` \| `6` | no | `3` | Heading level for `heading`. |
| `label` | `string` | no | `"Progress"` | Accessible name for the wrapper: the nav landmark of the `'stepper'`, the status region of the `'status'` variant, and the section of a `'checklist'` that has no `heading`. Defaults to 'Progress'. |
| `orientation` | `"horizontal"` \| `"vertical"` | no | `"horizontal"` | Layout direction of the `'stepper'` variant. The `'checklist'` and `'status'` variants are always vertical. Defaults to 'horizontal'. |
| `pendingLabel` | `string` | no | `"Pending"` | Visually-hidden text announced for a step that hasn't started in the `'status'` variant. |
| `skippedLabel` | `string` | no | `"Skipped"` | Visually-hidden text prepended to skipped steps so screen readers announce state + label. Defaults to 'Skipped'. |
| `variant` | `"stepper"` \| `"checklist"` \| `"status"` | no | `"stepper"` | Which list the steps render as: `'stepper'` is the ordered wizard indicator, `'checklist'` is a card of rows that each carry an action, and `'status'` is a list of progress by step. |
| `progressLabel` | `(opaque)` | no | — | Text of the counter at the end of the `'checklist'` header, from how many steps are done and how many there are. Defaults to "N of M done". Not expressible in JSON Schema; see the component types for the signature. |
| `steps` | `(opaque)` | yes | — | Ordered list of step entries from first to last. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
