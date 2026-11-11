<script lang="ts" module>
  /**
   * @cinder
   * @category navigation
   * @status beta
   * @purpose Sticky translucent top bar for a page: Back and leading content, the page's title, and trailing icon actions that each carry a name and a tooltip.
   * @tag app-bar
   * @tag header
   * @tag chrome
   * @useWhen Pinning a page's identity while it scrolls: Back, the title, then icon actions, as a phone detail page does.
   * @useWhen Showing a large page title in the bar once it scrolls away, paired with the large variant of page-header.
   * @avoidWhen Grouping controls with arrow-key navigation between them — use toolbar.
   * @avoidWhen Switching between an app's top-level sections — use navigation-bar.
   * @related page-header, toolbar, navigation-bar
   * @rationale Nearest alternatives: Toolbar is the WAI-ARIA roving-tabindex control group and NavigationBar is a bar of navigation items; neither is a material bar that carries the page's title.
   */
  import type { Snippet } from 'svelte';

  export type {
    AppBarAction,
    AppBarBackAction,
    AppBarHeadingLevel,
    AppBarProps,
  } from './app-bar.types.ts';

  /**
   * One icon-only control in the bar: Back, or one of the actions. Declared in the module script
   * because the snippet that draws it is hoisted there.
   */
  type IconControl = {
    label: string;
    href?: string | undefined;
    onclick?: ((event: MouseEvent) => void) | undefined;
    disabled?: boolean | undefined;
    icon?: Snippet | undefined;
  };
</script>

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';

  import { classNames } from '../../utilities/class-names.ts';
  import Button from '../button/button.svelte';
  import Tooltip from '../tooltip/tooltip.svelte';
  import type { AppBarProps } from './app-bar.types.ts';

  let {
    title,
    titleVisible = true,
    headingLevel,
    back,
    leading,
    trailing,
    actions,
    class: className,
    ...rest
  }: AppBarProps = $props();

  // Clamp to 1–6 so an out-of-range value from an untyped caller never builds <h0>/<hNaN>; with no
  // level the title is plain text, because a PageHeader below carries the page's heading.
  const resolvedHeadingLevel = $derived(
    headingLevel === undefined || !Number.isFinite(Math.trunc(Number(headingLevel)))
      ? undefined
      : Math.min(6, Math.max(1, Math.trunc(Number(headingLevel)))),
  );
  const titleTag = $derived(
    resolvedHeadingLevel === undefined ? 'span' : `h${resolvedHeadingLevel}`,
  );
  const hasLeading = $derived(back !== undefined || leading !== undefined);
  const hasTrailing = $derived(trailing !== undefined || (actions?.length ?? 0) > 0);
</script>

{#snippet iconControl(control: IconControl)}
  <Tooltip text={control.label} describe={false}>
    {#if control.href !== undefined}
      <Button
        variant="ghost"
        iconOnly
        href={control.href}
        aria-label={control.label}
        aria-disabled={control.disabled ? 'true' : undefined}
        onclick={control.onclick}
        class="cinder-app-bar__action"
      >
        {#if control.icon}
          {@render control.icon()}
        {:else}
          <ChevronLeft class="cinder-icon-md" aria-hidden="true" />
        {/if}
      </Button>
    {:else}
      <Button
        variant="ghost"
        iconOnly
        aria-label={control.label}
        aria-disabled={control.disabled ? 'true' : undefined}
        onclick={control.onclick}
        class="cinder-app-bar__action"
      >
        {#if control.icon}
          {@render control.icon()}
        {:else}
          <ChevronLeft class="cinder-icon-md" aria-hidden="true" />
        {/if}
      </Button>
    {/if}
  </Tooltip>
{/snippet}

<div
  class={classNames('cinder-app-bar', className)}
  data-cinder-title-visible={titleVisible ? '' : undefined}
  {...rest}
>
  {#if hasLeading}
    <div class="cinder-app-bar__leading">
      {#if back}
        {@render iconControl({
          label: back.label ?? 'Back',
          href: back.href,
          onclick: back.onclick,
        })}
      {/if}
      {#if leading}{@render leading()}{/if}
    </div>
  {/if}

  <div class="cinder-app-bar__title" aria-hidden={titleVisible ? undefined : 'true'}>
    {#if title}
      <svelte:element this={titleTag} class="cinder-app-bar__title-text">
        {#if typeof title === 'string'}
          {title}
        {:else}
          {@render title()}
        {/if}
      </svelte:element>
    {/if}
  </div>

  {#if hasTrailing}
    <div class="cinder-app-bar__trailing">
      {#if trailing}{@render trailing()}{/if}
      {#each actions ?? [] as action, index (index)}
        {@render iconControl(action)}
      {/each}
    </div>
  {/if}
</div>
