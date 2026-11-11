<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status beta
   * @purpose Row of a grouped list with leading icon, avatar, thumbnail or control, a fixed lead column, title, subtitle, and trailing value, photo, chevron and action; the whole row is the link.
   * @tag list
   * @tag row
   * @useWhen Listing entities inside a grouped list, each with a leading glyph, a title and a secondary line.
   * @useWhen Linking each row to a detail view by passing href, which makes the whole row one link.
   * @avoidWhen Showing a status-first run or approval row with details — use stacked-list-item.
   * @avoidWhen Comparing values across columns — use table.
   * @related grouped-list, stacked-list-item, avatar
   * @rationale Nearest alternative: StackedListItem — a grouped-list row has no border of its own; the group draws one rounded surface and inset separators.
   */
  export type {
    GroupedListItemLeadingKind,
    GroupedListItemProps,
  } from './grouped-list-item.types.ts';
</script>

<script lang="ts">
  import { ChevronRight } from '@lucide/svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import type { GroupedListItemProps } from './grouped-list-item.types.ts';

  let {
    title,
    subtitle,
    leading,
    leadingKind = 'icon',
    lead,
    photo,
    trailing,
    action,
    chevron,
    selected = false,
    href,
    target,
    rel,
    class: className,
    ...rest
  }: GroupedListItemProps = $props();

  const showChevron = $derived(chevron ?? href !== undefined);

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
    className,
  )}
  data-cinder-selected={selected ? '' : undefined}
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
    {/if}
    <div class="cinder-grouped-list-item__text">
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
    {#if photo}
      <div class="cinder-grouped-list-item__photo">{@render photo()}</div>
    {/if}
    {#if trailing}
      <div class="cinder-grouped-list-item__trailing">{@render trailing()}</div>
    {/if}
    {#if showChevron}
      <span class="cinder-grouped-list-item__chevron" aria-hidden="true">
        <ChevronRight size={16} />
      </span>
    {/if}
    {#if action}
      <div class="cinder-grouped-list-item__action">{@render action()}</div>
    {/if}
  </div>
</li>
