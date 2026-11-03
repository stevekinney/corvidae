# Select

Dropdown select for choosing a single option from a predefined list: the platform `<select>` by default, or a drawn listbox (`presentation="listbox"`) when the options need descriptions, group headings, a check on the current one or a footer.

## Usage

```svelte
<script lang="ts">
  import { Select } from '@lostgradient/cinder';
  const options = [
    { value: 'free', label: 'Free' },
    { value: 'pro', label: 'Pro' },
    { value: 'enterprise', label: 'Enterprise (contact sales)', disabled: true },
  ];

  let plan = $state(options[0]?.value ?? 'free');
</script>

<Select id="plan" bind:value={plan} {options} label="Plan" />
```

### Ghost variant

Inside a bordered container (a composer, an inline toolbar) use `variant="ghost"`: no border or fill at rest, a neutral tint on hover and while open, the focus ring around the whole control, the chevron kept. Bordered selects remain for forms and filter bars. `valuePrefix` draws a muted word before the value.

```svelte
<script lang="ts">
  import { Select } from '@lostgradient/cinder';

  let model = $state('sonnet');
</script>

<Select
  id="model"
  label="Model"
  labelVisible={false}
  valuePrefix="Model"
  variant="ghost"
  presentation="listbox"
  bind:value={model}
  options={[
    { value: 'opus', label: 'Claude Opus 5.5', description: 'Most capable · tools · images' },
    { value: 'sonnet', label: 'Claude Sonnet 5.5', description: 'Balanced · tools · images' },
  ]}
/>
```

### Listbox presentation

`presentation="listbox"` draws a button that opens a listbox. Options can carry a `description`, a `note` and a `group`; `groups` names the headings, divides them and can add a non-selectable `message`; `leading` draws a mark before each option; `footer` renders outside the listbox with its own keyboard stop; `placeholder` shows while no option is selected; `readonly` keeps the value focusable but not changeable. See `select.a11y.md` for the keyboard model. An option's `suffix` adds muted words on the label's own line ("Nightly archiver · no description"), and `triggerSuffix` adds muted words after the value in the trigger only ("Claude Sonnet 5.5 · Anthropic"). `onValueChangeRequest` can refuse or replace a pick before it is written, and the control shows what it returned, never the refused pick.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Extra class names merged with `.cinder-select-field`. |
| `description` | `string` | no | — | Helper text rendered below the control; wired via `aria-describedby`. |
| `disabled` | `boolean` | no | — | Disables the control. |
| `error` | `string` | no | — | Validation error message; sets `aria-invalid="true"` and is wired via `aria-describedby`. |
| `id` | `string` | yes | — | Unique identifier — required for label association and ARIA wiring. |
| `label` | `string` | no | — | Visible label rendered in a `<label>` associated via `for`. |
| `labelVisible` | `boolean` | no | `true` | Whether the label is visibly rendered. Set `false` to visually hide it while keeping it available to assistive technology. |
| `mutating` | `boolean` | no | `false` | Marks a select that changes something. Inside a stale `<StaleRegion>` it goes inert: it can be focused but not opened or changed, carries `aria-disabled`, and the region's reason describes it. It returns by itself when the region stops being stale. |
| `placeholder` | `string` | no | — | Listbox only: text shown in the trigger while no option is selected, such as `Loading models`. |
| `presentation` | `"native"` \| `"listbox"` | no | `"native"` | Native `<select>` or a drawn listbox; see `SelectPresentation`. The listbox-only props below (`placeholder`, `valuePrefix`, `leading`, `footer`, `groups`, and the rich option fields) do nothing in the native presentation. |
| `readonly` | `boolean` | no | — | The control shows its value and can be focused, but does not open and does not change. Exposed as `aria-readonly` on the listbox presentation; the native presentation also blocks the picker. |
| `required` | `boolean` | no | — | Marks the control required and sets the native `required` attribute. |
| `sheetBelow` | `string` \| `false` | no | `"640px"` | Listbox only: viewport width below which the options dock to the bottom edge as a sheet. A simple CSS length such as `'640px'`, or `false` to always anchor. |
| `size` | `"sm"` \| `"md"` \| `"lg"` | no | `"md"` | Height step from the shared `--cinder-control-height-*` scale: `sm` 28px, `md` 32px, `lg` 40px. Replaces the native list-box `size` attribute, which Cinder does not forward. |
| `valuePrefix` | `string` | no | — | Listbox only: muted text drawn before the value in the trigger ("Model" before "Claude Sonnet 5.5"). It is decorative and hidden from assistive technology; the name comes from `label`. |
| `variant` | `"default"` \| `"ghost"` | no | `"default"` | Visual style. `ghost` has no border or fill at rest, a neutral tint on hover and while open, the focus ring wrapping the whole control, and keeps its chevron: use it for a select inside a bordered container (a composer, an inline toolbar) so the row of controls reads as one surface. `default` is the bordered select for forms and filter bars. |
| `footer` | `(opaque)` | no | — | Listbox only: content drawn below the options, outside the `role="listbox"` element, so the arrow keys never reach it. A link or button in it is a keyboard stop of its own, after the last option, reached with Tab from the trigger. Not expressible in JSON Schema; see the component types for the signature. |
| `groups` | `(opaque)` | no | — | Listbox only: headings, dividers and messages for the option groups. Not expressible in JSON Schema; see the component types for the signature. |
| `leading` | `(opaque)` | no | — | Listbox only: a mark drawn before each option's label and before the selected value in the trigger, such as an avatar. Decorative. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChange` | `(opaque)` | no | — | Called with the new value when the person picks an option. Not expressible in JSON Schema; see the component types for the signature. |
| `onValueChangeRequest` | `(opaque)` | no | — | Intercepts the option the person picked before the bindable value is written. Return a replacement value to use instead, including the current value to refuse the pick; return nothing to accept it. The control shows what the hook returned, never the refused pick. Not expressible in JSON Schema; see the component types for the signature. |
| `options` | `(opaque)` | yes | — | Options to render as `<option>` children. The sole inference source for T. Not expressible in JSON Schema; see the component types for the signature. |
| `value` | `(opaque)` | no | — | Bound selected value. `undefined` when nothing is selected. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
