<script lang="ts" module>
  export const title = 'Sticky bar on a long form';
  export const description =
    'sticky keeps the bar at the bottom of the nearest scrolling container, so the only Save is in reach however long the form gets: the summary "Not saved yet", then Cancel, then Save.';
</script>

<script lang="ts">
  import { Button, Form, FormActions, FormField, Input } from '@lostgradient/cinder';

  const fields = [
    'Name',
    'Description',
    'Model',
    'Instructions',
    'Tools',
    'Skills',
    'Memory',
    'Schedule',
  ];
</script>

<div style="max-block-size: 20rem; overflow: auto; border: 1px solid var(--cinder-border);">
  <Form onSubmit={() => {}} novalidate>
    {#each fields as field (field)}
      <FormField label={field} id={`sticky-${field.toLowerCase()}`}>
        <Input id={`sticky-${field.toLowerCase()}`} value="" />
      </FormField>
    {/each}
    <FormActions sticky label="New agent">
      {#snippet summary()}Not saved yet{/snippet}
      {#snippet end()}
        <Button variant="secondary">Cancel</Button>
        <Button type="submit" variant="primary">Save</Button>
      {/snippet}
    </FormActions>
  </Form>
</div>
