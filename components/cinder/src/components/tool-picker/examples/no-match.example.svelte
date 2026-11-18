<script lang="ts" module>
  export const title = 'Filtered to nothing';
  export const description =
    'When the search matches nothing the field keeps its text and the picker says so, with a hint and one action, Clear search. Open it on a search with the bindable query.';
</script>

<script lang="ts">
  import { Button, ToolPicker, type ToolPickerItem } from '@lostgradient/cinder';

  let open = $state(false);
  let query = $state('');

  const items: ToolPickerItem[] = [
    {
      value: 'lookup-order',
      label: 'Lookup order',
      code: 'lookup-order',
      description: 'Looks an order up by its ID',
      group: 'Built in',
      meta: 'Reads',
      detail: 'Never (default)',
    },
    {
      value: 'issue-refund',
      label: 'Issue refund',
      code: 'issue-refund',
      description: 'Refunds an order to the original card',
      group: 'Built in',
      meta: 'Dangerous',
      detail: 'Always (default)',
    },
  ];
</script>

<Button
  variant="secondary"
  onclick={() => {
    query = 'invoice';
    open = true;
  }}>Add tools and skills</Button
>

<ToolPicker bind:open bind:query {items} />
