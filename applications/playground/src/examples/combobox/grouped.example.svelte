<script lang="ts" module>
  export const title = 'Grouped options';
  export const description =
    'Give options a group to render them under headings with counts. Typing filters across groups and keeps the headings of groups that still match.';
</script>

<script lang="ts">
  import { Combobox } from '@lostgradient/cinder';

  let { mountIdPrefix }: { mountIdPrefix?: string } = $props();
  const uid = $props.id();
  let fieldId = $derived(`${mountIdPrefix ?? uid}-workflow`);

  const workflows = [
    { value: 'chat', label: 'Chat with an agent', group: 'Built in' },
    { value: 'digest', label: 'Daily digest', group: 'Recent' },
    { value: 'triage', label: 'Triage issues', group: 'Built in' },
    { value: 'release', label: 'Release notes', group: 'All workflows' },
    { value: 'review', label: 'Review a pull request', group: 'Recent' },
    { value: 'backup', label: 'Nightly backup', group: 'All workflows' },
  ];

  let selected = $state('');
</script>

<Combobox
  id={fieldId}
  label="Workflow"
  placeholder="Search workflows…"
  options={workflows}
  bind:value={selected}
/>
