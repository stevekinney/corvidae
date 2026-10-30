<script lang="ts">
  import Button from '../../components/button/button.svelte';
  import ButtonGroup from '../../components/button-group/button-group.svelte';
  import FormField from '../../components/form-field/form-field.svelte';
  import Input from '../../components/input/input.svelte';

  let {
    id = 'api-key',
    size = 'md',
  }: {
    id?: string;
    size?: 'sm' | 'md' | 'lg';
  } = $props();

  let value = $state('');
</script>

<FormField {id} label="API key">
  <ButtonGroup ariaLabelledby="{id}-label">
    <Input {id} bind:value {size} />
    <Button variant="secondary" {size}>Test a key</Button>
  </ButtonGroup>
</FormField>
