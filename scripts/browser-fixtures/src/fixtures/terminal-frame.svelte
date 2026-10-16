<script lang="ts">
  import { TerminalFrame } from '@lostgradient/cinder';
</script>

<TerminalFrame title="Build shell" status="connected">
  {#snippet children()}
    <pre style="margin: 0; padding: var(--cinder-space-3);">$ bun run build
Build complete.</pre>
  {/snippet}
</TerminalFrame>
