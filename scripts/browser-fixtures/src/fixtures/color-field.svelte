<script lang="ts">
  import { ColorField } from '@lostgradient/cinder';

  let committed = $state('');
</script>

<div class="example-frame gap-2">
  <label for="field" class="label"> Brand color </label>
  <ColorField
    id="field"
    value="#3b82f6"
    onValueChange={(value) => {
      committed = value;
    }}
  />
  {#if committed}
    <p class="note text-muted">
      Committed: {committed}
    </p>
  {/if}
</div>

<style>
  .example-frame {
    display: flex;
    flex-direction: column;
    max-width: 20rem;
  }

  .label {
    font-size: var(--cinder-text-base);
    font-weight: 500;
  }

  .note {
    font-size: var(--cinder-text-xs);
  }
</style>
