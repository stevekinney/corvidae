<script lang="ts">
  import { ShortcutHint } from '@lostgradient/cinder';
</script>

<div style="display: flex; gap: var(--cinder-space-3); align-items: center; flex-wrap: wrap;">
  <ShortcutHint keys={['Ctrl', 'S']}>Save</ShortcutHint>
  <ShortcutHint keys={['Ctrl', 'Z']}>Undo</ShortcutHint>
  <ShortcutHint keys={['Escape']}>Cancel</ShortcutHint>
  <ShortcutHint keys={['Space']} keysLabel="Space bar" keysPosition="before">Play</ShortcutHint>
</div>
