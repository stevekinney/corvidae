<script lang="ts" module>
  export type {
    EmptyStateAction,
    EmptyStateAlign,
    EmptyStateKind,
    EmptyStateLayout,
    EmptyStateProps,
    EmptyStateSize,
  } from './empty-state.types.ts';
</script>

<script lang="ts">
  import type { EmptyStateProps } from './empty-state.types.ts';
  import { Check, Funnel, Plug, Search, TriangleAlert } from '@lucide/svelte';

  import Button from '../button/button.svelte';
  import { classNames } from '../../utilities/class-names.ts';

  let {
    title,
    description,
    class: className,
    headingLevel = 3,
    align = 'center',
    kind = 'first-use',
    size = 'default',
    layout = 'stacked',
    bordered = false,
    onClearFilters,
    clearFiltersLabel = 'Clear filters',
    icon,
    illustration,
    action,
    actions = [],
    children,
    ...rest
  }: EmptyStateProps = $props();

  // SSR-safe, per-instance id so the container can name itself from its title,
  // giving the heading a programmatic relationship to the region it labels.
  const titleId = $props.id();
  /** The id of an inert action's reason, which describes its button. */
  const reasonId = (index: number): string => `${titleId}-action-${String(index)}-reason`;

  // Coerce + clamp at runtime: a consumer can pass 0, 7, NaN, or a non-numeric
  // value despite the TS literal union, and <h0>/<hNaN> is invalid markup.
  const safeLevel = $derived(
    Number.isFinite(Math.trunc(Number(headingLevel)))
      ? Math.min(6, Math.max(1, Math.trunc(Number(headingLevel))))
      : 3,
  );
  const tag = $derived(`h${safeLevel}`);

  // Normalise at runtime: an unknown kind or size behaves as the default rather than
  // producing a root attribute no stylesheet rule matches.
  const safeKind = $derived(
    kind === 'filtered' ||
      kind === 'done' ||
      kind === 'blocked' ||
      kind === 'not-found' ||
      kind === 'disabled'
      ? kind
      : 'first-use',
  );
  const safeLayout = $derived(
    layout === 'row' || layout === 'inline' || layout === 'page' ? layout : 'stacked',
  );
  const isPage = $derived(safeLayout === 'page');
  // A list page's first use has one layout on every page: the default size, centred across, and
  // never boxed, whatever the page passes.
  const safeSize = $derived(size === 'compact' && !isPage ? 'compact' : 'default');
  const isInline = $derived(safeLayout === 'inline');
  const showClearFilters = $derived(safeKind === 'filtered' && onClearFilters !== undefined);
  const showAction = $derived(action !== undefined || actions.length > 0);
  // First use shows the view's own icon, so it has no default glyph; every other kind is a state
  // with a glyph of its own, used when the consumer does not pass one.
  // An illustration is a larger picture that stands in for the disc, so it is drawn only in the
  // stacked layout, where the state has the room; a row or an inline state keeps its disc.
  const hasIllustration = $derived(
    illustration !== undefined && (safeLayout === 'stacked' || isPage),
  );
  const hasDisc = $derived(!hasIllustration && (icon !== undefined || safeKind !== 'first-use'));
  // Supporting content under the action, such as steps, in the stacked and page layouts only: a row
  // or an inline state is one line and has no room under its action.
  const showDetails = $derived(children !== undefined && (safeLayout === 'stacked' || isPage));
</script>

<div
  {...rest}
  class={classNames('cinder-empty-state', className)}
  role="group"
  data-cinder-align={align === 'start' && !isPage ? 'start' : undefined}
  data-cinder-kind={safeKind}
  data-cinder-size={safeSize}
  data-cinder-layout={safeLayout === 'stacked' ? undefined : safeLayout}
  data-cinder-bordered={bordered && !isPage ? '' : undefined}
  aria-labelledby={titleId}
>
  {#if hasIllustration && illustration}
    <div class="cinder-empty-state-illustration" aria-hidden="true">
      {@render illustration()}
    </div>
  {/if}
  {#if hasDisc}
    <div class="cinder-empty-state-icon" aria-hidden="true">
      {#if icon}
        {@render icon()}
      {:else if safeKind === 'done'}
        <Check />
      {:else if safeKind === 'filtered'}
        <Funnel />
      {:else if safeKind === 'not-found'}
        <Search />
      {:else if safeKind === 'disabled'}
        <Plug />
      {:else}
        <TriangleAlert />
      {/if}
    </div>
  {/if}
  {#if isInline}
    <div class="cinder-empty-state-text">
      <svelte:element this={tag} id={titleId} class="cinder-empty-state-title">
        {title}
      </svelte:element>
      {#if description}
        <p class="cinder-empty-state-description">{description}</p>
      {/if}
    </div>
  {:else}
    <svelte:element this={tag} id={titleId} class="cinder-empty-state-title">
      {title}
    </svelte:element>
    {#if description}
      <p class="cinder-empty-state-description">{description}</p>
    {/if}
  {/if}
  {#if showClearFilters || showAction}
    <div class="cinder-empty-state-action">
      {#if showClearFilters}
        <Button
          variant="secondary"
          size={safeSize === 'compact' ? 'sm' : 'md'}
          label={clearFiltersLabel}
          onclick={() => onClearFilters?.()}
        />
      {/if}
      {#each actions as item, index (index)}
        {@const variant = item.variant ?? (index === 0 ? 'primary' : 'secondary')}
        {@const describedBy = item.inertReason ? reasonId(index) : undefined}
        {#if item.inertReason}
          <span id={reasonId(index)} class="cinder-sr-only">{item.inertReason}</span>
        {/if}
        {#if item.href !== undefined}
          <Button
            {variant}
            href={item.href}
            onclick={item.onclick}
            mutating={item.mutating ?? false}
            aria-disabled={item.inertReason ? 'true' : undefined}
            aria-describedby={describedBy}
            leadingIcon={item.icon}
          >
            {item.label}
          </Button>
        {:else}
          <Button
            {variant}
            onclick={item.onclick}
            mutating={item.mutating ?? false}
            aria-disabled={item.inertReason ? 'true' : undefined}
            aria-describedby={describedBy}
            leadingIcon={item.icon}
          >
            {item.label}
          </Button>
        {/if}
      {/each}
      {#if action}
        {@render action()}
      {/if}
    </div>
  {/if}
  {#if showDetails && children}
    <div class="cinder-empty-state-details">
      {@render children()}
    </div>
  {/if}
</div>
