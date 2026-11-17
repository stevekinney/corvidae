<script lang="ts" module>
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
    icon?: Snippet;
  };
</script>

<script lang="ts">
  import ChevronLeft from '@lucide/svelte/icons/chevron-left';

  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import Button from '../button/button.svelte';
  import Tooltip from '@lostgradient/tooltip/components/tooltip/tooltip.svelte';
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
