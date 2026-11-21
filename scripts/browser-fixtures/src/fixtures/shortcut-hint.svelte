<script lang="ts">
  import { ShortcutHint } from '@lostgradient/cinder';
</script>

<div class="example-layout gap-3">
  <ShortcutHint keys={['Ctrl', 'S']}>Save</ShortcutHint>
  <ShortcutHint keys={['Ctrl', 'Z']}>Undo</ShortcutHint>
  <ShortcutHint keys={['Escape']}>Cancel</ShortcutHint>
  <ShortcutHint keys={['Space']} keysLabel="Space bar" keysPosition="before">Play</ShortcutHint>
</div>

<style>
  .example-layout {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
  }
</style>
