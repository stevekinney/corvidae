<script lang="ts">
  import Dropdown from '../../components/dropdown/dropdown.svelte';
  import DropdownGroup from '../../components/dropdown-group/dropdown-group.svelte';
  import DropdownItem from '../../components/dropdown-item/dropdown-item.svelte';
  import DropdownLabel from '../../components/dropdown-label/dropdown-label.svelte';
  import DropdownMenu from '../../components/dropdown-menu/dropdown-menu.svelte';
  import DropdownSeparator from '../../components/dropdown-separator/dropdown-separator.svelte';
  import DropdownTrigger from '../../components/dropdown-trigger/dropdown-trigger.svelte';

  let { density = 'compact' }: { density?: string } = $props();
</script>

<Dropdown id="check-menu">
  <DropdownTrigger class="trigger">View</DropdownTrigger>
  <DropdownMenu>
    <DropdownGroup ariaLabelledby="check-menu-density">
      <DropdownLabel id="check-menu-density">Density</DropdownLabel>
      <DropdownItem itemRole="menuitemradio" checked={density === 'compact'}>Compact</DropdownItem>
      <DropdownItem itemRole="menuitemradio" checked={density === 'comfortable'}>
        Comfortable
      </DropdownItem>
      <DropdownItem
        itemRole="menuitemradio"
        checked={density === 'spacious'}
        disabled
        disabledReason="Needs a wider window."
      >
        Spacious
      </DropdownItem>
    </DropdownGroup>
    <DropdownSeparator />
    <DropdownGroup ariaLabelledby="check-menu-columns">
      <DropdownLabel id="check-menu-columns">Columns</DropdownLabel>
      <DropdownItem itemRole="menuitemcheckbox" checked closeOnSelect={false}>Status</DropdownItem>
      <DropdownItem itemRole="menuitemcheckbox" closeOnSelect={false}>Owner</DropdownItem>
    </DropdownGroup>
    <DropdownSeparator />
    <DropdownItem>Reset view</DropdownItem>
  </DropdownMenu>
</Dropdown>
