<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status stable
   * @purpose Centred error placeholder with a disc, title, description, progress line, retry, secondary action and details disclosure for a failed load, or a neutral not-found state.
   * @tag feedback
   * @tag error
   * @useWhen Replacing a primary content region after its query or request failed, so the failure never looks like an empty result.
   * @useWhen Offering the user a retry for a region that can be reloaded, with the retry as the only primary action on the page.
   * @useWhen Telling a person that the thing they asked for doesn't exist, using the neutral tone.
   * @avoidWhen Communicating that a region has no data — use empty-state instead.
   * @avoidWhen Reporting the result of a just-completed action — use alert or toast-region.
   * @related alert, empty-state, banner
   */
  export type { ErrorStateProps, ErrorStateTone, ErrorStateVariant } from './error-state.types.ts';
</script>

<script lang="ts">
  import { RefreshCw, Search, TriangleAlert } from '@lucide/svelte';

  import Button from '../button/button.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import type { ErrorStateProps } from './error-state.types.ts';

  let {
    title,
    description,
    detail,
    detailsLabel = 'Show the error details',
    retryStatus,
    tone = 'danger',
    onRetry,
    retryLabel = 'Try again',
    secondaryAction,
    icon,
    headingLevel = 2,
    variant = 'default',
    class: className,
    ...rest
  }: ErrorStateProps = $props();

  // SSR-safe, per-instance id so the body names itself from its title.
  const titleId = $props.id();

  // Coerce + clamp at runtime: a consumer can pass 0, 7, NaN, or a non-numeric
  // value despite the TS literal union, and <h0>/<hNaN> is invalid markup.
  const safeLevel = $derived(
    Number.isFinite(Math.trunc(Number(headingLevel)))
      ? Math.min(6, Math.max(1, Math.trunc(Number(headingLevel))))
      : 2,
  );
  const tag = $derived(`h${safeLevel}`);

  // An unknown tone behaves as a failure, so an error is never silently demoted to a quiet group.
  const safeTone = $derived(tone === 'neutral' ? 'neutral' : 'danger');
  const flat = $derived(variant === 'flat');
</script>

<div
  {...rest}
  class={classNames('cinder-error-state', className)}
  data-cinder-variant={flat ? 'flat' : undefined}
  data-cinder-tone={safeTone}
>
  <!-- A failure is announced as an alert; a neutral state (nothing failed) is a plain group. -->
  <div
    class="cinder-error-state-body"
    role={safeTone === 'danger' ? 'alert' : 'group'}
    aria-labelledby={titleId}
  >
    {#if !flat}
      <span class="cinder-error-state-icon" aria-hidden="true">
        {#if icon}
          {@render icon()}
        {:else if safeTone === 'neutral'}
          <Search />
        {:else}
          <TriangleAlert />
        {/if}
      </span>
    {/if}
    <svelte:element this={tag} id={titleId} class="cinder-error-state-title">
      {title}
    </svelte:element>
    <p class="cinder-error-state-description">{description}</p>
    {#if retryStatus}
      <p class="cinder-error-state-status" aria-live="off">{retryStatus}</p>
    {/if}
    {#if onRetry || secondaryAction}
      <div class="cinder-error-state-action">
        {#if onRetry}
          <Button variant="primary" label={retryLabel} onclick={() => onRetry()}>
            {#snippet leadingIcon()}
              <RefreshCw />
            {/snippet}
          </Button>
        {/if}
        {#if secondaryAction}
          {@render secondaryAction()}
        {/if}
      </div>
    {/if}
    {#if detail}
      <details class="cinder-error-state-details">
        <summary class="cinder-error-state-details-summary">{detailsLabel}</summary>
        <p class="cinder-error-state-detail">{detail}</p>
      </details>
    {/if}
  </div>
</div>
