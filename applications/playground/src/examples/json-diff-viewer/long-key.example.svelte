<script lang="ts" module>
  export const title = 'A very long key';
  export const description =
    'A property name of over 300 characters wraps inside its own column, so the viewer never scrolls sideways and the value stays on screen.';
</script>

<script lang="ts">
  import { JsonDiffViewer } from '@lostgradient/cinder';

  const longKey = `workflow.schedule.${'segment-'.repeat(37)}end`;

  const before = { [longKey]: 'queued', status: 'ok' };
  const after = { [longKey]: 'running', status: 'ok' };
</script>

<JsonDiffViewer {before} {after} label="Long key differences" />
