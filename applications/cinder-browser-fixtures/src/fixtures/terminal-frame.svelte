<script lang="ts">
  import { TerminalFrame } from '@repo/cinder';
</script>

<TerminalFrame title="Build shell" status="connected">
  {#snippet children()}
    <pre style="margin: 0;">$ bun run build
Build complete.</pre>
  {/snippet}
</TerminalFrame>
