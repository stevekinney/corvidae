# ShortcutField

An accessible read-only keyboard shortcut recorder. Focus the field, press a combination, or press Escape to cancel capture.

## Usage

```svelte
<script lang="ts">
  import { ShortcutField } from '@repo/cinder';
</script>

<ShortcutField label="Open command palette" value={['Meta', 'K']} />
```
