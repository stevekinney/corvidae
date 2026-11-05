<script lang="ts" module>
  /**
   * @cinder
   * @category form
   * @status beta
   * @purpose Single-row filtering toolbar for list views: status segments, select and chip facets, a search field, and a collapse to a select and a Filter menu on narrow screens.
   * @tag form
   * @tag filter
   * @useWhen Filtering a list or table by several dimensions at once, such as status, who started it, and which agent ran it.
   * @useWhen Showing applied filters as tinted chips that read "Agent: Tool runner" and can be removed in place.
   * @avoidWhen A single search field or one select is sufficient — compose SearchField or Select directly.
   * @avoidWhen Filtering navigates to a new page — the bar owns no routing or persistence.
   * @related search-field, segmented-control, select, popover
   */
  export type {
    AppliedFilter,
    ChoiceFacet,
    CustomFacet,
    FacetDefinition,
    FacetOption,
    FilterBarLayout,
    FilterBarProps,
    FilterSegment,
    SelectFacet,
    ToggleFacet,
    ToggleFacetTone,
  } from './filter-bar.types.ts';
</script>

<script lang="ts">
  import { tick } from 'svelte';
  import type { Attachment } from 'svelte/attachments';
  import Funnel from '@lucide/svelte/icons/funnel';
  import Search from '@lucide/svelte/icons/search';
  import X from '@lucide/svelte/icons/x';

  import { useViewportBelow } from '../../_internal/viewport-below.svelte.ts';
  import VisuallyHiddenLiveRegion from '../_visually-hidden-live-region.svelte';
  import { default as Button } from '../button/index.ts';
  import { default as Checkbox } from '../checkbox/index.ts';
  import { default as Chip } from '../chip/index.ts';
  import { default as Popover } from '../popover/index.ts';
  import { default as Segment } from '../segment/index.ts';
  import { default as SegmentedControl } from '../segmented-control/index.ts';
  import { default as SearchField } from '../search-field/index.ts';
  import { default as Select } from '../select/index.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import FilterBarFacetChip from './filter-bar-facet-chip.svelte';
  import FilterBarOptions from './filter-bar-options.svelte';
  import {
    FILTER_BAR_PHONE_BREAKPOINT,
    FILTER_BAR_TABLET_BREAKPOINT,
    appliedSummary,
    appliedValues,
    fromControlValue,
    isCollapsible,
    optionLabel,
    resolveFilterBarLayout,
    segmentSelectLabel,
    toControlValue,
  } from './filter-bar.utilities.ts';

  import type {
    AppliedFilter,
    ChoiceFacet,
    FacetDefinition,
    FilterBarProps,
    SelectFacet,
    ToggleFacet,
  } from './filter-bar.types.ts';

  const generatedId = $props.id();

  let {
    'aria-label': ariaLabel = 'Filters',
    segments = [],
    segmentValue,
    segmentsLabel = 'Status',
    searchQuery,
    searchVisible = true,
    searchPlaceholder = 'Search…',
    searchAriaLabel = 'Search',
    searchPosition,
    facets = [],
    appliedFilters = [],
    layout: forcedLayout = 'auto',
    disabled = false,
    class: className,
    onSegmentChange,
    onSearchChange,
    onFacetChange,
    onFacetValuesChange,
    onFilterRemove,
    ...rest
  }: FilterBarProps = $props();

  const searchId = $derived(`${generatedId}-search`);
  let containerWidth: number | undefined = $state();

  // Internal uncontrolled search value when searchQuery is not provided.
  let internalSearchQuery = $state('');
  const isSearchControlled = $derived(searchQuery !== undefined);
  const currentSearchQuery = $derived(
    isSearchControlled ? (searchQuery ?? '') : internalSearchQuery,
  );

  // The chosen segment, uncontrolled until the consumer passes `segmentValue`.
  let internalSegment: string | undefined = $state();
  const currentSegment = $derived(segmentValue ?? internalSegment ?? segments[0]?.value ?? '');

  const phone = useViewportBelow(() => FILTER_BAR_PHONE_BREAKPOINT);
  const tablet = useViewportBelow(() => FILTER_BAR_TABLET_BREAKPOINT);

  const contents = $derived({
    segments,
    facets,
    appliedFilters,
    segmentsLabel,
    searchVisible,
  });
  const collapsible = $derived(isCollapsible(contents));
  const layout = $derived(
    resolveFilterBarLayout({
      contents,
      forced: forcedLayout,
      phone: phone.current,
      tablet: tablet.current,
      containerWidth,
    }),
  );

  // A bar with segments or chips puts its search at the end of the row; a bar of selects alone
  // starts with it, as a list pane's filters do.
  const searchAtStart = $derived((searchPosition ?? (collapsible ? 'end' : 'start')) === 'start');

  // The bar's own width, so a wide form beside a wide sidebar steps down instead of overflowing.
  const measureWidth: Attachment<HTMLDivElement> = (node) => {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number' && width > 0) containerWidth = width;
    });
    observer.observe(node);
    return () => observer.disconnect();
  };

  function appliedFilterFor(key: string): AppliedFilter | undefined {
    return appliedFilters.find((filter) => filter.key === key);
  }

  // Facet controls are fully controlled by `appliedFilters`: the value a facet shows is whatever
  // applied filter owns its key, or empty. There is no separate internal source of truth, which
  // would let a select keep showing a value the parent has cleared (URL-state reset, saved filters).
  function resolveFacetValue(key: string): string {
    return appliedFilterFor(key)?.value ?? '';
  }

  /** A select facet as a list of options that begins with the row that clears it. */
  function selectOptions(
    facet: SelectFacet,
  ): { value: string; label: string; disabled?: boolean }[] {
    return [{ value: toControlValue(''), label: facet.placeholder ?? 'All' }, ...facet.options];
  }

  /** A select facet seen as a single choice, so the Filter menu can draw it like one. */
  function asSingleChoice(facet: SelectFacet): ChoiceFacet {
    return {
      type: 'choice',
      key: facet.key,
      label: facet.label,
      multiple: false,
      options: selectOptions(facet),
      ...(facet.disabled === undefined ? {} : { disabled: facet.disabled }),
    };
  }

  /** What a facet currently reads, in words, for the Filter menu's row and the live region. */
  function facetSummary(facet: FacetDefinition): string {
    const applied = appliedFilterFor(facet.key);
    if (applied === undefined) return '';
    if (facet.type === 'choice') return appliedSummary(facet, applied);
    if (facet.type === 'select') return optionLabel(facet.options, applied.value);
    if (facet.type === 'toggle') return 'On';
    return applied.value;
  }

  // An applied filter no facet draws, such as a window a link put in the address, still gets a chip
  // so the person can see it and remove it.
  const orphanFilters = $derived(
    appliedFilters.filter((filter) => !facets.some((facet) => facet.key === filter.key)),
  );

  const activeSummaries = $derived([
    ...facets.flatMap((facet) => {
      const summary = facetSummary(facet);
      return summary === '' ? [] : [`${facet.label}: ${summary}`];
    }),
    ...orphanFilters.map((filter) => `${filter.label}: ${appliedValues(filter).join(', ')}`),
  ]);
  // Live region summary message — always in DOM, content changes when filters change.
  const summaryMessage = $derived(
    activeSummaries.length === 0
      ? ''
      : `${activeSummaries.length} active filter${activeSummaries.length === 1 ? '' : 's'}: ${activeSummaries.join(', ')}`,
  );

  // An applied choice chip is drawn after the chips still waiting for a value, so a facet's place
  // does not depend on the order the consumer listed them in. The facets are one keyed list, so a
  // chip that gains a value moves instead of remounting, and its open popover stays with it.
  const orderedFacets = $derived([
    ...facets.filter((facet) => !(facet.type === 'choice' && appliedFilterFor(facet.key))),
    ...facets.filter((facet) => facet.type === 'choice' && appliedFilterFor(facet.key)),
  ]);

  function handleSegmentChange(next: string): void {
    if (segmentValue === undefined) internalSegment = next;
    onSegmentChange?.(next);
  }

  function handleSearchInput(value: string): void {
    if (!isSearchControlled) {
      internalSearchQuery = value;
    }
    onSearchChange?.(value);
  }

  // The bar's root and the narrow form's Filter menu are looked up when focus needs a new home, since
  // the control that held it has just unmounted.
  let barElement: HTMLDivElement | undefined = $state();

  function menuElement(): HTMLElement | null {
    return document.getElementById(`${generatedId}-menu`);
  }

  function removeButtons(): HTMLElement[] {
    return [menuElement(), barElement ?? null].flatMap((scope) =>
      scope === null || scope === undefined
        ? []
        : [...scope.querySelectorAll<HTMLElement>('.cinder-filter-bar__chip-remove')],
    );
  }

  /** The first enabled match of a selector inside the Filter menu, then inside the bar. */
  function firstFocusable(selector: string): HTMLElement | null {
    for (const scope of [menuElement(), barElement ?? null]) {
      const found = scope?.querySelector<HTMLElement>(selector);
      if (found !== null && found !== undefined && !found.hasAttribute('disabled')) return found;
    }
    return null;
  }

  /** Where focus goes when the control that held it was removed and its facet has no add chip. */
  function fallbackFocusTarget(removedIndex: number): HTMLElement | null {
    const remaining = removeButtons();
    return (
      remaining[Math.min(removedIndex, remaining.length - 1)] ??
      firstFocusable(`[id^="${generatedId}-facet-"]`) ??
      firstFocusable('.cinder-filter-bar__menu-row:not([data-cinder-static])') ??
      firstFocusable('.cinder-filter-bar__menu-button') ??
      firstFocusable('input.cinder-search-field__input') ??
      firstFocusable('.cinder-filter-bar__search-button') ??
      barElement ??
      null
    );
  }

  async function handleFilterRemove(key: string, origin?: HTMLElement | null): Promise<void> {
    const removedIndex =
      origin === undefined || origin === null ? 0 : removeButtons().indexOf(origin);
    onFilterRemove?.(key);
    await tick();
    // A choice facet's chip has become its add chip in the same place, so focus lands on that. A
    // filter no facet draws has nothing left to land on, so focus moves to the nearest control
    // instead of falling to the page.
    const addChip = document.getElementById(triggerId(key));
    if (addChip !== null) addChip.focus();
    else fallbackFocusTarget(Math.max(removedIndex, 0))?.focus();
  }

  function triggerId(key: string): string {
    return `${generatedId}-facet-${key}`;
  }

  function changeFacetValues(facet: ChoiceFacet, values: readonly string[]): void {
    onFacetValuesChange?.(facet.key, values);
  }

  // The Filter menu (narrow form) and the search popover (medium form).
  let menuOpen = $state(false);
  let menuSection: string | undefined = $state();
  let searchOpen = $state(false);

  const appliedCount = $derived(activeSummaries.length);

  function toggleSection(key: string): void {
    menuSection = menuSection === key ? undefined : key;
  }
</script>

{#snippet searchField(id: string)}
  <SearchField
    {id}
    class="cinder-filter-bar__search"
    value={currentSearchQuery}
    placeholder={searchPlaceholder}
    aria-label={searchAriaLabel}
    {disabled}
    onValueChange={handleSearchInput}
  />
{/snippet}

{#snippet segmentsControl()}
  {#if layout === 'wide'}
    <SegmentedControl
      id={`${generatedId}-segments`}
      class="cinder-filter-bar__segments"
      label={segmentsLabel}
      labelVisible={false}
      value={currentSegment}
      {disabled}
      onValueChange={handleSegmentChange}
    >
      {#each segments as segment (segment.value)}
        <Segment value={segment.value} count={segment.count} disabled={segment.disabled}>
          {segment.label}
        </Segment>
      {/each}
    </SegmentedControl>
  {:else}
    <Select
      id={`${generatedId}-segments`}
      class="cinder-filter-bar__segments-select"
      presentation="listbox"
      label={segmentsLabel}
      labelVisible={false}
      valuePrefix={`${segmentsLabel}:`}
      value={currentSegment}
      {disabled}
      options={segments.map((segment) => ({
        value: segment.value,
        label: segmentSelectLabel(segment),
        ...(segment.disabled === undefined ? {} : { disabled: segment.disabled }),
      }))}
      onValueChange={handleSegmentChange}
    />
  {/if}
{/snippet}

{#snippet selectControl(facet: SelectFacet)}
  <Select
    id={triggerId(facet.key)}
    class="cinder-filter-bar__select"
    presentation="listbox"
    label={facet.label}
    labelVisible={false}
    valuePrefix={`${facet.label}:`}
    value={toControlValue(resolveFacetValue(facet.key))}
    disabled={disabled || facet.disabled === true}
    options={selectOptions(facet)}
    onValueChange={(next) => onFacetChange?.(facet.key, fromControlValue(next))}
  />
{/snippet}

{#snippet toggleControl(facet: ToggleFacet)}
  {@const pressed = appliedFilterFor(facet.key) !== undefined}
  <Chip
    mode="toggle"
    density="toolbar"
    class="cinder-filter-bar__toggle"
    variant={pressed ? 'warning' : 'neutral'}
    label={facet.count === undefined ? facet.label : `${facet.label} ${facet.count}`}
    {pressed}
    disabled={disabled || facet.disabled === true}
    onPressedChange={(next) => onFacetChange?.(facet.key, next ? 'true' : '')}
  >
    {#snippet leadingIcon()}
      <span class="cinder-filter-bar__dot" data-cinder-tone={facet.tone ?? 'warning'}></span>
    {/snippet}
  </Chip>
{/snippet}

{#snippet customControl(facet: Extract<FacetDefinition, { type: 'custom' }>)}
  {@render facet.control({
    value: resolveFacetValue(facet.key),
    onValueChange: (value: string) => {
      onFacetChange?.(facet.key, value);
    },
    disabled,
  })}
{/snippet}

{#snippet filterMenu()}
  <Popover bind:open={menuOpen} label="Filter" placement="bottom-start">
    {#snippet trigger()}
      <Button
        type="button"
        variant="secondary"
        class="cinder-filter-bar__menu-button"
        {disabled}
        aria-label={appliedCount === 0 ? 'Filter' : `Filter, ${appliedCount} applied`}
        aria-haspopup="dialog"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        {#snippet leadingIcon()}<Funnel class="cinder-icon-xs" />{/snippet}
        Filter
        {#if appliedCount > 0}
          <span class="cinder-filter-bar__menu-count" aria-hidden="true">{appliedCount}</span>
        {/if}
      </Button>
    {/snippet}

    <div id={`${generatedId}-menu`} class="cinder-filter-bar__menu">
      {#each facets as facet (facet.key)}
        {@const summary = facetSummary(facet)}
        {@const open = menuSection === facet.key}
        {@const applied = appliedFilterFor(facet.key)}
        <div class="cinder-filter-bar__menu-section">
          <button
            type="button"
            class="cinder-filter-bar__menu-row"
            aria-expanded={open}
            aria-controls={`${generatedId}-menu-${facet.key}`}
            {disabled}
            onclick={() => toggleSection(facet.key)}
          >
            <span class="cinder-filter-bar__menu-label">{facet.label}</span>
            {#if summary !== ''}
              <span class="cinder-filter-bar__menu-value">{summary}</span>
            {/if}
          </button>
          {#if open}
            <div id={`${generatedId}-menu-${facet.key}`} class="cinder-filter-bar__menu-body">
              {#if facet.type === 'choice'}
                <FilterBarOptions
                  {facet}
                  values={applied === undefined ? [] : appliedValues(applied)}
                  titleId={`${generatedId}-menu-${facet.key}-title`}
                  titleVisible={false}
                  {disabled}
                  onValuesChange={(values) => changeFacetValues(facet, values)}
                  onValueChange={(value) => onFacetChange?.(facet.key, value)}
                />
              {:else if facet.type === 'select'}
                <FilterBarOptions
                  facet={asSingleChoice(facet)}
                  values={[toControlValue(resolveFacetValue(facet.key))]}
                  titleId={`${generatedId}-menu-${facet.key}-title`}
                  titleVisible={false}
                  {disabled}
                  onValuesChange={() => {}}
                  onValueChange={(value) => onFacetChange?.(facet.key, fromControlValue(value))}
                />
              {:else if facet.type === 'toggle'}
                <Checkbox
                  label={facet.count === undefined ? facet.label : `${facet.label} ${facet.count}`}
                  checked={applied !== undefined}
                  disabled={disabled || facet.disabled === true}
                  onValueChange={(next) => onFacetChange?.(facet.key, next ? 'true' : '')}
                />
              {:else}
                {@render customControl(facet)}
              {/if}
            </div>
          {/if}
        </div>
      {/each}
      {#each orphanFilters as filter (filter.key)}
        {@const summary = appliedValues(filter).join(', ')}
        <div class="cinder-filter-bar__menu-section">
          <div class="cinder-filter-bar__menu-row" data-cinder-static="">
            <span class="cinder-filter-bar__menu-label">{filter.label}</span>
            <span class="cinder-filter-bar__menu-value">{summary}</span>
            <button
              type="button"
              class="cinder-filter-bar__chip-remove"
              {disabled}
              aria-label={`Remove filter: ${filter.label}: ${summary}`}
              onclick={(event) => handleFilterRemove(filter.key, event.currentTarget)}
            >
              <X class="cinder-icon-xs" aria-hidden="true" />
            </button>
          </div>
        </div>
      {/each}
      {#if searchVisible}
        <div class="cinder-filter-bar__menu-section">
          <button
            type="button"
            class="cinder-filter-bar__menu-row"
            aria-expanded={menuSection === '__search'}
            aria-controls={`${generatedId}-menu-search`}
            {disabled}
            onclick={() => toggleSection('__search')}
          >
            <span class="cinder-filter-bar__menu-label">Search</span>
            {#if currentSearchQuery !== ''}
              <span class="cinder-filter-bar__menu-value">{currentSearchQuery}</span>
            {/if}
          </button>
          {#if menuSection === '__search'}
            <div id={`${generatedId}-menu-search`} class="cinder-filter-bar__menu-body">
              {@render searchField(`${searchId}-menu`)}
            </div>
          {/if}
        </div>
      {/if}
    </div>
  </Popover>
{/snippet}

{#snippet searchButton()}
  <Popover bind:open={searchOpen} label={searchAriaLabel} placement="bottom-end">
    {#snippet trigger()}
      <Button
        type="button"
        variant="secondary"
        iconOnly
        class="cinder-filter-bar__search-button"
        {disabled}
        aria-label={searchAriaLabel}
        aria-haspopup="dialog"
        aria-expanded={searchOpen}
        data-cinder-active={currentSearchQuery === '' ? undefined : ''}
        onclick={() => (searchOpen = !searchOpen)}
      >
        <Search class="cinder-icon-xs" />
      </Button>
    {/snippet}
    <div class="cinder-filter-bar__search-popover">
      {@render searchField(`${searchId}-popover`)}
    </div>
  </Popover>
{/snippet}

{#snippet facetControls()}
  {#each orderedFacets as facet (facet.key)}
    {#if facet.type === 'select'}
      <div class="cinder-filter-bar__facet">{@render selectControl(facet)}</div>
    {:else if facet.type === 'choice'}
      <FilterBarFacetChip
        {facet}
        applied={appliedFilterFor(facet.key)}
        triggerId={triggerId(facet.key)}
        {disabled}
        onValuesChange={(values) => changeFacetValues(facet, values)}
        onValueChange={(value) => onFacetChange?.(facet.key, value)}
        onRemove={() => handleFilterRemove(facet.key)}
      />
    {:else if facet.type === 'toggle'}
      {@render toggleControl(facet)}
    {:else}
      <div class="cinder-filter-bar__facet">{@render customControl(facet)}</div>
    {/if}
  {/each}
  {#each orphanFilters as filter (filter.key)}
    {@const summary = appliedValues(filter).join(', ')}
    <span
      class="cinder-filter-bar__chip"
      data-cinder-applied=""
      data-cinder-static=""
      data-cinder-disabled={disabled ? '' : undefined}
    >
      <span class="cinder-filter-bar__chip-trigger">
        <span class="cinder-filter-bar__chip-label">{filter.label}:</span>
        <span class="cinder-filter-bar__chip-value">{summary}</span>
      </span>
      <button
        type="button"
        class="cinder-filter-bar__chip-remove"
        {disabled}
        aria-label={`Remove filter: ${filter.label}: ${summary}`}
        onclick={(event) => handleFilterRemove(filter.key, event.currentTarget)}
      >
        <X class="cinder-icon-xs" aria-hidden="true" />
      </button>
    </span>
  {/each}
{/snippet}

<div
  {...rest}
  class={classNames('cinder-filter-bar', className)}
  role="search"
  aria-label={ariaLabel}
  data-cinder-layout={layout}
  data-cinder-collapsible={collapsible ? '' : undefined}
  data-cinder-search-position={searchAtStart ? 'start' : 'end'}
  data-disabled={disabled ? '' : undefined}
  {@attach measureWidth}
  bind:this={barElement}
  tabindex="-1"
>
  <div class="cinder-filter-bar__row">
    {#if searchVisible && searchAtStart && layout === 'wide'}
      {@render searchField(searchId)}
    {/if}

    {#if segments.length > 0}
      {@render segmentsControl()}
    {/if}

    {#if layout === 'narrow'}
      {@render filterMenu()}
    {:else}
      {@render facetControls()}
      {#if searchVisible && !searchAtStart}
        {#if layout === 'wide'}
          {@render searchField(searchId)}
        {:else}
          {@render searchButton()}
        {/if}
      {:else if searchVisible && searchAtStart && layout === 'medium'}
        {@render searchButton()}
      {/if}
    {/if}
  </div>

  <!-- Always-in-DOM live region for accessible filter count summary.
       Visibility toggled by content, never by {#if}, so the region is
       registered with ATs before text is injected. -->
  <VisuallyHiddenLiveRegion message={summaryMessage} priority="polite" />
</div>
