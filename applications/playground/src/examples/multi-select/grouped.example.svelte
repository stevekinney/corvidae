<script lang="ts" module>
  export const title = 'Grouped items';
  export const description =
    'Give items a group to render them under headings with counts. Filtering keeps the headings of groups that still match.';
</script>

<script lang="ts">
  import { MultiSelect } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-tools`);

  const tools = [
    { id: 'read', label: 'Read file', group: 'Built in' },
    { id: 'write', label: 'Write file', group: 'Built in' },
    { id: 'search', label: 'Search the web', group: 'Search server' },
    { id: 'index', label: 'Index documents', group: 'Search server' },
    { id: 'clock', label: 'Current time' },
  ];

  let selected = $state<string[]>(['read']);
</script>

<MultiSelect id={fieldId} label="Tools" items={tools} filterable bind:selectedIds={selected} />
