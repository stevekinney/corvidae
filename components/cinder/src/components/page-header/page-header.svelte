<script lang="ts" module>
  /**
   * @cinder
   * @category layout
   * @status stable
   * @purpose Page-level heading with named title, description, breadcrumb, and action regions, as a default header, a large title that collapses on scroll, or a full-bleed hero band.
   * @tag page
   * @tag heading
   * @tag layout
   * @useWhen Rendering a route-level heading that needs consistent spacing and border treatment across pages.
   * @useWhen Pairing page context and supporting copy with optional right-aligned controls.
   * @useWhen Opening an overview page with a full-bleed hero band: an eyebrow, a display title, facts and one focal value.
   * @avoidWhen Rendering section-scoped headings within page content — use section-heading.
   * @avoidWhen Building a marketing page with photography and several columns of copy — compose container (see its hero-section example).
   * @related section-heading, container, app-bar
   */
  export type {
    PageHeaderCreateAction,
    PageHeaderHeadingLevel,
    PageHeaderOverflowAction,
    PageHeaderProps,
    PageHeaderStatusPlacement,
    PageHeaderTone,
    PageHeaderVariant,
  } from './page-header.types.ts';
</script>

<script lang="ts">
  import Ellipsis from '@lucide/svelte/icons/ellipsis';
  import Plus from '@lucide/svelte/icons/plus';

  import { setActionEmphasisContext } from '../../_internal/action-emphasis-context.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { useIntersection } from '../../utilities/use-intersection.svelte.ts';
  import { useResizeObserver } from '../../utilities/use-resize-observer.svelte.ts';
  import CompactActions from '../../_internal/compact-actions.svelte';
  import Button from '../button/button.svelte';
  import { Dropdown } from '../dropdown/index.ts';
  import Tooltip from '../tooltip/tooltip.svelte';
  import type { PageHeaderOverflowAction, PageHeaderProps } from './page-header.types.ts';

  const headerId = $props.id();
  const createReasonId = `${headerId}-create-reason`;

  let {
    title,
    titleSoft,
    headingLevel = 1,
    variant = 'default',
    tone = 'plain',
    eyebrow,
    description,
    breadcrumbs,
    actions,
    decisions,
    overflow,
    overflowLabel = 'More actions',
    facts,
    media,
    art,
    focal,
    collapsed = $bindable(false),
    collapsedBar = true,
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

  // An unknown variant or tone from an untyped caller draws the default header and the plain band.
  const resolvedVariant = $derived(variant === 'large' || variant === 'hero' ? variant : 'default');
  const resolvedTone = $derived(
    tone === 'tint' || tone === 'accent' || tone === 'night' ? tone : 'plain',
  );
  const hero = $derived(resolvedVariant === 'hero');
  // The accent and night bands are dark whatever the page's theme, so they are dark theme islands:
  // every Cinder token inside resolves to its dark value, and the band redeclares the few a button
  // and a segmented control read (page-header.css).
  const darkBand = $derived(hero && (resolvedTone === 'accent' || resolvedTone === 'night'));

  // A decision is never hidden: an overflow action marked `decision` is drawn as a visible button
  // beside the `decisions` group, and only the rest go in the menu.
  const decisionOverflow = $derived((overflow ?? []).filter((action) => action.decision === true));
  const menuOverflow = $derived((overflow ?? []).filter((action) => action.decision !== true));
  const hasDecisions = $derived(decisions !== undefined || decisionOverflow.length > 0);
  const hasActions = $derived(
    hasDecisions || actions !== undefined || createAction !== undefined || menuOverflow.length > 0,
  );

  // The title keeps two lines and then ends in an ellipsis. Only a title that is actually cut
  // off gets the Cinder tooltip with all of it, and a stop of its own so the keyboard reaches it:
  // a native `title` attribute is neither, and would repeat every short title on hover.
  const fullTitle = $derived(typeof title === 'string' ? `${title}${titleSoft ?? ''}` : titleText);
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

  // A large title has collapsed once it is out of view above the middle of the viewport: scrolled
  // away upward, not waiting below the fold. Measured against the viewport, so it also holds when
  // the page scrolls inside a region of its own.
  function trackTitle(entry: IntersectionObserverEntry): void {
    const middle = entry.rootBounds ? entry.rootBounds.top + entry.rootBounds.height / 2 : 0;
    collapsed = !entry.isIntersecting && entry.boundingClientRect.top < middle;
  }
  const titleIntersection = useIntersection(trackTitle, {
    enabled: () => resolvedVariant === 'large',
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

{#snippet softTitle()}{#if titleSoft}<span class="cinder-page-header__title-soft">{titleSoft}</span
    >{/if}{/snippet}

{#snippet titleWords()}
  {#if typeof title === 'string'}
    {title}{@render softTitle()}
  {:else}
    {@render title()}{@render softTitle()}
  {/if}
{/snippet}

{#snippet headingBody()}
  <div class="cinder-page-header__title-line">
    <svelte:element
      this={titleTag}
      bind:this={titleElement}
      class="cinder-page-header__title"
      tabindex={titleCutOff && fullTitle ? 0 : undefined}
      {@attach observeTitle}
      {@attach titleIntersection}
    >
      {@render titleWords()}
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

{#snippet decisionButton(action: PageHeaderOverflowAction)}
  {#if action.href !== undefined}
    <Button
      variant={action.danger ? 'danger' : 'secondary'}
      href={action.href}
      aria-disabled={action.disabled ? 'true' : undefined}
      onclick={action.onclick}
    >
      {action.label}
    </Button>
  {:else}
    <Button
      variant={action.danger ? 'danger' : 'secondary'}
      aria-disabled={action.disabled ? 'true' : undefined}
      onclick={action.onclick}
    >
      {action.label}
    </Button>
  {/if}
{/snippet}

{#snippet actionGroups()}
  {#if hasDecisions}
    <div class="cinder-page-header__decisions">
      {#if decisions}{@render decisions()}{/if}
      {#each decisionOverflow as action, index (index)}
        {@render decisionButton(action)}
      {/each}
    </div>
  {/if}
  {#if actions}{@render actions()}{/if}
  {#if menuOverflow.length > 0}
    <Dropdown id={`${headerId}-overflow`} placement="bottom-end">
      <Dropdown.Trigger
        class="cinder-page-header__overflow"
        caretVisible={false}
        aria-label={overflowLabel}
      >
        <Ellipsis class="cinder-icon-sm" aria-hidden="true" />
      </Dropdown.Trigger>
      <Dropdown.Menu>
        {#each menuOverflow as action, index (index)}
          <Dropdown.Item
            {...action.href !== undefined ? { href: action.href } : {}}
            variant={action.danger ? 'danger' : 'default'}
            disabled={action.disabled}
            onclick={action.onclick}
          >
            {action.label}
          </Dropdown.Item>
        {/each}
      </Dropdown.Menu>
    </Dropdown>
  {/if}
  {@render createActionButton()}
{/snippet}

{#if resolvedVariant === 'large' && collapsedBar}
  <!-- The title again, at the default size, in a sticky bar once the large title scrolls away. It
       sits before the header, in the page's flow, so it stays stuck for the whole page; the heading
       itself stays where it is, so the bar is hidden from assistive technology. -->
  <div
    class="cinder-page-header__bar"
    data-cinder-collapsed={collapsed ? '' : undefined}
    aria-hidden="true"
  >
    <div class="cinder-page-header__bar-surface">
      <span class="cinder-page-header__bar-title">{@render titleWords()}</span>
    </div>
  </div>
{/if}

<div
  class={classNames('cinder-page-header', className)}
  data-cinder-flush={flush ? 'true' : undefined}
  data-cinder-divider={divider && !flush ? 'true' : undefined}
  data-cinder-variant={resolvedVariant === 'default' ? undefined : resolvedVariant}
  data-cinder-tone={hero ? resolvedTone : undefined}
  data-theme={darkBand ? 'dark' : undefined}
  {...rest}
>
  {#if hero}
    <div class="cinder-page-header__decor" aria-hidden="true">
      <div class="cinder-page-header__pattern"></div>
      {#if art && !focal}
        <div class="cinder-page-header__art">{@render art()}</div>
      {/if}
    </div>
    <div class="cinder-page-header__hero">
      <div class="cinder-page-header__hero-copy">
        {#if breadcrumbs}
          <div class="cinder-page-header__breadcrumbs">
            {@render breadcrumbs()}
          </div>
        {/if}
        {#if eyebrow}
          <p class="cinder-page-header__eyebrow">{eyebrow}</p>
        {/if}
        {@render headingBody()}
        {#if facts}
          <div class="cinder-page-header__facts">{@render facts()}</div>
        {/if}
        {#if hasActions}
          <div class="cinder-page-header__hero-actions">{@render actionGroups()}</div>
        {/if}
      </div>
      {#if focal}
        <div class="cinder-page-header__focal">{@render focal()}</div>
      {:else if media}
        <div class="cinder-page-header__media">{@render media()}</div>
      {/if}
    </div>
  {:else}
    {#if breadcrumbs}
      <div class="cinder-page-header__breadcrumbs">
        {@render breadcrumbs()}
      </div>
    {/if}

    <div class="cinder-page-header__row">
      <div class="cinder-page-header__heading-group">
        {@render headingBody()}
      </div>

      {#if hasActions}
        <div class="cinder-page-header__actions">
          <CompactActions>
            {@render actionGroups()}
          </CompactActions>
        </div>
      {/if}
    </div>
  {/if}
</div>
