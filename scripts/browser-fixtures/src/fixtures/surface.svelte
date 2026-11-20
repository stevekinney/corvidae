<script lang="ts">
  import { Surface } from '@lostgradient/cinder';
</script>

<div class="example-grid gap-3">
  <Surface class="padding-block-4 padding-inline-4">
    <strong>Default</strong>
    <p class="note text-muted">Standard content surface.</p>
  </Surface>

  <Surface tone="raised" class="padding-block-4 padding-inline-4">
    <strong>Raised</strong>
    <p class="note text-muted">Elevated surface for overlays and panels.</p>
  </Surface>

  <Surface tone="inset" class="padding-block-4 padding-inline-4">
    <strong>Inset</strong>
    <p class="note text-muted">Quiet container for nested content.</p>
  </Surface>
</div>

<style>
  .example-grid {
    display: grid;
  }

  .note {
    margin: var(--cinder-space-1-5) 0 0;
  }
</style>
