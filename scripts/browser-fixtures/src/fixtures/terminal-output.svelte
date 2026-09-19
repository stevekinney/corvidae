<script lang="ts">
  import { TerminalOutput } from '@corvidae/cinder';

  const value = '\u001b[32mPASS\u001b[0m build\n\u001b[33mWARN\u001b[0m cache miss';
</script>

<TerminalOutput {value} />
