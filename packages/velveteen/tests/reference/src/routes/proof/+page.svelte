<script lang="ts">
  import { onMount } from "svelte";
  let count = $state(0);
  onMount(() => {
    document.documentElement.dataset.hydrated = "true";
  });
</script>

<main>
  <p id="proof">Original: {count}</p>
  <button type="button" onclick={() => (count += 1)}>Increment</button>
</main>
