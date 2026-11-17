<script lang="ts" module>
  export const title = 'Compact field with hidden label';
  export const description =
    'Keep the accessible name from label while visually hiding it, for a compact toolbar-adjacent layout.';
</script>

<script lang="ts">
  import { ShortcutField } from '@lostgradient/cinder';
</script>

<ShortcutField
  id="toolbar-shortcut"
  label="Toolbar shortcut"
  labelVisible={false}
  value={['Control', 'B']}
/>
