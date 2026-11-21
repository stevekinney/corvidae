<script lang="ts" module>
  export type { EmptyStateAction, EmptyStateKind, EmptyStateProps } from './empty-state.types.ts';
</script>

<script lang="ts">
  import type { EmptyStateProps } from './empty-state.types.ts';
  import { Check, Funnel, Plug, Search, TriangleAlert } from '@lucide/svelte';

  import Button from '../button/button.svelte';
  import { classNames } from '../../utilities/class-names.ts';

  // One layout wherever the state sits (owner report, 2026-11-19): there is no size, alignment,
  // border or row prop to pick, so a page, a tab and a panel all draw the same state.
  let {
    title,
    description,
    class: className,
    headingLevel = 3,
    kind = 'first-use',
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

  // Normalise at runtime: an unknown kind behaves as the default rather than producing a root
  // attribute no stylesheet rule matches.
  const safeKind = $derived(
    kind === 'filtered' ||
      kind === 'done' ||
      kind === 'blocked' ||
      kind === 'not-found' ||
      kind === 'disabled'
      ? kind
      : 'first-use',
  );
  const showClearFilters = $derived(safeKind === 'filtered' && onClearFilters !== undefined);
  const showAction = $derived(action !== undefined || actions.length > 0);
  // First use shows the view's own icon, so it has no default glyph; every other kind is a state
  // with a glyph of its own, used when the consumer does not pass one. An illustration is a larger
  // picture that stands in for the disc.
  const hasDisc = $derived(
    illustration === undefined && (icon !== undefined || safeKind !== 'first-use'),
  );
</script>

<div
  {...rest}
  class={classNames('cinder-empty-state', className)}
  role="group"
  data-cinder-kind={safeKind}
  aria-labelledby={titleId}
>
  {#if illustration}
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
  <svelte:element this={tag} id={titleId} class="cinder-empty-state-title">
    {title}
  </svelte:element>
  {#if description}
    <p class="cinder-empty-state-description">{description}</p>
  {/if}
  {#if showClearFilters || showAction}
    <div class="cinder-empty-state-action">
      {#if showClearFilters}
        <Button variant="secondary" label={clearFiltersLabel} onclick={() => onClearFilters?.()} />
      {/if}
      {#each actions as item, index (index)}
        {@const variant = item.variant ?? (index === 0 ? 'primary' : 'secondary')}
        {@const describedBy = item.inertReason ? reasonId(index) : undefined}
        {#if item.inertReason}
          <span id={reasonId(index)} class="cinder-sr-only">{item.inertReason}</span>
        {/if}
        {@const icon = item.icon === undefined ? {} : { leadingIcon: item.icon }}
        {#if item.href !== undefined}
          <Button
            {...icon}
            {variant}
            href={item.href}
            target={item.external ? '_blank' : undefined}
            rel={item.external ? 'noopener noreferrer' : undefined}
            onclick={item.onclick}
            mutating={item.mutating ?? false}
            aria-disabled={item.inertReason ? 'true' : undefined}
            aria-describedby={describedBy}
          >
            {item.label}
          </Button>
        {:else}
          <Button
            {...icon}
            {variant}
            onclick={item.onclick}
            mutating={item.mutating ?? false}
            aria-disabled={item.inertReason ? 'true' : undefined}
            aria-describedby={describedBy}
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
  {#if children}
    <div class="cinder-empty-state-details">
      {@render children()}
    </div>
  {/if}
</div>
