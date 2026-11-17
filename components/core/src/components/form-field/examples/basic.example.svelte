<script lang="ts" module>
  export const title = 'Basic form field';
  export const description = 'A form field wrapping an input with label association.';
</script>

<script lang="ts">
  import { FormField, Input } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-full-name`);

  let name = $state('');
</script>

<FormField
  id={fieldId}
  label="Full name"
  warning={name.length > 0 && name.length < 3
    ? 'Short names may be difficult to identify.'
    : undefined}
  managed={{ by: 'Workspace policy', reason: 'Displayed on shared reports' }}
>
  <Input id={fieldId} bind:value={name} placeholder="Jane Smith" />
</FormField>
