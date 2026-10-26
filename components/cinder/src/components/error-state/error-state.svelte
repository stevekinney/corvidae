<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status stable
   * @purpose Error placeholder, centered in an alert or flat on the surrounding surface, with a title, description, optional detail, and optional retry button for a region whose data failed to load.
   * @tag feedback
   * @tag error
   * @useWhen Replacing a primary content region after its query or request failed, so the failure never looks like an empty result.
   * @useWhen Offering the user a retry for a region that can be reloaded.
   * @avoidWhen Communicating that a region has no data — use empty-state instead.
   * @avoidWhen Reporting the result of a just-completed action — use alert or toast-region.
   * @related alert, empty-state, banner
   */
  export type { ErrorStateProps, ErrorStateVariant } from './error-state.types.ts';
</script>

<script lang="ts">
  import Alert from '../alert/alert.svelte';
  import Button from '../button/button.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import type { ErrorStateProps } from './error-state.types.ts';

  let {
    title,
    description,
    detail,
    onRetry,
    retryLabel = 'Try again',
    headingLevel = 2,
    variant = 'default',
    class: className,
    ...rest
  }: ErrorStateProps = $props();

  // SSR-safe, per-instance id so the alert names itself from its title.
  const titleId = $props.id();

  // Coerce + clamp at runtime: a consumer can pass 0, 7, NaN, or a non-numeric
  // value despite the TS literal union, and <h0>/<hNaN> is invalid markup.
  const safeLevel = $derived(
    Number.isFinite(Math.trunc(Number(headingLevel)))
      ? Math.min(6, Math.max(1, Math.trunc(Number(headingLevel))))
      : 2,
  );
  const tag = $derived(`h${safeLevel}`);
</script>

{#snippet body()}
  <svelte:element this={tag} id={titleId} class="cinder-error-state-title">
    {title}
  </svelte:element>
  <p class="cinder-error-state-description">{description}</p>
  {#if detail}
    <p class="cinder-error-state-detail">{detail}</p>
  {/if}
  {#if onRetry}
    <div class="cinder-error-state-action">
      <Button variant="secondary" label={retryLabel} onclick={() => onRetry()} />
    </div>
  {/if}
{/snippet}

<div
  {...rest}
  class={classNames('cinder-error-state', className)}
  data-cinder-variant={variant === 'flat' ? 'flat' : undefined}
>
  {#if variant === 'flat'}
    <div class="cinder-error-state-body" role="alert" aria-labelledby={titleId}>
      {@render body()}
    </div>
  {:else}
    <Alert variant="danger" class="cinder-error-state-alert" aria-labelledby={titleId}>
      <div class="cinder-error-state-body">
        {@render body()}
      </div>
    </Alert>
  {/if}
</div>
