<script lang="ts" module>
  export type {
    ErrorStateProps,
    ErrorStateRetryVariant,
    ErrorStateSize,
    ErrorStateTone,
    ErrorStateVariant,
  } from './error-state.types.ts';
</script>

<script lang="ts">
  import { RefreshCw, Search, TriangleAlert } from '@lucide/svelte';

  import Button from '../button/button.svelte';
  import DisclosureTrigger from '../disclosure-trigger/disclosure-trigger.svelte';
  import { classNames } from '../../utilities/class-names.ts';
  import type { ErrorStateProps } from './error-state.types.ts';

  let {
    title,
    description,
    remediation,
    detail,
    detailsLabel = 'Show the error details',
    retryStatus,
    tone = 'danger',
    announce = false,
    onRetry,
    retryLabel = 'Try again',
    retryVariant = 'primary',
    retryIcon,
    secondaryAction,
    icon,
    headingLevel = 2,
    variant = 'default',
    size = 'default',
    bordered = false,
    measure = false,
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
  const safeTone = $derived(tone === 'neutral' || tone === 'warning' ? tone : 'danger');
  // A failure is an alert; a warning is a status and a neutral state a plain group, unless the
  // caller raises either to an alert with `announce`.
  const role = $derived(
    safeTone === 'danger' || announce ? 'alert' : safeTone === 'warning' ? 'status' : 'group',
  );
  const flat = $derived(variant === 'flat');
  const row = $derived(variant === 'row');
  const compact = $derived(size === 'compact' && !flat && !row);
  const detailId = $props.id();
  let detailOpen = $state(false);
</script>

<div
  {...rest}
  class={classNames('cinder-error-state', className)}
  data-cinder-variant={flat ? 'flat' : row ? 'row' : undefined}
  data-cinder-size={compact ? 'compact' : undefined}
  data-cinder-bordered={bordered && !flat ? '' : undefined}
  data-cinder-measure={measure ? '' : undefined}
  data-cinder-tone={safeTone}
>
  <!-- A failure is announced as an alert; a neutral state (nothing failed) is a plain group. -->
  <div class="cinder-error-state-body" {role} aria-labelledby={titleId}>
    {#if row}
      <!-- The glyph and the words are one start-aligned group, so the row centres the group, not the glyph. -->
      <div class="cinder-error-state-lead">
        <span class="cinder-error-state-glyph" aria-hidden="true">
          {#if icon}
            {@render icon()}
          {:else if safeTone === 'neutral'}
            <Search />
          {:else}
            <TriangleAlert />
          {/if}
        </span>
        <div class="cinder-error-state-text">
          <svelte:element this={tag} id={titleId} class="cinder-error-state-title">
            {title}
          </svelte:element>
          <!-- A row whose title is its whole sentence passes no description, and draws no empty line. -->
          {#if description !== ''}
            <p class="cinder-error-state-description">{description}</p>
          {/if}
          {#if remediation}
            <p class="cinder-error-state-remediation">{remediation}</p>
          {/if}
          {#if retryStatus}
            <p class="cinder-error-state-status" aria-live="off">{retryStatus}</p>
          {/if}
        </div>
      </div>
      {#if onRetry || secondaryAction}
        <div class="cinder-error-state-action">
          {#if secondaryAction}
            {@render secondaryAction()}
          {/if}
          {#if onRetry}
            {#if retryIcon}
              <Button variant="secondary" size="sm" label={retryLabel} onclick={() => onRetry()}>
                {#snippet leadingIcon()}{@render retryIcon()}{/snippet}
              </Button>
            {:else}
              <Button variant="secondary" size="sm" label={retryLabel} onclick={() => onRetry()} />
            {/if}
          {/if}
        </div>
      {/if}
      {#if detail}
        <div class="cinder-error-state-details">
          <DisclosureTrigger open={detailOpen} controls={detailId} class="cinder-error-state-details-summary" onclick={() => (detailOpen = !detailOpen)}>{detailsLabel}</DisclosureTrigger>
          <p id={detailId} class="cinder-error-state-detail" hidden={!detailOpen}>{detail}</p>
        </div>
      {/if}
    {:else}
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
      {#if remediation}
        <p class="cinder-error-state-remediation">{remediation}</p>
      {/if}
      {#if retryStatus}
        <p class="cinder-error-state-status" aria-live="off">{retryStatus}</p>
      {/if}
      {#if onRetry || secondaryAction}
        <div class="cinder-error-state-action">
          {#if secondaryAction}
            {@render secondaryAction()}
          {/if}
          {#if onRetry}
            {#if compact}
              {#if retryIcon}
                <Button variant="secondary" size="sm" label={retryLabel} onclick={() => onRetry()}>
                  {#snippet leadingIcon()}{@render retryIcon()}{/snippet}
                </Button>
              {:else}
                <Button
                  variant="secondary"
                  size="sm"
                  label={retryLabel}
                  onclick={() => onRetry()}
                />
              {/if}
            {:else}
              <Button
                variant={retryVariant === 'secondary' ? 'secondary' : 'primary'}
                label={retryLabel}
                onclick={() => onRetry()}
              >
                {#snippet leadingIcon()}
                  {#if retryIcon}
                    {@render retryIcon()}
                  {:else}
                    <RefreshCw size={14} aria-hidden="true" />
                  {/if}
                {/snippet}
              </Button>
            {/if}
          {/if}
        </div>
      {/if}
      {#if detail}
        <div class="cinder-error-state-details">
          <DisclosureTrigger open={detailOpen} controls={detailId} class="cinder-error-state-details-summary" onclick={() => (detailOpen = !detailOpen)}>{detailsLabel}</DisclosureTrigger>
          <p id={detailId} class="cinder-error-state-detail" hidden={!detailOpen}>{detail}</p>
        </div>
      {/if}
    {/if}
  </div>
</div>
