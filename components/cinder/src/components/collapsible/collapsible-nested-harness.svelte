<!--
  Test-only harness: a Collapsible inside another Collapsible's panel, to prove a nested one is
  flat by default and keeps its frame with `framed`. Not a public component.
-->
<script lang="ts">
  import Collapsible from './collapsible.svelte';

  let { framed = false }: { framed?: boolean } = $props();
</script>

<Collapsible trigger="Outer" open animated={false} idBase="outer">
  <Collapsible trigger="Inner" open animated={false} idBase="inner" {framed}>
    <p>inner body</p>
  </Collapsible>
</Collapsible>
