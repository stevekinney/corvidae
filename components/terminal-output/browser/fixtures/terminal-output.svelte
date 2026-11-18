<script lang="ts">
  import { default as TerminalOutput } from '@lostgradient/terminal-output/components/terminal-output/index.ts';

  const value = '\u001b[32mPASS\u001b[0m build\n\u001b[33mWARN\u001b[0m cache miss';
</script>

<TerminalOutput {value} />
