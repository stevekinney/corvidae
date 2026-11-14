<script lang="ts">
  import Button from '../../components/button/button.svelte';
  import type { ButtonSize, ButtonVariant } from '../../components/button/button.types.ts';
  import ButtonGroup from '../../components/button-group/button-group.svelte';
  import Dropdown from '../../components/dropdown/dropdown.svelte';
  import DropdownItem from '../../components/dropdown-item/dropdown-item.svelte';
  import DropdownMenu from '../../components/dropdown-menu/dropdown-menu.svelte';
  import DropdownTrigger from '../../components/dropdown-trigger/dropdown-trigger.svelte';

  type Props = {
    actionVariant?: ButtonVariant;
    actionSize?: ButtonSize;
    triggerVariant?: ButtonVariant;
    grouped?: boolean;
  };

  let {
    actionVariant = 'soft',
    actionSize = 'md',
    triggerVariant,
    grouped = true,
  }: Props = $props();
  // Only pass `variant` when the test sets one, so the trigger's own default is what is tested.
  const triggerProps = $derived(triggerVariant === undefined ? {} : { variant: triggerVariant });
</script>

{#snippet menu()}
  <Dropdown id="split-menu">
    <DropdownTrigger class="trigger" aria-label="More options" {...triggerProps} />
    <DropdownMenu>
      <DropdownItem>Save as draft</DropdownItem>
    </DropdownMenu>
  </Dropdown>
{/snippet}

{#if grouped}
  <ButtonGroup label="Save options">
    <Button variant={actionVariant} size={actionSize}>Save</Button>
    {@render menu()}
  </ButtonGroup>
{:else}
  {@render menu()}
{/if}
