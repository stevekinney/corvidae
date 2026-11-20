<script lang="ts">
  import { ColorField } from '@lostgradient/cinder';

  let committed = $state('');
</script>

<div style="display: flex; flex-direction: column; gap: var(--cinder-space-2); max-width: 20rem;">
  <label for="field" style="font-size: var(--cinder-text-base); font-weight: 500;">
    Brand color
  </label>
  <ColorField
    id="field"
    value="#3b82f6"
    onValueChange={(value) => {
      committed = value;
    }}
  />
  {#if committed}
    <p style="font-size: var(--cinder-text-xs); color: var(--cinder-text-muted);">
      Committed: {committed}
    </p>
  {/if}
</div>
