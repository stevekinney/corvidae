<script lang="ts" module>
  /**
   * @cinder
   * @category navigation
   * @status stable
   * @purpose Hierarchical wayfinding trail showing the ancestor path of the current page with the final entry marked as aria-current.
   * @tag navigation
   * @tag wayfinding
   * @useWhen Surfacing where the user sits inside a deep, nested hierarchy.
   * @useWhen Letting the user jump back to any ancestor view in one click.
   * @avoidWhen Switching between sibling sections at the same level — use navigation-bar or tabs.
   * @avoidWhen Showing an ordered task progression — use steps instead.
   * @related navigation-bar, side-navigation, steps
   */
  export type { BreadcrumbItem, BreadcrumbsProps } from './breadcrumbs.types.ts';
</script>

<script lang="ts">
  import ChevronDown from '@lucide/svelte/icons/chevron-down';
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';

  import {
    PHONE_VIEWPORT_BREAKPOINT,
    readViewportBreakpoint,
    useViewportBelow,
  } from '../../_internal/viewport-below.svelte.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import Popover from '../popover/popover.svelte';
  import type { BreadcrumbsProps } from './breadcrumbs.types.ts';

  // 24rem at the default 16px root: the container width under which only one ancestor shows.
  const NARROW_CONTAINER_PIXELS = 384;

  let {
    items,
    separator = '/',
    label = 'Breadcrumb',
    collapseBelow = PHONE_VIEWPORT_BREAKPOINT,
    backLabel = 'Back to {label}',
    maxVisible,
    overflowLabel = 'Show earlier pages',
    onOverflowNavigate,
    class: className,
    ...rest
  }: BreadcrumbsProps = $props();

  // Below `collapseBelow` the trail is a back link to the parent plus the current page. The
  // choice is made in script, not in CSS, so the ancestors that are not shown are not in the
  // page at all; server markup is always the whole trail.
  const collapseBreakpoint = $derived(
    readViewportBreakpoint(collapseBelow, 'Breadcrumbs', 'collapseBelow'),
  );
  const viewport = useViewportBelow(() => collapseBreakpoint);
  const collapsed = $derived(viewport.current);

  const current = $derived(items.at(-1));
  const parent = $derived(items.length > 1 ? items[items.length - 2] : undefined);
  const shownItems = $derived(collapsed && current !== undefined ? [current] : items);
  const backName = $derived(
    parent === undefined ? undefined : backLabel.replaceAll('{label}', parent.label),
  );

  // The trail's own width, which a container query cannot report to script. Unset until measured,
  // so server markup and the first paint show every ancestor.
  let trailWidth = $state<number | undefined>(undefined);
  const visibleAncestors = $derived.by(() => {
    if (maxVisible !== undefined) {
      if (!Number.isInteger(maxVisible) || maxVisible < 0) {
        throw new Error('Breadcrumbs maxVisible must be a whole number of zero or more.');
      }
      return maxVisible;
    }
    return trailWidth !== undefined && trailWidth > 0 && trailWidth < NARROW_CONTAINER_PIXELS
      ? 1
      : Number.POSITIVE_INFINITY;
  });
  // The ancestors that fold away are the earliest ones: the nearest keep their place.
  const hiddenCount = $derived(
    Math.max(0, shownItems.length - 1 - Math.min(visibleAncestors, shownItems.length - 1)),
  );
  const hiddenItems = $derived(shownItems.slice(0, hiddenCount));
  const visibleItems = $derived(shownItems.slice(hiddenCount));
  let overflowOpen = $state(false);
  let overflowTrigger = $state<HTMLButtonElement | null>(null);

  // The current entry opens a popover when it asks for one, such as a long title's full text.
  let popoverOpen = $state(false);
  let triggerElement = $state<HTMLButtonElement | null>(null);
</script>

<nav
  {...rest}
  class={classNames('cinder-breadcrumbs', className)}
  aria-label={label}
  data-cinder-collapsed={collapsed ? '' : undefined}
  bind:clientWidth={trailWidth}
>
  {#if collapsed && parent?.href !== undefined}
    <a class="cinder-breadcrumbs__back" href={parent.href} aria-label={backName}>
      <ChevronLeft class="cinder-breadcrumbs__back-icon" aria-hidden="true" />
      <span class="cinder-breadcrumbs__back-label">{parent.label}</span>
    </a>
  {/if}
  <ol class="cinder-breadcrumbs__list">
    <!--
      Key is `href`/`label` (the closest thing to a stable identity a breadcrumb
      has) with `index` always appended. `index` alone is already unique per
      render, so prefixing it — followed by a delimiter no numeral can contain —
      makes the whole key unique regardless of what `href`/`label` contain,
      including two entries that legitimately share an `href` (e.g. repeated
      section-landing links) or the href-less current-page entry.
    -->
    {#if hiddenItems.length > 0}
      <li class="cinder-breadcrumbs__item cinder-breadcrumbs__item--overflow">
        <button
          type="button"
          bind:this={overflowTrigger}
          class="cinder-breadcrumbs__overflow"
          aria-label={overflowLabel}
          aria-haspopup="true"
          aria-expanded={overflowOpen}
          onclick={() => (overflowOpen = !overflowOpen)}
        >
          <span aria-hidden="true">…</span>
        </button>
        <Popover bind:open={overflowOpen} triggerRef={overflowTrigger} label={overflowLabel}>
          <ul class="cinder-breadcrumbs__overflow-list">
            {#each hiddenItems as hidden (`${hidden.href ?? hidden.label}`)}
              <li>
                <a
                  class="cinder-breadcrumbs__overflow-link"
                  href={hidden.href}
                  onclick={(event) => {
                    overflowOpen = false;
                    onOverflowNavigate?.(hidden, event);
                  }}>{hidden.label}</a
                >
              </li>
            {/each}
          </ul>
        </Popover>
        <span class="cinder-breadcrumbs__separator" aria-hidden="true">
          {#if typeof separator === 'string'}
            {separator}
          {:else}
            {@render separator()}
          {/if}
        </span>
      </li>
    {/if}
    {#each visibleItems as item, index (`${hiddenCount + index}:${item.href ?? item.label}`)}
      {@const isLast = index === visibleItems.length - 1}
      <li class="cinder-breadcrumbs__item">
        {#if isLast && item.popover !== undefined}
          <!-- Current page with a popover: the label truncates inside the button, so the full
             text lives in the popover. -->
          <button
            type="button"
            bind:this={triggerElement}
            aria-current="page"
            class="cinder-breadcrumbs__current cinder-breadcrumbs__trigger"
            onclick={() => (popoverOpen = !popoverOpen)}
          >
            <span class="cinder-breadcrumbs__trigger-label">{item.label}</span>
            <ChevronDown class="cinder-breadcrumbs__trigger-icon" aria-hidden="true" />
          </button>
          <Popover
            bind:open={popoverOpen}
            triggerRef={triggerElement}
            label={item.label}
            focusManagement="preserve"
          >
            {#if item.popover === true}
              <p class="cinder-breadcrumbs__popover-text">{item.label}</p>
            {:else}
              {@render item.popover()}
            {/if}
          </Popover>
        {:else if isLast}
          <!-- Current page: rendered as plain text, not a link. -->
          <span aria-current="page" class="cinder-breadcrumbs__current">{item.label}</span>
        {:else}
          <a class="cinder-breadcrumbs__link" href={item.href}>{item.label}</a>
          <span class="cinder-breadcrumbs__separator" aria-hidden="true">
            {#if typeof separator === 'string'}
              {separator}
            {:else}
              {@render separator()}
            {/if}
          </span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>
