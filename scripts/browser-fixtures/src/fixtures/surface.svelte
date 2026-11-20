<script lang="ts">
  import { Surface } from '@lostgradient/cinder';
</script>

<div style="display: grid; gap: var(--cinder-space-3);">
  <Surface style="padding: var(--cinder-space-4);">
    <strong>Default</strong>
    <p style="margin: var(--cinder-space-1-5) 0 0; color: var(--cinder-text-muted);">
      Standard content surface.
    </p>
  </Surface>

  <Surface tone="raised" style="padding: var(--cinder-space-4);">
    <strong>Raised</strong>
    <p style="margin: var(--cinder-space-1-5) 0 0; color: var(--cinder-text-muted);">
      Elevated surface for overlays and panels.
    </p>
  </Surface>

  <Surface tone="inset" style="padding: var(--cinder-space-4);">
    <strong>Inset</strong>
    <p style="margin: var(--cinder-space-1-5) 0 0; color: var(--cinder-text-muted);">
      Quiet container for nested content.
    </p>
  </Surface>
</div>
