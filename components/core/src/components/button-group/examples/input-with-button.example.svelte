<script lang="ts" module>
  export const title = 'Input with an attached button';
  export const description =
    'An Input as the first member and a Button as the trailing part of the field share one border, height and set of corners. Give both the same size.';
</script>

<script lang="ts">
  import { Button, ButtonGroup, FormField, Input } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-api-key`);
  let labelId = $derived(`${mountIdPrefix ?? uid}-api-key-label`);

  let key = $state('');
</script>

<FormField
  id={fieldId}
  label="API key"
  description="Tested against the provider before it is saved."
>
  <ButtonGroup ariaLabelledby={labelId}>
    <Input id={fieldId} bind:value={key} placeholder="sk-…" />
    <Button variant="secondary">Test a key</Button>
  </ButtonGroup>
</FormField>
