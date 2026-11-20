<script lang="ts">
  /** A header's "More actions" menu beside a Button, and the same trigger outside any header. */
  import Button from '../../components/button/button.svelte';
  import Dropdown from '../../components/dropdown/dropdown.svelte';
  import DropdownItem from '../../components/dropdown-item/dropdown-item.svelte';
  import DropdownMenu from '../../components/dropdown-menu/dropdown-menu.svelte';
  import DropdownTrigger from '../../components/dropdown-trigger/dropdown-trigger.svelte';
  import PageHeader from '../../components/page-header/page-header.svelte';
</script>

{#snippet actions()}
  <Button variant="secondary" label="Open chat" />
  <Dropdown id="header-menu">
    <DropdownTrigger class="in-header" caretVisible={false} iconOnly>
      <span aria-hidden="true">...</span>
      <span class="cinder-visually-hidden">More actions</span>
    </DropdownTrigger>
    <DropdownMenu>
      <DropdownItem>Copy run ID</DropdownItem>
    </DropdownMenu>
  </Dropdown>
{/snippet}

<PageHeader title="Release notes" {actions} />

<Dropdown id="loose-menu">
  <DropdownTrigger class="loose" caretVisible={false} iconOnly>
    <span aria-hidden="true">...</span>
    <span class="cinder-visually-hidden">More actions</span>
  </DropdownTrigger>
  <DropdownMenu>
    <DropdownItem>Copy link</DropdownItem>
  </DropdownMenu>
</Dropdown>
