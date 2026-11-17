<script lang="ts" module>
  export const title = 'Editor states';
  export const description =
    'The editor in its frame, with the status and Format in its top corner: empty with a muted example, valid, invalid with the line marked, read only, and disabled.';
</script>

<script lang="ts">
  import { JsonEditor } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let emptyId = $derived(`${mountIdPrefix ?? uid}-empty`);
  let validId = $derived(`${mountIdPrefix ?? uid}-valid`);
  let invalidId = $derived(`${mountIdPrefix ?? uid}-invalid`);
  let readonlyId = $derived(`${mountIdPrefix ?? uid}-readonly`);
  let disabledId = $derived(`${mountIdPrefix ?? uid}-disabled`);

  const sample = '{\n  "mode": "ask",\n  "timeoutSeconds": 600,\n  "retries": 3\n}';
  let empty = $state('');
  let valid = $state(sample);
  let invalid = $state('{\n  "mode": "ask"\n  "timeoutSeconds": 600\n}');
</script>

<div style="display: grid; gap: 1.5rem; max-inline-size: 36rem;">
  <JsonEditor
    id={emptyId}
    label="Empty"
    example={'{ "defaultTimeoutSeconds": 300 }'}
    value={empty}
    onValueChange={(next) => (empty = next)}
  />
  <JsonEditor id={validId} label="Valid" value={valid} onValueChange={(next) => (valid = next)} />
  <JsonEditor
    id={invalidId}
    label="Invalid"
    description="The line that ends without its comma is marked, and the status message jumps to it."
    value={invalid}
    onValueChange={(next) => (invalid = next)}
  />
  <JsonEditor id={readonlyId} label="Read only" value={sample} readonly />
  <JsonEditor id={disabledId} label="Disabled" value={sample} disabled />
</div>
