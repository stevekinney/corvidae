<script lang="ts" module>
  export const title = 'Height and long lines';
  export const description =
    'The editor fits its content between three and eight rows, then scrolls inside itself with a visible scrollbar. A line longer than the frame scrolls sideways with the gutter fixed, and wraps below 640px.';
</script>

<script lang="ts">
  import { JsonEditor } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let tallId = $derived(`${mountIdPrefix ?? uid}-tall`);
  let wideId = $derived(`${mountIdPrefix ?? uid}-wide`);

  const tall = JSON.stringify(
    {
      mode: 'ask',
      timeoutSeconds: 600,
      answerSchemas: { 'approve-briefing': { type: 'object' } },
      retries: 3,
      notify: { email: 'ops@example.com', slack: '#releases' },
    },
    null,
    2,
  );
  const wide = `{\n  "description": "${'A very long line of text that goes on. '.repeat(6)}"\n}`;
  let tallValue = $state(tall);
  let wideValue = $state(wide);
</script>

<div style="display: grid; gap: 1.5rem; max-inline-size: 36rem;">
  <JsonEditor
    id={tallId}
    label="Past eight rows"
    value={tallValue}
    onValueChange={(next) => (tallValue = next)}
  />
  <JsonEditor
    id={wideId}
    label="A line longer than the frame"
    value={wideValue}
    onValueChange={(next) => (wideValue = next)}
  />
</div>
