<script lang="ts">
  import FormField from './form-field.svelte';
  import Input from '../input/input.svelte';

  let { error, description, note }: { error?: string; description?: string; note?: string } =
    $props();
  let value = $state('');
</script>

<FormField
  id="server-url"
  label="Server URL"
  {...error ? { error } : {}}
  {...description ? { description } : {}}
  {...note ? { note } : {}}
>
  <Input id="server-url" bind:value />
</FormField>
