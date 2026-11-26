<script lang="ts">
  let { data }: { data: { visitor: string; durableCount: string } } = $props();
</script>

<h1>Velveteen on workerd</h1>
<p>visitor: {data.visitor}</p>
<p>durable count: {data.durableCount}</p>
