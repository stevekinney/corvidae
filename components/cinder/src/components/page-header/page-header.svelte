<script lang="ts" module>
  /**
   * @cinder
   * @category layout
   * @status stable
   * @purpose Page-level heading with named title, description, breadcrumb, and action regions.
   * @tag page
   * @tag heading
   * @tag layout
   * @useWhen Rendering a route-level heading that needs consistent spacing and border treatment across pages.
   * @useWhen Pairing page context and supporting copy with optional right-aligned controls.
   * @avoidWhen Rendering section-scoped headings within page content — use section-heading.
   * @avoidWhen Building complex hero layouts with rich copy and media — compose container (see its hero-section example).
   * @related section-heading, container
   */
  export type {
    PageHeaderCreateAction,
    PageHeaderHeadingLevel,
    PageHeaderProps,
    PageHeaderStatusPlacement,
  } from './page-header.types.ts';
</script>

<script lang="ts">
  import Plus from '@lucide/svelte/icons/plus';

  import { setActionEmphasisContext } from '../../_internal/action-emphasis-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { useResizeObserver } from '../../utilities/use-resize-observer.svelte.ts';
  import Button from '../button/button.svelte';
  import Tooltip from '../tooltip/tooltip.svelte';
  import type { PageHeaderProps } from './page-header.types.ts';

  const headerId = $props.id();
  const createReasonId = `${headerId}-create-reason`;

  let {
    title,
    headingLevel = 1,
    description,
    breadcrumbs,
    actions,
    createAction,
    error = false,
    flush = false,
    divider = false,
    status,
    statusPlacement = 'below',
    titleText,
    class: className,
    ...rest
  }: PageHeaderProps = $props();

  // Clamp to 1–6 so an out-of-range value from an untyped caller (JS, schema-driven usage)
  // never builds <h0>/<hNaN>. Matches Card's heading clamp.
  const resolvedHeadingLevel = $derived(
    Number.isFinite(Math.trunc(Number(headingLevel)))
      ? Math.min(6, Math.max(1, Math.trunc(Number(headingLevel))))
      : 1,
  );
  const titleTag = $derived(`h${resolvedHeadingLevel}` as const);

  // The title keeps two lines and then ends in an ellipsis. Only a title that is actually cut
  // off gets the Cinder tooltip with all of it, and a stop of its own so the keyboard reaches it:
  // a native `title` attribute is neither, and would repeat every short title on hover.
  const fullTitle = $derived(typeof title === 'string' ? title : titleText);
  let titleElement = $state<HTMLElement | null>(null);
  let titleCutOff = $state(false);
  function measureTitle(): void {
    titleCutOff =
      titleElement !== null && titleElement.scrollHeight - titleElement.clientHeight > 1;
  }
  const observeTitle = useResizeObserver(measureTitle);
  $effect(() => {
    // The words can change without the box changing size.
    void fullTitle;
    void title;
    measureTitle();
  });

  // While a full-page error shows under the header its primary buttons draw as secondary.
  setActionEmphasisContext({
    get demotePrimary() {
      return error;
    },
  });
</script>

{#snippet statusLine(placement: 'inline' | 'below')}
  {#if status}
    <div class="cinder-page-header__status" data-cinder-placement={placement}>
      {@render status()}
    </div>
  {/if}
{/snippet}

{#snippet createIcon()}
  {#if createAction?.icon}
    {@render createAction.icon()}
  {:else}
    <Plus class="cinder-icon-sm" aria-hidden="true" />
  {/if}
{/snippet}

{#snippet createActionButton()}
  {#if createAction}
    {#if createAction.inertReason}
      <span id={createReasonId} class="cinder-sr-only">{createAction.inertReason}</span>
    {/if}
    <Tooltip text={createAction.label} describe={false}>
      {#if createAction.href !== undefined}
        <Button
          variant="secondary"
          iconOnly
          href={createAction.href}
          aria-label={createAction.label}
          aria-disabled={createAction.inertReason ? 'true' : undefined}
          aria-describedby={createAction.inertReason ? createReasonId : undefined}
          mutating={createAction.mutating ?? true}
          onclick={createAction.onclick}
          class="cinder-page-header__create"
        >
          {@render createIcon()}
        </Button>
      {:else}
        <Button
          variant="secondary"
          iconOnly
          aria-label={createAction.label}
          aria-disabled={createAction.inertReason ? 'true' : undefined}
          aria-describedby={createAction.inertReason ? createReasonId : undefined}
          disabled={createAction.disabled}
          mutating={createAction.mutating ?? true}
          onclick={createAction.onclick}
          class="cinder-page-header__create"
        >
          {@render createIcon()}
        </Button>
      {/if}
    </Tooltip>
  {/if}
{/snippet}

<div
  class={classNames(
    'cinder-page-header',
    createAction && !actions && 'cinder-page-header--create-only',
    className,
  )}
  data-cinder-flush={flush ? 'true' : undefined}
  data-cinder-divider={divider && !flush ? 'true' : undefined}
  {...rest}
>
  {#if breadcrumbs}
    <div class="cinder-page-header__breadcrumbs">
      {@render breadcrumbs()}
    </div>
  {/if}

  <div class="cinder-page-header__row">
    <div class="cinder-page-header__heading-group">
      <div class="cinder-page-header__title-line">
        <svelte:element
          this={titleTag}
          bind:this={titleElement}
          class="cinder-page-header__title"
          tabindex={titleCutOff && fullTitle ? 0 : undefined}
          {@attach observeTitle}
        >
          {#if typeof title === 'string'}
            {title}
          {:else}
            {@render title()}
          {/if}
        </svelte:element>
        {#if titleCutOff && fullTitle}
          <Tooltip text={fullTitle} describe={false} triggerRef={titleElement} />
        {/if}
        {#if statusPlacement === 'inline'}
          {@render statusLine('inline')}
        {/if}
      </div>
      {#if statusPlacement !== 'inline'}
        {@render statusLine('below')}
      {/if}
      {#if description}
        <p class="cinder-page-header__description">
          {#if typeof description === 'string'}
            {description}
          {:else}
            {@render description()}
          {/if}
        </p>
      {/if}
    </div>

    {#if actions || createAction}
      <div class="cinder-page-header__actions">
        {#if actions}{@render actions()}{/if}
        {@render createActionButton()}
      </div>
    {/if}
  </div>
</div>
