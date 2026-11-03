<script lang="ts" module>
  /**
   * @cinder
   * @category navigation
   * @status stable
   * @purpose Single list-wrapped navigation entry tuned for the vertical layout of side-navigation, delegating rendering to navigation-item.
   * @tag navigation
   * @tag sidebar
   * @useWhen Rendering one entry inside a side-navigation column or side-navigation-group.
   * @useWhen Keeping list semantics correct so screen readers announce sidebar entry counts.
   * @avoidWhen Placing entries in a horizontal navigation-bar — use navigation-item directly.
   * @avoidWhen Rendering outside a side-navigation list — use navigation-item without the list wrapper.
   * @related side-navigation, side-navigation-group, navigation-item
   */
  export type { SideNavigationItemProps } from './side-navigation-item.types.ts';
</script>

<script lang="ts">
  import type { SideNavigationItemProps } from './side-navigation-item.types.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import { getSidebarContext } from '../../_internal/sidebar-context.ts';
  import Badge from '../badge/badge.svelte';
  import NavigationItem from '../navigation-item/navigation-item.svelte';
  import StatusDot from '../status-dot/status-dot.svelte';
  import Tooltip from '../tooltip/tooltip.svelte';
  import {
    tryGetSideNavigationGroupContext,
    type SideNavigationGroupRegistration,
  } from '../_internal/side-navigation-group-context.ts';

  const props: SideNavigationItemProps = $props();
  const active = $derived(props.active ?? false);
  // Forward everything except the props this component owns to NavigationItem.
  const navigationItemProps = $derived.by(() => {
    const {
      listItemClass: _listItemClass,
      icon: _icon,
      label: _label,
      count: _count,
      countLabel: _countLabel,
      countTone: _countTone,
      dot: _dot,
      collapsed: _collapsed,
      children: _children,
      class: _class,
      ...rest
    } = props;
    return rest;
  });

  // A row follows its enclosing Sidebar unless told otherwise. Outside a Sidebar there is no
  // context and the row is expanded.
  const sidebar = getSidebarContext();
  const collapsed = $derived(props.collapsed ?? sidebar?.collapsed ?? false);

  // Zero, a negative number and NaN all mean "nothing to report", so the pill never reads "0".
  const countValue = $derived(
    props.count !== undefined && Number.isFinite(props.count) && props.count > 0
      ? props.count
      : undefined,
  );
  const countWords = $derived(props.countLabel?.trim() ? props.countLabel.trim() : undefined);
  const countPhrase = $derived(
    countValue === undefined
      ? undefined
      : countWords === undefined
        ? String(countValue)
        : `${countValue} ${countWords}`,
  );
  // The count names the row ("Health, 3 need attention") so colour is never the only signal: the
  // dot and the pill are decoration over this name. A consumer's own aria-label still wins.
  const composedName = $derived(
    props.label !== undefined && countPhrase !== undefined
      ? `${props.label}, ${countPhrase}`
      : undefined,
  );
  const accessibleName = $derived(props['aria-label'] ?? composedName);
  // A collapsed row shows its label (and count) in a tooltip, since the label is not drawn; an
  // expanded row shows the same words as its name only when a count adds something to the label.
  const tooltipText = $derived(
    props.label === undefined
      ? undefined
      : collapsed
        ? countPhrase === undefined
          ? props.label
          : `${props.label} · ${countPhrase}`
        : composedName,
  );
  const hasIcon = $derived(props.icon !== undefined);

  // The tooltip anchors to the rendered link or button by reference, so its panel never sits
  // inside the list item and a count arriving later does not remount the row (which would drop
  // the focus the keyboard user is on).
  let listItem: HTMLLIElement | undefined = $state();
  let anchor: HTMLElement | null = $state(null);
  $effect(() => {
    anchor = listItem?.querySelector<HTMLElement>('[data-cinder-navigation-item]') ?? null;
  });

  // When this item sits inside a SideNavigationGroup, report its active state
  // so the group can light up its trigger. Outside a group the context is
  // undefined and these effects are no-ops.
  const group = tryGetSideNavigationGroupContext();
  let handle: SideNavigationGroupRegistration | undefined;
  // One-time registration: no reactive reads, so it runs exactly once at mount
  // and cleans up once at unmount. Keeping it free of `active` avoids coupling
  // registration to the group's counter writes (which would loop).
  $effect(() => {
    if (!group) return;
    handle = group.register();
    return () => {
      handle?.unregister();
      handle = undefined;
    };
  });
  // Ongoing active reporting. Runs on mount (reporting the initial state) and on
  // every `active` change. `handle` is populated by the registration effect,
  // which Svelte runs first (declaration order) in the same mount flush.
  $effect(() => {
    handle?.setActive(active);
  });
</script>

{#snippet indicator()}
  {#if props.dot !== undefined}
    <!-- Hidden from assistive technology: the row's name carries the meaning. -->
    <span class="cinder-side-navigation-item__dot" aria-hidden="true">
      <StatusDot status={props.dot} size="sm" labelVisible={false} />
    </span>
  {:else if countValue !== undefined}
    <Badge
      variant={props.countTone ?? 'warning'}
      size="sm"
      class="cinder-side-navigation-item__count"
      role={countWords === undefined ? undefined : 'img'}
      aria-label={countWords === undefined ? undefined : countPhrase}
    >
      {countValue}
    </Badge>
  {/if}
{/snippet}

{#snippet row()}
  {#if props.icon}
    <span class="cinder-side-navigation-item__icon" aria-hidden="true">
      {@render props.icon()}
    </span>
    <span class="cinder-side-navigation-item__label">
      {@render props.children()}
    </span>
  {:else}
    <!-- Legacy shape, kept for a row that draws its own icon inside `children`: the consumer's
         nodes stay direct children of the link, so a shell that styles the link's children (the
         Interborough rail hides every direct child except an svg or an aria-hidden node when
         collapsed) keeps finding its icon where it always did. -->
    {@render props.children()}
  {/if}
  {@render indicator()}
{/snippet}

<li bind:this={listItem} class={classNames('cinder-side-navigation__item', props.listItemClass)}>
  <NavigationItem
    {...navigationItemProps}
    aria-label={accessibleName}
    class={classNames('cinder-side-navigation-item', props.class)}
    data-cinder-collapsed={collapsed ? '' : undefined}
    data-cinder-has-icon={hasIcon ? '' : undefined}
    variant="vertical"
  >
    {@render row()}
  </NavigationItem>
  {#if tooltipText !== undefined}
    <Tooltip text={tooltipText} placement="right" describe={false} triggerRef={anchor} />
  {/if}
</li>
