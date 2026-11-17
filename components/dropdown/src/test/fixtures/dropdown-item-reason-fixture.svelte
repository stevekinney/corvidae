<script lang="ts">
  import Dropdown from '../../components/dropdown/dropdown.svelte';
  import DropdownItem from '../../components/dropdown-item/dropdown-item.svelte';
  import DropdownMenu from '../../components/dropdown-menu/dropdown-menu.svelte';
  import DropdownTrigger from '../../components/dropdown-trigger/dropdown-trigger.svelte';

  let { archiveOff = true }: { archiveOff?: boolean } = $props();
  let selected = $state('');
</script>

<div>
  <p id="own-note">Also read this.</p>
  <Dropdown id="reason-menu">
    <DropdownTrigger class="trigger">Actions</DropdownTrigger>
    <DropdownMenu>
      <DropdownItem
        disabled={archiveOff}
        disabledReason="Wait for the run to finish, then archive the chat."
        onclick={() => (selected = 'archive')}
      >
        <svg aria-hidden="true" width="14" height="14"></svg>
        Archive
      </DropdownItem>
      <DropdownItem disabled>Export</DropdownItem>
      <DropdownItem
        href="https://example.com"
        disabled
        disabledReason="Nothing to open yet."
        aria-describedby="own-note"
      >
        Open
      </DropdownItem>
      <DropdownItem disabled disabledReason="   ">Blank reason</DropdownItem>
    </DropdownMenu>
  </Dropdown>

  <output>{selected}</output>
</div>
