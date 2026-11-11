# InspectorRow

<!-- generated:a11y-record:required -->

`InspectorRow` is one property row of an `Inspector`: a muted label in a fixed 140px column, the value in the default text colour, then a trailing affordance. Each row is at least 44px tall, and below 700px the label stacks above the value.

A row is read-only unless it has a `kind` or an `editor`. An editable row draws a trailing chevron (a small switch for a toggle) and a hover tint, and activating it opens the editor:

- `kind="text"`, `kind="date"` and `kind="select"` open an inline editor in place of the value. Enter commits, Escape cancels, and leaving a field commits.
- `kind="toggle"` has no editor: activating the row commits the opposite of `current`.
- An `editor` snippet opens a popover anchored to the value. It receives `commit` and `cancel`, and Escape or an outside press cancels.

The row never holds the value itself: it calls `onCommit` with the new value and the page decides whether to keep it, so `value` and `current` are whatever the page holds.

## Usage

```svelte
<script lang="ts">
  import { Inspector, InspectorRow } from '@lostgradient/cinder';

  let due = $state('2026-11-30');
  let notify = $state(true);
</script>

<Inspector header="Details">
  <InspectorRow label="Due" kind="date" current={due} onCommit={(next) => (due = String(next))}>
    {#snippet value()}{due}{/snippet}
  </InspectorRow>
  <InspectorRow
    label="Notify"
    kind="toggle"
    current={notify}
    onCommit={(next) => (notify = next === true)}
  >
    {#snippet value()}{notify ? 'On' : 'Off'}{/snippet}
  </InspectorRow>
</Inspector>
```

## Suggested values

`suggested` marks a value the product drafted that is not saved until the person confirms it. The row says so in words: a quiet "Suggested" label in the accent text colour on a line under the row's label, which `suggestedLabel` can change, for example to "Suggested wording". The label is part of the term, so an editable row's name reads it too. The row keeps its own surface: no tint, no dashed or accent border and no pill.

```svelte
<script lang="ts">
  import { Inspector, InspectorRow } from '@lostgradient/cinder';
</script>

<Inspector header="Details">
  <InspectorRow label="Context" suggested>
    {#snippet value()}Phone{/snippet}
  </InspectorRow>
</Inspector>
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Custom class merged with `.cinder-inspector-row`. |
| `current` | `string` \| `boolean` | no | — | The value an editor starts from: the text of a `text`, `select` or `date` row, or the state of a `toggle`. |
| `disabled` | `boolean` | no | `false` | Draws the row as read-only, even when it has an editor. |
| `editLabel` | `string` | no | — | The accessible name of the editor. Left unset, it reads "Edit" and the label. |
| `kind` | `"text"` \| `"select"` \| `"date"` \| `"toggle"` | no | — | The built-in editor an activation opens. Leave it unset, with no `editor`, for a read-only row. A `toggle` row has no editor: activating it commits the opposite of `current`. |
| `label` | `string` | yes | — | The row's label, drawn muted in a fixed-width column. |
| `suggested` | `boolean` | no | `false` | Marks the value as a suggestion that is not saved until the person confirms it: a quiet accent text label under the row's label, with no tint, border or pill. |
| `suggestedLabel` | `string` | no | `"Suggested"` | The words of the suggested label, such as "Suggested wording". Used with `suggested`. |
| `editor` | `(opaque)` | no | — | A custom editor, shown in a popover anchored to the row's value. It wins over `kind`. Not expressible in JSON Schema; see the component types for the signature. |
| `icon` | `(opaque)` | no | — | An optional icon drawn before the label. Not expressible in JSON Schema; see the component types for the signature. |
| `onCancel` | `(opaque)` | no | — | Called when an edit is cancelled: with Escape, by activating the row again, or by dismissing the popover. Not expressible in JSON Schema; see the component types for the signature. |
| `onCommit` | `(opaque)` | no | — | Called when an edit is committed: with Enter, by leaving a field, by picking an option, by activating a toggle, or by a custom editor's `commit`. Not expressible in JSON Schema; see the component types for the signature. |
| `options` | `(opaque)` | no | — | The choices of a `select` row. Not expressible in JSON Schema; see the component types for the signature. |
| `value` | `(opaque)` | yes | — | The row's value, as it reads at rest. Not expressible in JSON Schema; see the component types for the signature. |

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
