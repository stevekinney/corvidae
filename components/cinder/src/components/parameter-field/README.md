# ParameterField

Displays an inherited base parameter and an optional local override. Overrides can be reset to the base value and may carry Unsaved or Experimental badges.

Use the default output for a read-only summary, or provide a child snippet to render a `NumberInput`, `Slider`, or another numeric editor. The snippet receives the effective `value`, whether it is `overridden`, and a `setOverride` callback.

## Usage

```svelte
<script lang="ts">
  import { ParameterField } from '@corvidae/cinder';
</script>

<ParameterField id="timeout" label="Timeout" base={30} unit="seconds" />
```

`base` is the effective value until `override` is supplied. The reset action clears the override and calls `onOverrideChange(undefined)`; it never changes `base`. Use `unsaved` and `experimental` to annotate the value's status, not to change persistence or validation.

For a custom editor, the child snippet receives `value`, `overridden`, `labelledBy`, and `setOverride`. Apply `labelledBy` to the nested numeric control so the visible parameter label remains its accessible name. The host owns saving and error recovery: keep the override in place while a save fails and report the failure beside the control.
