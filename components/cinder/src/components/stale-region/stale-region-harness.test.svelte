<script lang="ts">
  import Button from '../button/button.svelte';
  import Checkbox from '../checkbox/checkbox.svelte';
  import Dropdown from '../dropdown/dropdown.svelte';
  import DropdownItem from '../dropdown-item/dropdown-item.svelte';
  import DropdownMenu from '../dropdown-menu/dropdown-menu.svelte';
  import DropdownTrigger from '../dropdown-trigger/dropdown-trigger.svelte';
  import Link from '../link/link.svelte';
  import Select from '../select/select.svelte';
  import Toggle from '../toggle/toggle.svelte';
  import StaleRegion from './stale-region.svelte';

  let {
    describedBy,
    outside = false,
    listbox = false,
    link = false,
    onSave,
    onRetry,
  }: {
    describedBy?: string;
    outside?: boolean;
    listbox?: boolean;
    link?: boolean;
    onSave?: () => void;
    onRetry?: () => void;
  } = $props();

  let stale = $state(true);
  let active = $state(true);
  let checked = $state(true);
  let asks = $state<'never' | 'changes'>('changes');
</script>

<p id="page-banner">Changes are off until it’s back.</p>
<button type="button" onclick={() => (stale = false)}>Back online</button>
{#if outside}
  <Button mutating onclick={onSave}>Save outside</Button>
{/if}
<StaleRegion {stale} {describedBy}>
  <p id="opens-the-editor">Opens the editor</p>
  <Button mutating onclick={onSave}>Save</Button>
  <Button mutating aria-describedby="opens-the-editor">Edit</Button>
  <Button onclick={onRetry}>Retry now</Button>
  {#if link}
    <Button mutating href="/settings">Open settings</Button>
  {/if}
  <Link href="/agents/tool-runner">Tool runner</Link>
  <Toggle id="active-switch" label="Active" mutating bind:checked={active} />
  <Checkbox label="Tool is on" mutating bind:checked />
  <Select
    id="default-asks"
    presentation={listbox ? 'listbox' : 'native'}
    label="Default asks"
    mutating
    bind:value={asks}
    options={[
      { value: 'never', label: 'Never' },
      { value: 'changes', label: 'On changes' },
    ]}
  />
  <Dropdown id="more-menu">
    <DropdownTrigger mutating aria-label="More">More</DropdownTrigger>
    <DropdownMenu>
      <DropdownItem>Delete</DropdownItem>
    </DropdownMenu>
  </Dropdown>
</StaleRegion>
