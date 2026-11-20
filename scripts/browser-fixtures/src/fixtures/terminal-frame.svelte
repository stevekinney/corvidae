<script lang="ts">
  import { TerminalFrame } from '@lostgradient/cinder';
</script>

<TerminalFrame title="Build shell" status="connected">
  {#snippet children()}
    <pre class="children-pre padding-block-3 padding-inline-3">$ bun run build
Build complete.</pre>
  {/snippet}
</TerminalFrame>

<style>
  .children-pre {
    margin: 0;
  }
</style>
