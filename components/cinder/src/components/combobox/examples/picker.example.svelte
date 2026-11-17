<script lang="ts" module>
  export const title = 'Picker with search, footer and descriptions';
  export const description =
    '`presentation="picker"` is a button that opens a panel with its own search field. Rows carry a description, the chosen row is checked, and the footer stays below the list, also when nothing matches.';
</script>

<script lang="ts">
  import { Combobox } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-workflow-picker`);

  const workflows = [
    {
      value: 'chat',
      label: 'Chat with an agent',
      description: 'Send a message to an agent each time it runs.',
      group: 'Built in',
    },
    {
      value: 'release',
      label: 'Release notes',
      description: 'Collects merged changes into a draft.',
      group: 'Recent',
    },
    {
      value: 'refund',
      label: 'Order refund',
      description: 'Looks up an order, waits for approval, then refunds it.',
      group: 'Recent',
    },
    {
      value: 'triage',
      label: 'Triage inbox',
      description: 'Sorts new messages and flags anything urgent.',
      group: 'All workflows',
    },
  ];

  let selected = $state('chat');
</script>

<Combobox
  id={fieldId}
  label="Workflow"
  required
  presentation="picker"
  placeholder="Pick a workflow"
  searchPlaceholder="Search workflows"
  options={workflows}
  groupCountVisible={false}
  noMatchLabel={(query) => `No workflows match “${query}”.`}
  bind:value={selected}
>
  {#snippet footer()}
    No match? <a href="/workflows/new">Create one</a>
  {/snippet}
</Combobox>
