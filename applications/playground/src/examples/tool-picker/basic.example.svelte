<script lang="ts" module>
  export const title = 'Grouped tools and skills';
  export const description =
    'Tools group by source with their risk and the level they start at on each row; skills are listed with no checkbox, because they follow the tools they use. Done keeps the choices, Cancel drops them.';
</script>

<script lang="ts">
  import {
    Button,
    ToolPicker,
    type ToolPickerGroup,
    type ToolPickerItem,
  } from '@lostgradient/cinder';

  let open = $state(false);
  let selected = $state<string[]>(['lookup-order', 'issue-refund', 'triage-refunds']);

  const groups: ToolPickerGroup[] = [
    { name: 'Built in' },
    { name: 'GitHub' },
    { name: 'Skills', note: 'they follow the tools they use' },
  ];

  const items: ToolPickerItem[] = [
    {
      value: 'discover-agents',
      label: 'Discover agents',
      code: 'bureau:discover-agents',
      description: 'Finds other agents by name or description',
      group: 'Built in',
      meta: 'Reads',
      detail: 'Never (default)',
    },
    {
      value: 'ask-a-person',
      label: 'Ask a person',
      code: 'bureau:ask-a-person',
      description: 'Asks you a question and waits',
      group: 'Built in',
      meta: 'Reads',
      detail: 'Never (default)',
    },
    {
      value: 'workflows-create',
      label: 'Create workflow',
      code: 'workflows-create',
      description: 'Drafts a workflow from a description',
      group: 'Built in',
      meta: 'Changes things',
      detail: 'On changes (default)',
    },
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
    {
      value: 'triage-refunds',
      label: 'Triage refunds',
      code: 'triage-refunds',
      description: 'Decides whether a refund request is allowed',
      group: 'Built in',
      meta: 'Changes things',
      detail: 'On changes (default)',
    },
    {
      value: 'list-issues',
      label: 'List issues',
      code: 'list_issues',
      description: 'Lists issues in a GitHub repository',
      group: 'GitHub',
      meta: 'Reads',
      detail: 'Never (default)',
    },
    {
      value: 'create-issue',
      label: 'Create issue',
      code: 'create_issue',
      description: 'Opens an issue in a GitHub repository',
      group: 'GitHub',
      meta: 'Changes things',
      detail: 'On changes (default)',
    },
    {
      value: 'delete-branch',
      label: 'Delete branch',
      code: 'delete_branch',
      description: 'Deletes a branch from a GitHub repository',
      group: 'GitHub',
      meta: 'Dangerous',
      detail: 'Always (default)',
    },
    {
      value: 'release-notes',
      label: 'Release notes',
      code: 'release-notes',
      suffix: 'Skill',
      description: 'Drafts release notes from merged pull requests',
      group: 'Skills',
      detail: 'Follows its tools',
      selectable: false,
    },
    {
      value: 'writing-style',
      label: 'Writing style',
      code: 'writing-style',
      suffix: 'Skill',
      description: 'Keeps replies short and plain',
      group: 'Skills',
      detail: 'Follows its tools',
      selectable: false,
    },
  ];

  const labels = $derived(
    items.filter((item) => selected.includes(item.value)).map((item) => item.label),
  );
</script>

<Button variant="secondary" onclick={() => (open = true)}>Add tools and skills</Button>
<p>{labels.length === 0 ? 'No tools chosen.' : `Chosen: ${labels.join(', ')}.`}</p>

<ToolPicker bind:open bind:selected {items} {groups} />
