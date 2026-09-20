# ShortcutField

An accessible read-only keyboard shortcut recorder. Focus the field, press a combination, or press Escape to cancel capture.

## Usage

```svelte
<script lang="ts">
  import { ShortcutField } from '@corvidae/cinder';
</script>

<ShortcutField label="Open command palette" value={['Meta', 'K']} />
```

`value` is an ordered list of platform key names. The field enters capture mode when focused, calls `onValueChange` with the recorded combination, and uses Escape to cancel capture. Supply `validate` to return an error message for a combination the application cannot accept; keep the previous value until a valid replacement is committed. Set `disabled` when the shortcut is unavailable rather than hiding the field.
