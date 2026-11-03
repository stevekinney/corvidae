<script lang="ts" module>
  export const title = 'Table with controls';
  export const description =
    'A table whose cells hold a checkbox and a select. It never scrolls: below 640px of its own width each row becomes a card with the name and its risk on top and the controls at 44px beneath. Asks is disabled while a tool is off.';
</script>

<script lang="ts">
  import { Checkbox, Select, Table } from '@lostgradient/cinder';

  type Tool = {
    id: string;
    name: string;
    identifier: string;
    description: string;
    risk: string;
    on: boolean;
    asks: 'never' | 'changes' | 'always';
  };

  let tools = $state<Tool[]>([
    {
      id: 'lookup',
      name: 'Lookup order',
      identifier: 'lookup-order',
      risk: 'Reads',
      description: 'Looks an order up by its number.',
      on: true,
      asks: 'never',
    },
    {
      id: 'refund',
      name: 'Issue refund',
      identifier: 'issue-refund',
      risk: 'Dangerous',
      description: 'Refunds a payment to the customer.',
      on: true,
      asks: 'always',
    },
    {
      id: 'workflow',
      name: 'Create workflow',
      identifier: 'create-workflow',
      risk: 'Changes things',
      description: 'Creates a workflow from a description.',
      on: false,
      asks: 'changes',
    },
  ]);

  const options = [
    { value: 'never', label: 'Never' },
    { value: 'changes', label: 'On changes' },
    { value: 'always', label: 'Always' },
  ];
</script>

<Table caption="Tool access">
  <Table.Header>
    <Table.Row>
      <Table.HeaderCell>On</Table.HeaderCell>
      <Table.HeaderCell>Tool</Table.HeaderCell>
      <Table.HeaderCell>Risk</Table.HeaderCell>
      <Table.HeaderCell>Default asks</Table.HeaderCell>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {#each tools as tool (tool.id)}
      <Table.Row>
        <Table.Cell controls="fit">
          <Checkbox bind:checked={tool.on} aria-label={`Allow ${tool.name}`} />
        </Table.Cell>
        <Table.Cell as="th">
          <strong>{tool.name}</strong> <code>{tool.identifier}</code>
          <span class="muted">{tool.description}</span>
        </Table.Cell>
        <Table.Cell><span class="muted">{tool.risk}</span></Table.Cell>
        <Table.Cell controls>
          <Select
            id={`asks-${tool.id}`}
            label={`${tool.name} asks`}
            labelVisible={false}
            bind:value={tool.asks}
            {options}
            disabled={!tool.on}
          />
        </Table.Cell>
      </Table.Row>
    {/each}
  </Table.Body>
</Table>

<style>
  .muted {
    color: var(--cinder-text-muted);
  }

  .muted:not(:only-child) {
    display: block;
    font-size: var(--cinder-text-sm);
  }
</style>
