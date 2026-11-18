<script lang="ts" module>
  export type {
    GroupedListItemAction,
    GroupedListItemLeadingKind,
    GroupedListItemProps,
    GroupedListItemUrgency,
  } from './grouped-list-item.types.ts';
</script>

<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import Clock from '@lucide/svelte/icons/clock';
  import { classNames } from '../../utilities/class-names.ts';
  import Button from '../button/button.svelte';
  import type { GroupedListItemAction, GroupedListItemProps } from './grouped-list-item.types.ts';

  let {
    title,
    subtitle,
    leading,
    leadingKind = 'icon',
    lead,
    timeWindow,
    timeCaption,
    urgency,
    staleAge,
    photo,
    trailing,
    action,
    actions,
    chevron,
    selected = false,
    suggested = false,
    suggestedLabel = 'Suggested',
    href,
    target,
    rel,
    class: className,
    ...rest
  }: GroupedListItemProps = $props();

  const showChevron = $derived(chevron ?? href !== undefined);

  // A `lead` snippet wins; otherwise a time window makes the row time-led.
  const timed = $derived(!lead && timeWindow !== undefined);

  const generatedId = $props.id();
  const hasActions = $derived(actions !== undefined && actions.length > 0);

  /** Blocks a disabled action's click, as `aria-disabled` alone does not. */
  function guardDisabled(item: GroupedListItemAction) {
    return (event: MouseEvent) => {
      if (item.disabled) {
        event.preventDefault();
        return;
      }
      item.onclick?.(event);
    };
  }

  // `_blank` links always carry noopener and noreferrer, merged into the consumer's tokens.
  const resolvedRel = $derived.by(() => {
    if (target?.toLowerCase() !== '_blank') return rel;
    const tokens = new Set((rel ?? '').split(/\s+/).filter(Boolean));
    tokens.add('noopener');
    tokens.add('noreferrer');
    return [...tokens].join(' ');
  });
</script>

<li
  {...rest}
  class={classNames(
    'cinder-grouped-list-item',
    href !== undefined && 'cinder-grouped-list-item--linked',
    selected && 'cinder-grouped-list-item--selected',
    timed && 'cinder-grouped-list-item--timed',
    hasActions && 'cinder-grouped-list-item--actions',
    trailing !== undefined && 'cinder-grouped-list-item--trailing',
    className,
  )}
  data-cinder-selected={selected ? '' : undefined}
  data-cinder-suggested={suggested ? '' : undefined}
  aria-current={selected && href === undefined ? 'true' : undefined}
>
  {#if leading}
    <div class="cinder-grouped-list-item__leading" data-cinder-leading={leadingKind}>
      {@render leading()}
    </div>
  {/if}
  <div class="cinder-grouped-list-item__content">
    {#if lead}
      <div class="cinder-grouped-list-item__lead">{@render lead()}</div>
    {:else if timed}
      <div
        class="cinder-grouped-list-item__lead cinder-grouped-list-item__lead--timed"
        data-cinder-urgency={urgency}
      >
        <span class="cinder-grouped-list-item__lead-window">{timeWindow}</span>
        {#if timeCaption}
          <span class="cinder-grouped-list-item__lead-caption">{timeCaption}</span>
        {/if}
      </div>
    {/if}
    <div class="cinder-grouped-list-item__text">
      {#if suggested}
        <span class="cinder-grouped-list-item__suggested">{suggestedLabel}</span>
      {/if}
      <div class="cinder-grouped-list-item__title">
        {#if href !== undefined}
          <a
            class="cinder-grouped-list-item__link"
            {href}
            {target}
            rel={resolvedRel}
            aria-current={selected ? 'true' : undefined}>{@render title()}</a
          >
        {:else}
          {@render title()}
        {/if}
      </div>
      {#if subtitle}
        <div class="cinder-grouped-list-item__subtitle">{@render subtitle()}</div>
      {/if}
    </div>
    {#if staleAge}
      <span class="cinder-grouped-list-item__stale">
        <Clock size={12} aria-hidden="true" />
        <span class="cinder-sr-only">Stale, </span>{staleAge}
      </span>
    {/if}
    {#if trailing}
      <div class="cinder-grouped-list-item__trailing">{@render trailing()}</div>
    {/if}
    <!-- The photo sits at the end of the row, after the trailing value: a row with a photo and one
         without keep everything else in the same place. -->
    {#if photo}
      <div class="cinder-grouped-list-item__photo">{@render photo()}</div>
    {/if}
    {#if showChevron}
      <span class="cinder-grouped-list-item__chevron" aria-hidden="true">
        <ChevronRight size={16} />
      </span>
    {/if}
    {#if action}
      <div class="cinder-grouped-list-item__action">{@render action()}</div>
    {/if}
    {#if hasActions && actions}
      <div class="cinder-grouped-list-item__actions">
        {#each actions as item, index (index)}
          {@const reasonId = `${generatedId}-action-${index}-reason`}
          {#if item.href !== undefined}
            <Button
              variant="secondary"
              size="sm"
              href={item.href}
              data-changes={item.changes ? '' : undefined}
              aria-disabled={item.disabled ? 'true' : undefined}
              aria-describedby={item.disabled && item.disabledReason ? reasonId : undefined}
              title={item.disabled ? item.disabledReason : undefined}
              onclick={guardDisabled(item)}
            >
              {item.label}
            </Button>
          {:else}
            <Button
              variant="secondary"
              size="sm"
              data-changes={item.changes ? '' : undefined}
              aria-disabled={item.disabled ? 'true' : undefined}
              aria-describedby={item.disabled && item.disabledReason ? reasonId : undefined}
              title={item.disabled ? item.disabledReason : undefined}
              onclick={guardDisabled(item)}
            >
              {item.label}
            </Button>
          {/if}
          {#if item.disabled && item.disabledReason}
            <span id={reasonId} class="cinder-sr-only">{item.disabledReason}</span>
          {/if}
        {/each}
      </div>
    {/if}
  </div>
</li>
