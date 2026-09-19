<script lang="ts">
  import { ColorField } from '@corvidae/cinder';

  let committed = $state('');
</script>

<div style="display: flex; flex-direction: column; gap: 0.5rem; max-width: 20rem;">
  <label for="field" style="font-size: 0.875rem; font-weight: 500;"> Brand color </label>
  <ColorField
    id="field"
    value="#3b82f6"
    onValueChange={(value) => {
      committed = value;
    }}
  />
  {#if committed}
    <p style="font-size: 0.75rem; color: var(--cinder-text-muted);">Committed: {committed}</p>
  {/if}
</div>
