<script lang="ts">
  import { default as TerminalFrame } from '@lostgradient/terminal-frame/components/terminal-frame/index.ts';
</script>

<TerminalFrame title="Build shell" status="connected">
  {#snippet children()}
    <pre style="margin: 0; padding: var(--cinder-space-3);">$ bun run build
Build complete.</pre>
  {/snippet}
</TerminalFrame>
