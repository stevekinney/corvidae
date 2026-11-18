<script lang="ts" module>
  export const title = 'Marked lines and a field error';
  export const description =
    'A page marks lines the parser cannot judge (valid JSON that names an unavailable agent), replaces the status text, and reports a field error that turns the frame red. Save focuses the problem.';
</script>

<script lang="ts">
  import { Button, JsonEditor } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let workflowId = $derived(`${mountIdPrefix ?? uid}-workflow`);
  let bannerId = $derived(`${mountIdPrefix ?? uid}-banner`);

  let workflow = $state(
    '{\n  "name": "morning-briefing",\n  "steps": [\n    {\n      "agent": "release-helper"\n    }\n  ]\n}',
  );
  let bannerValue = $state('{\n  "dismissed": true,\n  "dismissedOn": "2026-11-01T22:12:00Z",\n}');
  let workflowEditor: { focusProblem: () => void } | undefined = $state();
</script>

<div style="display: grid; gap: 1.5rem; max-inline-size: 36rem;">
  <div style="display: grid; gap: 0.5rem;">
    <JsonEditor
      bind:this={workflowEditor}
      id={workflowId}
      label="Workflow"
      value={workflow}
      onValueChange={(next) => (workflow = next)}
      statusLabel="Valid JSON, not a valid workflow"
      diagnostics={[
        {
          line: 5,
          message:
            'No agent with the ID release-helper is available: it comes from the Demo plugin, which is disabled.',
        },
      ]}
    />
    <div><Button label="Create workflow" onclick={() => workflowEditor?.focusProblem()} /></div>
  </div>
  <JsonEditor
    id={bannerId}
    label="Value"
    value={bannerValue}
    onValueChange={(next) => (bannerValue = next)}
    error="Unexpected token } at line 4. Fix the JSON to save."
  />
</div>
