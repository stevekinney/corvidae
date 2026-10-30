# Theme Switch

A three-position Light, System, Dark switch in the Toggle family. A quiet pale sky sits behind Light, a deep night behind Dark, and the neutral inset surface behind System, with a raised thumb under the selected icon.

Use it to let a person choose a color theme in a header, a user menu, or a settings page. It reports the choice through `value` and `onValueChange` and does not change the document: applying the theme, and remembering it, is the application's job. Choose `Toggle` for a single on or off setting, and `SegmentedControl` for a longer list of labeled choices.

## Usage

```svelte
<script lang="ts">
  import { ThemeSwitch, type ThemeSwitchValue } from '@lostgradient/cinder';

  let theme = $state<ThemeSwitchValue>('system');
</script>

<ThemeSwitch bind:value={theme} label="Color theme" />
```

`System` is the default position. Pass `onValueChange` to react to a selection, for example to set `data-theme` on the root element:

```svelte
<script lang="ts">
  import { ThemeSwitch, type ThemeSwitchValue } from '@lostgradient/cinder';

  function apply(next: ThemeSwitchValue): void {
    document.documentElement.dataset['theme'] = next;
  }
</script>

<ThemeSwitch value="system" onValueChange={apply} />
```

## Behavior

The switch is a `radiogroup` of three buttons with `role="radio"`, so exactly one position is always selected. Clicking a position selects it. With keyboard focus on the group, the arrow keys move to the next or previous position (wrapping at the ends) and select it as they go, and Home and End select Light and Dark. Selecting the position that is already selected reports nothing.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-theme-switch` on the radiogroup. |
| `disabled` | `boolean` | no | — | Prevents interaction when true. Sets `disabled` on each position. |
| `id` | `string` | no | — | Native id placed on the radiogroup element. |
| `label` | `string` | no | `"Theme"` | Accessible name of the radiogroup. The three positions are named Light, System and Dark. |
| `value` | `"light"` \| `"system"` \| `"dark"` | no | `"system"` | The selected position. Bindable. |
| `onValueChange` | `(opaque)` | no | — | Notify after the user selects a position, with the position that was selected. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
