<script lang="ts">
  import Select from './select.svelte';

  const options = [
    { value: 'alpha', label: 'Alpha' },
    { value: 'beta', label: 'Beta' },
  ];
</script>

<div data-testid="docked-select">
  <Select
    id="docked-select"
    label="Environment"
    {options}
    presentation="listbox"
    sheetBelow="640px"
  />
</div>
