<script lang="ts" module>
  export const title = 'Save stays enabled; focus goes to the first problem';
  export const description =
    'Validation never disables Save. Pressing it puts each message at its field, under it with a warning glyph, and moves focus to the first problem. readingColumn holds the form to one column up to 720px.';
</script>

<script lang="ts">
  import { Button, Form, FormField, Input } from '@lostgradient/cinder';

  let name = $state('');
  let check = $state('');
  let nameError = $state<string | undefined>();
  let checkError = $state<string | undefined>();
</script>

<Form
  novalidate
  readingColumn
  onSubmit={() => {
    nameError = name ? undefined : 'Enter a name.';
    checkError = check ? undefined : 'Choose what decides the goal is done.';
  }}
>
  <div style="display: grid; gap: 1rem;">
    <FormField id="goal-name" label="Name" required error={nameError}>
      <Input id="goal-name" bind:value={name} />
    </FormField>
    <FormField id="goal-check" label="Check" required error={checkError}>
      <Input id="goal-check" bind:value={check} />
    </FormField>
    <div><Button type="submit" variant="primary">Create goal</Button></div>
  </div>
</Form>
