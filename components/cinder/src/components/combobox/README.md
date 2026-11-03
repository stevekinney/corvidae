# Combobox

Filterable dropdown that combines a text input with a selectable option list.

## Usage

```svelte
<script lang="ts">
  import { Combobox } from '@lostgradient/cinder';
  const options = [
    { value: 'free', label: 'Free' },
    { value: 'pro', label: 'Pro' },
    { value: 'enterprise', label: 'Enterprise', disabled: true },
  ];
</script>

<Combobox
  id="combobox-disabled"
  label="Plan"
  placeholder="Locked plan selection"
  {options}
  value="pro"
  disabled
/>
```

## Grouped options

Give options a `group` name to render them under headings. Ungrouped options come first without a heading, and groups follow in order of first appearance, even when the groups interleave in `options`. Each heading shows the group name and how many of its options are listed. Typing filters across every group, keeps the headings of groups that still match, and hides the rest; arrow keys move through the options in the order they are displayed.

```svelte
<script lang="ts">
  import { Combobox } from '@lostgradient/cinder';

  const workflows = [
    { value: 'chat', label: 'Chat with an agent', group: 'Built in' },
    { value: 'digest', label: 'Daily digest', group: 'Recent' },
    { value: 'triage', label: 'Triage issues' },
  ];
</script>

<Combobox id="workflow" label="Workflow" options={workflows} />
```

The default filter matches an option's label and description, not its group name. `maxVisibleOptions` counts options in display order.

## Rows with more to say

An option can carry more than a label. `description` is a second line (add `descriptionTone: 'danger'` when it is the reason the row is wrong, such as "Can’t load · order-refund.json line 12"; a `disabled` option stays listed so the reason can be read). `code` is a raw identifier drawn small and monospaced beside the label, `suffix` is muted words on the label's own line after a middle dot ("Chat with an agent · built in"), and `meta` is short text at the trailing edge ("4 steps", "any workflow"). The `optionMeta` snippet replaces `meta` when the trailing content needs more than text. The chosen option is tinted and carries a check, after the text by default or before it with `selectedIndicator="start"`; `groupCountVisible={false}` drops the counts from group headings.

```svelte
<script lang="ts">
  import { Combobox } from '@lostgradient/cinder';

  const events = [
    {
      value: 'run.error',
      label: 'A run fails',
      code: 'run.error',
      meta: 'any workflow',
      group: 'Runs',
    },
    {
      value: 'goal.failed',
      label: 'A goal fails',
      code: 'goal.failed',
      meta: 'any agent',
      group: 'Goals',
    },
  ];
</script>

<Combobox id="event" label="Event" options={events} selectedIndicator="start" />
```

## Picker presentation

`presentation="picker"` draws the closed field as a button that shows the chosen option's name (and its `code`), with its `description` on a second line, and opens a panel with its own search field (`searchPlaceholder`) above the options. Use it when rows need room to read; use the default `input` presentation when typing into the field itself is the point. A picker has no text of its own, so `customValueAllowed` has no effect on it. `matchCountVisible` shows "2 of 16" beside the search field while something is typed.

## Footer

The `footer` snippet draws content under the options, outside the `role="listbox"` element, so it stays visible while the list scrolls and when nothing matches. It receives `{ query, matchCount, totalCount }`. A link or button in it is a keyboard stop of its own: Tab from the field lands on it with the list still open.

```svelte
<script lang="ts">
  import { Combobox } from '@lostgradient/cinder';

  const workflows = [
    { value: 'chat', label: 'Chat with an agent', description: 'Send a message each run.' },
  ];
</script>

<Combobox
  id="workflow"
  label="Workflow"
  presentation="picker"
  placeholder="Pick a workflow"
  searchPlaceholder="Search workflows"
  options={workflows}
  noMatchLabel={(query) => `No workflows match “${query}”.`}
>
  {#snippet footer()}
    No match? <a href="/workflows/new">Create one</a>
  {/snippet}
</Combobox>
```

## Loading and load errors

`loading` keeps the field a combobox, with its label, required marker and chevron, and shows `loadingLabel` where the value goes; it does not open. Set `stillLoadingAfter` (10000 for the Cinder loading rule) and `onCancel` and Skeleton’s own "Still loading" status, with a ghost Cancel, appears under the field. It is not a banner.

`loadError` (`{ title, description?, retryLabel? }`) shows the failure above the options in the open panel, with a "Try again" button that calls `onRetry`. The options you do have stay listed and selectable beneath it.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `aria-describedby` | `string` | no | — | External element id(s) to compose into `aria-describedby`. Composed after the component-generated description and error ids, matching the field-control contract in Select. Useful for tooltip ids, counter ids, or any external hint. |
| `aria-label` | `string` | no | — | Accessible name for the input when no visible label is rendered. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-combobox`. |
| `customValueAllowed` | `boolean` | no | — | Allow committing typed text that is not present in `options`. |
| `description` | `string` | no | — | Helper text displayed below the input; wired via aria-describedby. |
| `disabled` | `boolean` | no | — | Disables the combobox. Inherited from a wrapping FormField when unset. |
| `error` | `string` | no | — | Validation error message; sets aria-invalid="true". |
| `groupCountVisible` | `boolean` | no | `true` | Whether a group heading shows how many of the group's options are listed. |
| `id` | `string` | yes | — | Unique identifier — required for label association and ARIA wiring. |
| `label` | `string` | no | — | Visible label rendered in a `<label>` associated via `for`. |
| `loading` | `boolean` | no | `false` | Draw the loading state: the field keeps its label, required marker and chevron, shows `loadingLabel` where the value goes, and does not open. |
| `loadingLabel` | `string` | no | `"Loading…"` | Text shown in the field while `loading` ("Loading workflows…"). |
| `matchCountVisible` | `boolean` | no | `false` | Picker only: show "N of M" beside the search field while something is typed in it. |
| `maxVisibleOptions` | `number` | no | — | Hard cap on visible filtered options. Default 200. |
| `name` | `string` | no | — | Native form field name. Renders a hidden input carrying the selected value. |
| `placeholder` | `string` | no | — | Placeholder when no value is selected. |
| `presentation` | `"input"` \| `"picker"` | no | `"input"` | `input` types into the closed field; `picker` is a button that opens a panel with its own search field. See `ComboboxPresentation`. `customValueAllowed` has no effect on a picker, which has no text of its own to commit. |
| `required` | `boolean` | no | — | Marks the field required: renders the required marker on the label and sets `aria-required` on the input. Inherited from a wrapping FormField when unset. |
| `searchPlaceholder` | `string` | no | `"Search"` | Picker only: placeholder, and accessible name, of the search field in the open panel ("Search workflows"). |
| `selectedIndicator` | `"start"` \| `"end"` | no | `"end"` | Where the check on the chosen option sits: after the text (`end`) or before it (`start`). |
| `sheetBelow` | `string` \| `false` | no | — | Viewport width below which the options panel docks to the bottom edge as a sheet (Popover's `sheetBelow`, with focus kept in the input), instead of anchoring to the input. A simple CSS length such as `'640px'`, or `false` to always anchor. Default `'640px'`. |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | `"md"` | Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px, `lg` 40px, the same heights as a Button of that size. |
| `stillLoadingAfter` | `number` | no | — | While `loading`, milliseconds after which Skeleton's own "Still loading" status appears under the field. Use `10000` for the Cinder loading rule. Omit to never show it. |
| `textInputValue` | `string` | no | — | Free-text input value (the text the user has typed). Bindable. |
| `filter` | `(opaque)` | no | — | Custom synchronous filter. Receives an option and the current input value; returns true to keep. Defaults to case-insensitive substring match on label. Not expressible in JSON Schema; see the component types for the signature. |
| `footer` | `(opaque)` | no | — | Content drawn below the options, outside the `role="listbox"` element, so the arrow keys never reach it, and it stays visible while the options scroll and when none match. A link or button in it is a keyboard stop of its own, after the last option, reached with Tab from the field. Not expressible in JSON Schema; see the component types for the signature. |
| `loadError` | `(opaque)` | no | — | The option list failed to load; see `ComboboxLoadError`. The panel shows it above the options. Not expressible in JSON Schema; see the component types for the signature. |
| `noMatchLabel` | `(opaque)` | no | — | The text of the empty panel when nothing matches, or a function of what was typed. Not expressible in JSON Schema; see the component types for the signature. |
| `onCancel` | `(opaque)` | no | — | While `loading`, called when Cancel in the "Still loading" status is pressed. The button renders only when this is set. Not expressible in JSON Schema; see the component types for the signature. |
| `onRetry` | `(opaque)` | no | — | Called when the retry button in `loadError` is pressed. The button renders only when this is set. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | Called when an option, or an arbitrary value when enabled, is committed. Not expressible in JSON Schema; see the component types for the signature. |
| `optionMeta` | `(opaque)` | no | — | Content drawn at the trailing edge of each row, replacing the option's `meta` text. It sits inside the option, so it is part of the option's accessible name. Not expressible in JSON Schema; see the component types for the signature. |
| `options` | `(opaque)` | yes | — | Full set of options to filter. The sole inference source for T. Not expressible in JSON Schema; see the component types for the signature. |
| `value` | `(opaque)` | no | — | Currently selected value. Bindable. `''` when nothing is selected. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
