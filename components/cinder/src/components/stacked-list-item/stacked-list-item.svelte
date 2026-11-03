<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Dense list row with leading, status, title, time, description, meta, and trailing slots; the status-first two-line row has a fixed 128px status column, a two-line title clamp and a whole-row link.
   * @tag list
   * @tag row
   * @tag status
   * @useWhen Listing entities vertically with consistent leading icons or avatars and trailing actions.
   * @useWhen Linking each row to a detail view by passing href, which makes the whole row one link.
   * @useWhen Listing runs, goals, schedules or agents with a status word, bold title and time on line one and muted meta on line two.
   * @avoidWhen Comparing tabular data across columns — use table instead.
   * @avoidWhen Rendering cards in a responsive grid — use grid-list instead.
   * @related grid-list-item, table-row, avatar
   */
  export type {
    StackedListItemAction,
    StackedListItemDensity,
    StackedListItemProps,
    StackedListItemStatusPlacement,
    StackedListItemTitleLines,
  } from './stacked-list-item.types.ts';

  // Attributes stripped from forwarded `rest` to keep the <li> non-interactive.
  // Module-scoped so the Set is allocated once, not per component instance.
  const BLOCKED_ATTRS = new Set(['role', 'tabindex']);
</script>

<script lang="ts">
  import { ChevronDown, ChevronUp, Ellipsis } from '@lucide/svelte';
  import { getDataListContext } from '../../_internal/data-list-context.ts';
  import { phoneViewport } from '../../_internal/phone-viewport.svelte.ts';
  import type { StackedListItemProps } from './stacked-list-item.types.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import Button from '../button/button.svelte';
  import { Dropdown } from '../dropdown/index.ts';

  let {
    density,
    class: className,
    leading,
    status,
    statusColumn,
    statusPlacement = 'leading',
    title,
    titleLines = 2,
    tooltip,
    time,
    description,
    meta,
    trailing,
    actions,
    actionsLabel = 'More actions',
    details,
    expanded = $bindable(false),
    expandLabel = 'Show',
    collapseLabel = 'Hide',
    href,
    target,
    rel,
    hreflang,
    ...rest
  }: StackedListItemProps = $props();

  // Density resolution: an explicit per-row `density` prop wins; otherwise the
  // enclosing DataList's list-level density (if any) applies; otherwise the
  // row's own default of `comfortable`. A standalone StackedListItem (no
  // DataList ancestor) reads `undefined` from the context and uses the default.
  // Context identity is stable: `getDataListContext()` reads the Svelte context
  // once at component instantiation. Reactivity is preserved because the
  // returned object uses a getter (`get density() { return density }`) rather
  // than a snapshot value — reading `dataListContext?.density` inside `$derived`
  // re-subscribes to that getter every time DataList's `density` prop changes.
  // Avoid destructuring the context object; doing so captures the value at
  // read time and breaks reactivity.
  //
  // Limitation: if a StackedListItem row is dynamically moved between DataList
  // instances after mount, the context read is not retried and the new parent's
  // density is not inherited. Mount rows inside the intended DataList only.
  const dataListContext = getDataListContext();
  const resolvedDensity = $derived(density ?? dataListContext?.density ?? 'comfortable');

  const generatedId = $props.id();

  // A row is in the status-first "lines" layout when it has a status (or keeps the column for one),
  // a time, or details; otherwise it keeps the original body stack.
  const reservesStatusColumn = $derived(
    status !== undefined || (statusColumn ?? dataListContext?.statusColumn ?? false),
  );
  const isLines = $derived(reservesStatusColumn || time !== undefined || details !== undefined);
  // A group row is not a link: its only control is the disclosure button.
  const linkHref = $derived(details === undefined ? href : undefined);
  const phone = $derived(phoneViewport.current);
  const hasActions = $derived(actions !== undefined && actions.length > 0);
  const detailsId = $derived(`${generatedId}-details`);

  /** Blocks a disabled action's click, as `aria-disabled` alone does not. */
  function guardDisabled(action: NonNullable<StackedListItemProps['actions']>[number]) {
    return (event: MouseEvent) => {
      if (action.disabled) {
        event.preventDefault();
        return;
      }
      action.onclick?.(event);
    };
  }

  // Filter out any attributes that TypeScript already blocks but which could
  // leak through at runtime (e.g. from dynamic spreads or JS consumers).
  // Strips on* event handlers plus role and tabindex to prevent the <li> from
  // becoming interactive — matching the accessibility contract in the a11y docs.
  // `rest` is already typed as `ForwardedLiAttributes` (no on* keys), so the
  // inferred record from `Object.fromEntries` needs no assertion to spread.
  // $derived so the filtered set re-evaluates when rest changes.
  const safeRest = $derived(
    Object.fromEntries(
      Object.entries(rest).filter(([key]) => !key.startsWith('on') && !BLOCKED_ATTRS.has(key)),
    ),
  );

  // Compose `rel` for the title anchor. When target matches "_blank"
  // (case-insensitive), merge "noopener" and "noreferrer" into whatever the
  // consumer supplied, deduplicating tokens so reverse-tabnapping protection is
  // never silently dropped. Mirrors the sibling grid-list-item. $derived so it
  // re-evaluates when target or rel changes.
  const resolvedRel = $derived.by(() => {
    if (target?.toLowerCase() !== '_blank') return rel;
    const tokens = new Set((rel ?? '').split(/\s+/).filter(Boolean));
    tokens.add('noopener');
    tokens.add('noreferrer');
    return [...tokens].join(' ');
  });
</script>

{#snippet titleRegion()}
  <div class="cinder-stacked-list-item__title" data-cinder-title-lines={titleLines} title={tooltip}>
    {#if linkHref !== undefined}
      <a
        class="cinder-stacked-list-item__title-link"
        href={linkHref}
        {target}
        rel={resolvedRel}
        {hreflang}
      >
        {@render title()}
      </a>
    {:else}
      {@render title()}
    {/if}
  </div>
{/snippet}

<li
  class={classNames(
    'cinder-stacked-list-item',
    leading && 'cinder-stacked-list-item--has-leading',
    (trailing || hasActions) && 'cinder-stacked-list-item--has-trailing',
    isLines && 'cinder-stacked-list-item--lines',
    isLines && reservesStatusColumn && 'cinder-stacked-list-item--status-column',
    isLines && status && 'cinder-stacked-list-item--has-status',
    isLines && `cinder-stacked-list-item--status-${statusPlacement}`,
    linkHref !== undefined && 'cinder-stacked-list-item--linked',
    hasActions && phone && 'cinder-stacked-list-item--collapsed-actions',
    className,
  )}
  data-cinder-density={resolvedDensity}
  data-cinder-phone={phone ? '' : undefined}
  data-cinder-expanded={details !== undefined && expanded ? '' : undefined}
  {...safeRest}
>
  <div class="cinder-stacked-list-item__layout">
    {#if isLines && status}
      <div class="cinder-stacked-list-item__status">
        {@render status()}
      </div>
    {/if}
    {#if leading}
      <div class="cinder-stacked-list-item__leading">
        {@render leading()}
      </div>
    {/if}
    <div class="cinder-stacked-list-item__body">
      {@render titleRegion()}
      {#if isLines}
        {#if time || details}
          <div class="cinder-stacked-list-item__time">
            {#if time}{@render time()}{/if}
            {#if details}
              <button
                type="button"
                class="cinder-stacked-list-item__disclosure"
                aria-expanded={expanded}
                aria-controls={detailsId}
                onclick={() => (expanded = !expanded)}
              >
                {expanded ? collapseLabel : expandLabel}
                {#if expanded}
                  <ChevronUp size={14} aria-hidden="true" />
                {:else}
                  <ChevronDown size={14} aria-hidden="true" />
                {/if}
              </button>
            {/if}
          </div>
        {/if}
        {#if description || meta}
          <div class="cinder-stacked-list-item__line-two">
            {#if description}
              <div class="cinder-stacked-list-item__description">{@render description()}</div>
            {/if}
            {#if meta}
              <div class="cinder-stacked-list-item__meta">{@render meta()}</div>
            {/if}
          </div>
        {/if}
        {#if details}
          <div id={detailsId} class="cinder-stacked-list-item__details" hidden={!expanded}>
            {@render details()}
          </div>
        {/if}
      {:else}
        {#if description}
          <div class="cinder-stacked-list-item__description">{@render description()}</div>
        {/if}
        {#if meta}
          <div class="cinder-stacked-list-item__meta">{@render meta()}</div>
        {/if}
      {/if}
    </div>
    {#if trailing || hasActions}
      <div class="cinder-stacked-list-item__trailing">
        {#if trailing}{@render trailing()}{/if}
        {#if hasActions && actions}
          {#if phone}
            <Dropdown id={`${generatedId}-actions`} placement="bottom-end">
              <Dropdown.Trigger
                class="cinder-stacked-list-item__actions-trigger"
                caretVisible={false}
                aria-label={actionsLabel}
              >
                <Ellipsis size={16} aria-hidden="true" />
              </Dropdown.Trigger>
              <Dropdown.Menu>
                {#each actions as action, index (index)}
                  {@const reasonId = `${generatedId}-action-${index}-reason`}
                  <Dropdown.Item
                    {...action.href !== undefined ? { href: action.href } : {}}
                    disabled={action.disabled}
                    title={action.disabled ? action.disabledReason : undefined}
                    aria-describedby={action.disabled && action.disabledReason
                      ? reasonId
                      : undefined}
                    onclick={action.onclick}
                  >
                    {action.label}
                    {#if action.disabled && action.disabledReason}
                      <span id={reasonId} class="cinder-stacked-list-item__reason"
                        >{action.disabledReason}</span
                      >
                    {/if}
                  </Dropdown.Item>
                {/each}
              </Dropdown.Menu>
            </Dropdown>
          {:else}
            <span class="cinder-stacked-list-item__actions">
              {#each actions as action, index (index)}
                {@const reasonId = `${generatedId}-action-${index}-reason`}
                {#if action.href !== undefined}
                  <Button
                    variant="secondary"
                    size="sm"
                    href={action.href}
                    aria-disabled={action.disabled ? 'true' : undefined}
                    aria-describedby={action.disabled && action.disabledReason
                      ? reasonId
                      : undefined}
                    title={action.disabled ? action.disabledReason : undefined}
                    onclick={guardDisabled(action)}
                  >
                    {action.label}
                  </Button>
                {:else}
                  <Button
                    variant="secondary"
                    size="sm"
                    aria-disabled={action.disabled ? 'true' : undefined}
                    aria-describedby={action.disabled && action.disabledReason
                      ? reasonId
                      : undefined}
                    title={action.disabled ? action.disabledReason : undefined}
                    onclick={guardDisabled(action)}
                  >
                    {action.label}
                  </Button>
                {/if}
                {#if action.disabled && action.disabledReason}
                  <span id={reasonId} class="cinder-stacked-list-item__reason"
                    >{action.disabledReason}</span
                  >
                {/if}
              {/each}
            </span>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
</li>
