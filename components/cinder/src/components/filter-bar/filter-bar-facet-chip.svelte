<script lang="ts">
  /**
   * A choice facet drawn as a chip. Unapplied it is a dashed add-facet chip ("+ Started by");
   * applied it is a tinted chip that reads "Started by: Chats, Goals" with an x that removes the
   * filter. Either way the label opens the facet's popover, so an applied facet can be edited
   * without being removed first.
   */
  import Plus from '@lucide/svelte/icons/plus';
  import X from '@lucide/svelte/icons/x';

  import { default as Popover } from '../popover/index.ts';
  import FilterBarOptions from './filter-bar-options.svelte';
  import { appliedSummary, appliedValues } from './filter-bar.utilities.ts';
  import type { AppliedFilter, ChoiceFacet } from './filter-bar.types.ts';

  type Props = {
    /** The facet the chip stands for. */
    facet: ChoiceFacet;
    /** The facet's applied filter, when it has one. */
    applied: AppliedFilter | undefined;
    /** Id of the chip's label button, so focus can return to it after a removal. */
    triggerId: string;
    /** Whether the chip can be used. */
    disabled: boolean;
    /** Called when a multiple choice facet changes. */
    onValuesChange: (values: readonly string[]) => void;
    /** Called when a single choice facet changes. */
    onValueChange: (value: string) => void;
    /** Called when the x removes the filter. */
    onRemove: () => void;
  };

  let { facet, applied, triggerId, disabled, onValuesChange, onValueChange, onRemove }: Props =
    $props();

  const titleId = $props.id();
  let open = $state(false);
  let trigger: HTMLButtonElement | null = $state(null);

  const values = $derived(applied === undefined ? [] : appliedValues(applied));
  const hasValue = $derived(values.length > 0);
  const summary = $derived(applied === undefined ? '' : appliedSummary(facet, applied));
  const unavailable = $derived(disabled || facet.disabled === true);
</script>

<span
  class="cinder-filter-bar__chip"
  data-cinder-applied={hasValue ? '' : undefined}
  data-cinder-open={open ? '' : undefined}
  data-cinder-disabled={unavailable ? '' : undefined}
>
  <button
    bind:this={trigger}
    id={triggerId}
    type="button"
    class="cinder-filter-bar__chip-trigger"
    disabled={unavailable}
    aria-haspopup="dialog"
    aria-expanded={open}
    onclick={() => (open = !open)}
  >
    {#if hasValue}
      <span class="cinder-filter-bar__chip-label">{facet.label}:</span>
      <span class="cinder-filter-bar__chip-value">{summary}</span>
    {:else}
      <Plus class="cinder-icon-xs" aria-hidden="true" />
      <span class="cinder-filter-bar__chip-label">{facet.label}</span>
    {/if}
  </button>
  {#if hasValue}
    <button
      type="button"
      class="cinder-filter-bar__chip-remove"
      disabled={unavailable}
      aria-label={`Remove filter: ${facet.label}: ${summary}`}
      onclick={onRemove}
    >
      <X class="cinder-icon-xs" aria-hidden="true" />
    </button>
  {/if}
</span>

<Popover bind:open triggerRef={trigger} label={facet.title ?? facet.label} placement="bottom-start">
  <FilterBarOptions
    {facet}
    {values}
    {titleId}
    disabled={unavailable}
    {onValuesChange}
    {onValueChange}
  />
</Popover>
