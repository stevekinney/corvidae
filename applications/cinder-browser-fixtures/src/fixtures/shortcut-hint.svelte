<script lang="ts">
  import { ShortcutHint } from '@repo/cinder';
</script>

<div style="display: flex; gap: 0.75rem; align-items: center; flex-wrap: wrap;">
  <ShortcutHint keys={['Ctrl', 'S']}>Save</ShortcutHint>
  <ShortcutHint keys={['Ctrl', 'Z']}>Undo</ShortcutHint>
  <ShortcutHint keys={['Escape']}>Cancel</ShortcutHint>
  <ShortcutHint keys={['Space']} keysLabel="Space bar" keysPosition="before">Play</ShortcutHint>
</div>
