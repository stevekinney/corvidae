<script lang="ts">
  import { Kbd } from '@lostgradient/cinder';
</script>

<div class="example-preview-row example-preview-row-layout">
  <span class="label-layout gap-1">
    <Kbd label="Esc" />
  </span>

  <span class="label-layout gap-1">
    Press <Kbd label="⌘" /> + <Kbd label="K" /> to open the command palette
  </span>

  <span class="label-layout gap-1">
    <Kbd size="sm" label="Shift" /> + <Kbd size="sm" label="Tab" />
  </span>
</div>

<style>
  .example-preview-row-layout {
    align-items: center;
  }

  .label-layout {
    display: inline-flex;
    align-items: center;
  }
</style>
