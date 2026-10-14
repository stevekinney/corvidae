<script lang="ts">
  let updates = $state(0);

  $effect(() => {
    if (updates > 0) throw new Error('update failed');
  });
</script>

<button type="button" onclick={() => (updates += 1)}>Update</button>
