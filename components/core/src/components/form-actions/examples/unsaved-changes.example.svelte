<script lang="ts" module>
  export const title = 'Unsaved changes and the effect of saving';
  export const description =
    'Once something changes the bar counts the unsaved changes in neutral text and names what saving does ("Saving raises the policy revision."), with Reset to default then Save on the right. Untick a model to see the count.';
</script>

<script lang="ts">
  import { Button, Checkbox, Form, FormActions } from '@lostgradient/cinder';

  let opus = $state(false);
  let sonnet = $state(false);
  let haiku = $state(true);
  const changes = $derived([opus, sonnet, !haiku].filter(Boolean).length);

  function reset(): void {
    opus = false;
    sonnet = false;
    haiku = true;
  }
</script>

<Form onSubmit={() => {}} novalidate>
  <Checkbox id="allow-opus" label="Claude Opus 5.5" bind:checked={opus} />
  <Checkbox id="allow-sonnet" label="Claude Sonnet 5.5" bind:checked={sonnet} />
  <Checkbox id="allow-haiku" label="Claude Haiku 5" bind:checked={haiku} />
  <FormActions unsavedChanges={changes}>
    {#snippet summary()}Saving raises the policy revision.{/snippet}
    {#snippet end()}
      <Button variant="secondary" onclick={reset}>Reset to default</Button>
      <Button type="submit" variant="primary">Save</Button>
    {/snippet}
  </FormActions>
</Form>
