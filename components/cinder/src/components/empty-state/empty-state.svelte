<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status stable
   * @purpose Centered placeholder with optional icon, title, description, and call-to-action for views that have no data to render.
   * @tag feedback
   * @tag empty
   * @useWhen Communicating that a list, table, or workspace has no items yet and suggesting a next step.
   * @useWhen Replacing a primary content region after a filter or search returns no results.
   * @useWhen Confirming that all work is finished with the done kind, or that a filter hid every item with the filtered kind.
   * @avoidWhen Indicating that data is still loading — use skeleton or spinner instead.
   * @avoidWhen Reporting a transient error — use alert, banner, or toast-region.
   * @related skeleton, spinner
   */
  export type {
    EmptyStateAlign,
    EmptyStateKind,
    EmptyStateProps,
    EmptyStateSize,
  } from './empty-state.types.ts';
</script>

<script lang="ts">
  import type { EmptyStateProps } from './empty-state.types.ts';
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
    onClearFilters,
    clearFiltersLabel = 'Clear filters',
    icon,
    action,
    ...rest
  }: EmptyStateProps = $props();

  // SSR-safe, per-instance id so the container can name itself from its title,
  // giving the heading a programmatic relationship to the region it labels.
  const titleId = $props.id();

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
  const safeKind = $derived(kind === 'filtered' || kind === 'done' ? kind : 'first-use');
  const safeSize = $derived(size === 'compact' ? 'compact' : 'default');
  const showClearFilters = $derived(safeKind === 'filtered' && onClearFilters !== undefined);
  const showAction = $derived(safeKind !== 'done' && action !== undefined);
</script>

<div
  {...rest}
  class={classNames('cinder-empty-state', className)}
  role="group"
  data-cinder-align={align === 'start' ? 'start' : undefined}
  data-cinder-kind={safeKind}
  data-cinder-size={safeSize}
  aria-labelledby={titleId}
>
  {#if icon}
    <div class="cinder-empty-state-icon" aria-hidden="true">
      {@render icon()}
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
        <Button
          variant="secondary"
          size={safeSize === 'compact' ? 'sm' : 'md'}
          label={clearFiltersLabel}
          onclick={() => onClearFilters?.()}
        />
      {/if}
      {#if showAction && action}
        {@render action()}
      {/if}
    </div>
  {/if}
</div>
