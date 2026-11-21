<script lang="ts">
  import { createCounter } from "./counter.svelte.ts";
  const counter = createCounter();
</script>

<button onclick={() => counter.increment()}>Original: {counter.value}</button>

<style>
  button {
    color: rgb(1, 2, 3);
  }
</style>
