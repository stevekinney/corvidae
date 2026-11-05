<script lang="ts">
  import Form from './form.svelte';
  import Input from '../input/input.svelte';

  let {
    focusProblemOnSubmit = true,
    readingColumn = false,
    nameDisabled = false,
  }: {
    focusProblemOnSubmit?: boolean;
    readingColumn?: boolean;
    nameDisabled?: boolean;
  } = $props();

  let name = $state('');
  let check = $state('');
  let nameError = $state<string | undefined>();
  let checkError = $state<string | undefined>();
</script>

<Form
  novalidate
  {focusProblemOnSubmit}
  {readingColumn}
  onSubmit={async () => {
    await Promise.resolve();
    nameError = 'Enter a name.';
    checkError = 'Choose a check.';
  }}
>
  <Input
    id="goal-name"
    label="Name"
    bind:value={name}
    {...nameError ? { error: nameError } : {}}
    disabled={nameDisabled}
  />
  <Input
    id="goal-check"
    label="Check"
    bind:value={check}
    {...checkError ? { error: checkError } : {}}
  />
  <button type="submit">Create goal</button>
</Form>
