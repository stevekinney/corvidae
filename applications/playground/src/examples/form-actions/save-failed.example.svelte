<script lang="ts" module>
  export const title = 'A failed save';
  export const description =
    'A failed save draws a danger alert above the buttons. The choices stay as ticked, and Save keeps its label as the retry beside Reset to default.';
</script>

<script lang="ts">
  import { Button, Checkbox, Form, FormActions } from '@lostgradient/cinder';

  let opus = $state(true);
  let sonnet = $state(true);
  let haiku = $state(false);
  const changes = $derived([opus, sonnet, haiku].filter(Boolean).length);
</script>

<Form onSubmit={() => {}} novalidate>
  <Checkbox id="failed-opus" label="Claude Opus 5.5" bind:checked={opus} />
  <Checkbox id="failed-sonnet" label="Claude Sonnet 5.5" bind:checked={sonnet} />
  <Checkbox id="failed-haiku" label="Claude Haiku 5" bind:checked={haiku} />
  <FormActions
    unsavedChanges={changes}
    errorTitle="Couldn’t save."
    error="Interborough didn’t answer. Your choices are still here."
  >
    {#snippet summary()}Saving raises the policy revision.{/snippet}
    {#snippet end()}
      <Button variant="secondary">Reset to default</Button>
      <Button type="submit" variant="primary">Save</Button>
    {/snippet}
  </FormActions>
</Form>
