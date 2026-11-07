# Toggle

On/off switch input for binary settings, presented as a sliding pill control.

## Usage

```svelte
<script lang="ts">
  import { Toggle } from '@lostgradient/cinder';
</script>

<Toggle id="email-notifications" label="Email notifications" />
```

## Read-only and description

`readonly` shows a setting that something else owns, such as a schedule defined in a file. The switch stays focusable, is announced as read-only (`aria-readonly="true"`), ignores a press on the track or the label, and still submits its value with a native form. `description` is short visible text beside the label ("Defined in workflows/release-notes.json") wired into `aria-describedby`. Set `descriptionVisible={false}` for a description only a screen reader needs, such as what flipping the switch would cause: it stays in `aria-describedby` and is visually hidden. `nameDetail` adds words after the visible label in the accessible name alone (`label="Active"` with `nameDetail="Daily summary schedule"` is named "Active, Daily summary schedule"), so the visible label stays first.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `checked` | `boolean` | no | — | Whether the toggle is currently checked. Bindable — defaults to false. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-toggle` on the switch button. |
| `description` | `string` | no | — | Short visible text beside the label that describes the switch, such as the file that defines it ("Defined in workflows/release-notes.json"). It is wired into `aria-describedby`. |
| `descriptionPlacement` | `"inline"` \| `"below"` | no | `"inline"` | Where `description` sits. `inline` is on the label's line, for a few words ("Defined in workflows/release-notes.json"). `below` stacks it under the label, with the switch beside both, for a sentence that explains what the switch does. |
| `descriptionVisible` | `boolean` | no | `true` | Whether `description` is drawn. Set `false` for a description that only a screen reader needs, such as the consequence of flipping a switch whose reason the page already says in words: it stays wired into `aria-describedby` and is visually hidden. |
| `disabled` | `boolean` | no | — | Prevents interaction when true. Sets `disabled` attribute. |
| `form` | `string` | no | — | Associates the hidden checkbox with a form by id, matching the native `form` attribute. Lets the toggle submit with a form it is not nested in. Ignored when `name` is unset. |
| `id` | `string` | yes | — | Native id placed on the `<button>`; the rendered label uses `aria-labelledby` to name it (label id is derived as `${id}-label`). |
| `label` | `string` | yes | — | Visible label text. Always the accessible name, even when `labelVisible` is set. Required. |
| `labelPosition` | `"start"` \| `"end"` | no | `"end"` | Which side of the switch the label sits on. `start` puts the label first and spreads the two across the switch's full width, the way a list of switches reads; `end` keeps them together. Applies to a visible label that the switch owns (outside a field, or `standalone`). |
| `labelVisible` | `boolean` | no | `true` | Whether the label is visibly rendered. Set `false` for icon-only or inline contexts — it stays the accessible name. |
| `mutating` | `boolean` | no | `false` | Marks a switch that changes something. Inside a stale `<StaleRegion>` it goes inert: `aria-disabled`, still focusable, ignoring the press, and described by the region's reason. It returns by itself when the region stops being stale. |
| `name` | `string` | no | — | Form field name. When set, a hidden checkbox mirrors `checked` so the toggle participates in native form submission. Omit for purely client-side toggles (no hidden input is rendered, so there is zero overhead). |
| `nameDetail` | `string` | no | — | Words that follow the visible label in the accessible name only, such as the thing the switch belongs to ("Daily summary schedule" makes the name "Active, Daily summary schedule"). The visible label stays first, so the name keeps WCAG 2.5.3 (Label in Name). The name is then the switch's `aria-label`, written as one string so every platform reads it alike. |
| `readonly` | `boolean` | no | `false` | Shows the setting without letting a press change it, for a value that something else owns, such as a schedule defined in a file. The switch stays focusable, announces `aria-readonly="true"`, ignores a press on the track or the label, and still submits its value with a native form (unlike `disabled`). |
| `standalone` | `boolean` | no | `false` | Makes the switch its own field: it is named and labelled by its own `label` even inside a `<FormField>` or `<SettingRow>`, whose label would otherwise name it. Use it for one switch among several in a field, such as a list of agents in a setting. |
| `value` | `string` | no | — | Value submitted for the hidden checkbox when `checked` and `name` is set. Mirrors native checkbox semantics: the pair `name=value` is sent only while checked. Defaults to `'on'`. Ignored when `name` is unset. |
| `onValueChange` | `(opaque)` | no | — | Notify after the bindable value has been committed. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChangeRequest` | `(opaque)` | no | — | Intercept a proposed checked state before the bindable value is written. Return a replacement value to transform it. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-toggle-track-off-hover-resting`
- `--cinder-toggle-track-off-resting`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
