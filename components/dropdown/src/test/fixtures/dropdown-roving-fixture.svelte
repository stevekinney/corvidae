<script lang="ts">
  import Dropdown from '../../components/dropdown/dropdown.svelte';
  import DropdownItem from '../../components/dropdown-item/dropdown-item.svelte';
  import DropdownMenu from '../../components/dropdown-menu/dropdown-menu.svelte';
  import DropdownTrigger from '../../components/dropdown-trigger/dropdown-trigger.svelte';

  let { showExtra = false }: { showExtra?: boolean } = $props();
</script>

<Dropdown id="roving-menu">
  <DropdownTrigger class="trigger">Actions</DropdownTrigger>
  <DropdownMenu>
    <DropdownItem disabled>Locked</DropdownItem>
    <DropdownItem>Alpha</DropdownItem>
    <DropdownItem>Beta</DropdownItem>
    {#if showExtra}<DropdownItem>Extra</DropdownItem>{/if}
    <DropdownItem>Gamma</DropdownItem>
  </DropdownMenu>
</Dropdown>
