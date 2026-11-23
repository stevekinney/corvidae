<script lang="ts">
  import { increment } from "./positive.svelte.ts";

  let count: number = $state(0);
</script>

<button type="button" onclick={() => (count = increment(count))}
  >Count: {count}</button
>
