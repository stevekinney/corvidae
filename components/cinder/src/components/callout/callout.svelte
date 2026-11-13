<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status stable
   * @purpose Inline static note or aside that highlights supporting commentary alongside body content without claiming live-region urgency.
   * @tag feedback
   * @tag notice
   * @useWhen Drawing attention to tangential information nested inside prose, documentation, or article content.
   * @useWhen Calling out a tip, note, or caveat that belongs next to the content it qualifies.
   * @useWhen Explaining a state in a quiet neutral note that is not a problem, with one link or button at its end.
   * @avoidWhen Announcing a transient or urgent status — use alert or banner instead.
   * @avoidWhen Communicating a page-wide system message — use banner so it reads as a landmark region.
   * @avoidWhen Wrapping a form control or an inline choice, such as a segmented-control — place it in the page flow with a plain label instead.
   * @related alert, banner
   */
  export type { CalloutProps, CalloutSemantic, CalloutVariant } from './callout.types.ts';
</script>

<script lang="ts">
  import type { HTMLAttributes } from 'svelte/elements';

  import { classNames } from '../../utilities/class-names.ts';
  import type { CalloutProps } from './callout.types.ts';

  let {
    variant = 'neutral',
    semantic = 'aside',
    title,
    icon,
    action,
    actionLayout = 'inline',
    progress,
    onDismiss,
    dismissLabel = 'Dismiss',
    class: className,
    children,
    ...rest
  }: CalloutProps = $props();

  // Strip role + live-region attributes from rest props. The type
  // already omits these, but a consumer can escape the type system
  // (`as never`, spread from an `unknown` source). Scrubbing at runtime
  // guarantees the hard invariant that a callout is never announced as
  // a live region and never overrides the component-owned root role.
  // Mirrors banner.svelte's defense-in-depth pattern.
  const restWithoutForbidden = $derived.by(() => {
    const {
      role: _role,
      'aria-live': _ariaLive,
      'aria-atomic': _ariaAtomic,
      'aria-relevant': _ariaRelevant,
      'aria-busy': _ariaBusy,
      ...filtered
    } = rest as HTMLAttributes<HTMLElement> & Record<string, unknown>;
    return filtered;
  });

  // Derive an accessible name for the root so an aside callout that lands at
  // landmark level is not an unnamed `complementary` landmark, and a note mode
  // callout has the expected note name. Priority mirrors banner.svelte:
  // consumer `aria-labelledby` > consumer `aria-label` > `title`.
  const ariaLabel = $derived(rest['aria-labelledby'] ? undefined : (rest['aria-label'] ?? title));
</script>

<svelte:element
  this={semantic === 'note' ? 'div' : 'aside'}
  {...restWithoutForbidden}
  class={classNames(
    'cinder-callout',
    actionLayout === 'inline' && 'cinder-callout--inline-action',
    icon && 'cinder-callout--with-icon',
    onDismiss && 'cinder-callout--dismissible',
    variant !== 'neutral' && 'cinder-_status-surface',
    variant !== 'neutral' && 'cinder-_status-surface-border',
    className,
  )}
  data-cinder-variant={variant}
  role={semantic === 'note' ? 'note' : undefined}
  aria-label={ariaLabel}
>
  {#if icon}
    <div class="cinder-callout__icon" aria-hidden="true">
      {@render icon()}
    </div>
  {/if}

  {#if actionLayout === 'inline' && action}
    <div class="cinder-callout__body">
      {@render contentBlock()}
      <div class="cinder-callout__action">
        {@render action()}
      </div>
    </div>
  {:else}
    {@render contentBlock()}
    {#if action}
      <div class="cinder-callout__action">
        {@render action()}
      </div>
    {/if}
  {/if}

  {#if onDismiss}
    <button
      type="button"
      class="cinder-_dismiss-button cinder-callout__dismiss"
      aria-label={dismissLabel}
      onclick={onDismiss}
    >
      <svg
        class="cinder-callout__dismiss-icon"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 20 20"
        fill="currentColor"
        aria-hidden="true"
      >
        <path
          d="M6.28 5.22a.75.75 0 00-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 101.06 1.06L10 11.06l3.72 3.72a.75.75 0 101.06-1.06L11.06 10l3.72-3.72a.75.75 0 00-1.06-1.06L10 8.94 6.28 5.22z"
        />
      </svg>
    </button>
  {/if}
</svelte:element>

{#snippet contentBlock()}
  <div class="cinder-callout__content">
    {#if title}
      <p class="cinder-callout__title">{title}</p>
    {/if}
    {@render children()}
    {#if progress}
      <div class="cinder-callout__progress">
        {@render progress()}
      </div>
    {/if}
  </div>
{/snippet}
