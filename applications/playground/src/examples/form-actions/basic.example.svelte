<script lang="ts" module>
  export const title = 'Save bar with unsaved changes and a failed save';
  export const description =
    'The bar at the end of a form: the unsaved-change count and the effect of saving on the left, Reset then Save on the right, with a top divider. A failed save draws a danger alert above the buttons, the choices stay as ticked, and Save keeps its label as the retry. sticky pins the bar to the bottom of a long form.';
</script>

<script lang="ts">
  import { Button, Checkbox, Form, FormActions } from '@lostgradient/cinder';

  let opus = $state(true);
  let sonnet = $state(true);
  let failed = $state(true);
  let changes = $derived((opus ? 0 : 1) + (sonnet ? 0 : 1));
</script>

<Form
  onSubmit={() => {
    failed = !failed;
  }}
  novalidate
>
  <Checkbox id="allow-opus" label="Claude Opus 5.5" bind:checked={opus} />
  <Checkbox id="allow-sonnet" label="Claude Sonnet 5.5" bind:checked={sonnet} />
  <FormActions
    unsavedChanges={changes}
    errorTitle={failed ? 'Couldn’t save.' : undefined}
    error={failed ? 'Interborough didn’t answer. Your choices are still here.' : undefined}
  >
    {#snippet summary()}Saving raises the policy revision.{/snippet}
    {#snippet end()}
      <Button
        variant="secondary"
        onclick={() => {
          opus = true;
          sonnet = true;
        }}>Reset to default</Button
      >
      <Button type="submit" variant="primary">Save</Button>
    {/snippet}
  </FormActions>
</Form>
