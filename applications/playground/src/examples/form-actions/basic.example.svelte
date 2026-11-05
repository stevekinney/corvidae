<script lang="ts" module>
  export const title = 'Summary left, Cancel then primary right';
  export const description =
    'The bar at the end of a form: a summary of what the primary button will do on the left, and the secondary Cancel then the primary on the right, under a top divider. The primary names how many tools join and follows the number of checked tools.';
</script>

<script lang="ts">
  import { Button, Checkbox, Form, FormActions } from '@lostgradient/cinder';

  let issues = $state(true);
  let pulls = $state(true);
  let branches = $state(false);
  const chosen = $derived([issues, pulls, branches].filter(Boolean).length);
</script>

<Form onSubmit={() => {}} novalidate>
  <Checkbox id="connect-issues" label="List issues" bind:checked={issues} />
  <Checkbox id="connect-pulls" label="Create pull request" bind:checked={pulls} />
  <Checkbox id="connect-branches" label="Delete branch" bind:checked={branches} />
  <FormActions label="Connect tools">
    {#snippet summary()}{chosen}
      {chosen === 1 ? 'tool' : 'tools'} from GitHub will join Capabilities.{/snippet}
    {#snippet end()}
      <Button variant="secondary">Cancel</Button>
      <Button type="submit" variant="primary" disabled={chosen === 0}>
        Connect {chosen}
        {chosen === 1 ? 'tool' : 'tools'}
      </Button>
    {/snippet}
  </FormActions>
</Form>
