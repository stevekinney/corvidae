<script lang="ts">
  import { Rating } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-rating`);

  let score = $state(0);
</script>

<Rating id={fieldId} bind:value={score} label="Rate this article" />

{#if score > 0}
  <p class="margin-block-start-3 text-muted">
    You rated this {score} of 5.
  </p>
{/if}
