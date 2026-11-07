<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status stable
   * @purpose Page-level dismissible region landmark that surfaces a persistent informational, success, warning, or danger message.
   * @tag feedback
   * @tag notice
   * @useWhen Communicating a persistent page-level status the user can dismiss, such as a maintenance window or trial expiry.
   * @useWhen Reporting that the browser is offline, the server is unreachable, a refresh failed or a restart is running, using a connection preset.
   * @useWhen Pinning a non-urgent message above page content that should remain readable until acknowledged.
   * @avoidWhen Announcing an urgent, time-sensitive message — use alert so assistive tech reads it immediately.
   * @avoidWhen Highlighting an inline aside next to related prose — use callout instead.
   * @related alert, callout, toast-region
   */
  const VARIANT_LABEL = {
    neutral: 'Notice',
    info: 'Information',
    success: 'Success',
    warning: 'Warning',
    danger: 'Error',
  } as const;

  export type { BannerPreset, BannerProps, BannerVariant } from './banner.types.ts';
</script>

<script lang="ts">
  import type { BannerProps, BannerVariant } from './banner.types.ts';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import RefreshCw from '@lucide/svelte/icons/refresh-cw';
  import Unplug from '@lucide/svelte/icons/unplug';
  import WifiOff from '@lucide/svelte/icons/wifi-off';
  import { tick } from 'svelte';
  import Button from '../button/button.svelte';
  import { bannerPresetCopy, type BannerPreset } from './banner-presets.ts';
  import RelativeTime from '../relative-time/relative-time.svelte';
  import { classNames } from '../../utilities/class-names.ts';

  const FOCUSABLE_SELECTOR =
    'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /** The tone, accessible name, glyph and retry prominence each preset fixes. */
  const PRESETS: Record<
    BannerPreset,
    {
      variant: BannerVariant;
      label: string;
      glyph?: 'offline' | 'connection';
      primaryRetry?: boolean;
    }
  > = {
    offline: { variant: 'warning', label: 'Connection problem', glyph: 'offline' },
    unreachable: { variant: 'warning', label: 'Connection problem', glyph: 'connection' },
    stopped: {
      variant: 'warning',
      label: 'Connection problem',
      glyph: 'connection',
      primaryRetry: true,
    },
    'out-of-date': {
      variant: 'warning',
      label: 'Connection problem',
      glyph: 'connection',
      primaryRetry: true,
    },
    'refresh-failed': { variant: 'warning', label: 'Refresh problem' },
    restarting: { variant: 'info', label: 'Restart status' },
    reconnecting: { variant: 'info', label: 'Restart status' },
    'restart-failed': { variant: 'warning', label: 'Restart status' },
    'back-online': { variant: 'success', label: 'Connection restored' },
  };

  /** Presets that never offer Retry now, with or without `onRetry`. */
  const WITHOUT_RETRY: readonly BannerPreset[] = ['restarting', 'restart-failed', 'back-online'];

  let {
    variant = 'info',
    dismissible = true,
    onDismiss,
    preset,
    onRetry,
    retryLabel,
    retryVariant,
    dataUpdatedAt,
    staleDataLabel = 'Showing data from',
    subject,
    retryInSeconds,
    attempt,
    maxAttempts,
    consequence,
    timeZone,
    title,
    titleLayout,
    icon,
    sticky = false,
    stackActions = false,
    onRestart,
    onOpenHealth,
    healthHref,
    class: className,
    children,
    actions,
    ...rest
  }: BannerProps = $props();

  let visible = $state(true);
  let rootElement: HTMLDivElement | undefined = $state();

  async function handleDismiss() {
    if (!visible) return;
    const focusTarget = rootElement ? resolveFocusTarget(rootElement) : null;
    visible = false;
    await tick();
    if (focusTarget?.isConnected) focusTarget.focus();
    onDismiss?.();
  }

  function resolveFocusTarget(bannerElement: HTMLElement): HTMLElement | null {
    const bannerDocument = bannerElement.ownerDocument;
    const activeElement = bannerDocument.activeElement;
    if (!(activeElement instanceof HTMLElement) || !bannerElement.contains(activeElement)) {
      return null;
    }
    return findFocusTarget(bannerElement, bannerDocument, activeElement);
  }

  function findFocusTarget(
    bannerElement: HTMLElement,
    bannerDocument: Document,
    activeElement: HTMLElement,
  ): HTMLElement {
    const candidates = Array.from(
      bannerDocument.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
    ).filter(
      (element) =>
        element !== activeElement &&
        !bannerElement.contains(element) &&
        !element.hidden &&
        element.getAttribute('aria-hidden') !== 'true' &&
        !element.closest('[hidden], [inert], [aria-hidden="true"]'),
    );

    const next = candidates.find((element) =>
      Boolean(bannerElement.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
    const previous = candidates.findLast((element) =>
      Boolean(bannerElement.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_PRECEDING),
    );

    return next ?? previous ?? bannerDocument.body;
  }

  // Strip live-region attributes from rest so a consumer cannot turn a
  // persistent landmark banner back into an assertive announcement (which
  // would defeat the role="region" design — see banner.a11y.md). `aria-busy`
  // is intentionally NOT stripped: it is a status flag, not a live-region
  // attribute, and is valid on `role="region"` to signal that banner
  // content is updating.
  const restWithoutLiveRegion = $derived.by(() => {
    const {
      'aria-live': _ariaLive,
      'aria-atomic': _ariaAtomic,
      'aria-relevant': _ariaRelevant,
      ...filtered
    } = rest;
    return filtered;
  });

  const presetConfiguration = $derived(preset ? PRESETS[preset] : undefined);
  const resolvedVariant = $derived(presetConfiguration?.variant ?? variant);
  const ariaLabel = $derived(
    rest['aria-labelledby']
      ? undefined
      : (rest['aria-label'] ??
          presetConfiguration?.label ??
          VARIANT_LABEL[resolvedVariant] ??
          VARIANT_LABEL.info),
  );

  // A preset writes its own words unless the page passes children, which replace them.
  const generated = $derived(
    preset !== undefined && children === undefined
      ? bannerPresetCopy(preset, {
          asOf: dataUpdatedAt,
          subject,
          retryInSeconds,
          attempt,
          maxAttempts,
          consequence,
          timeZone,
          title,
        })
      : undefined,
  );
  const resolvedTitle = $derived(generated?.title ?? title);
  const resolvedTitleLayout = $derived(titleLayout ?? (preset ? 'inline' : 'stacked'));
  // The age of the data reads as a relative notice only where the words are the page's own.
  const showsStaleNotice = $derived(dataUpdatedAt !== undefined && generated === undefined);
  const resolvedDismissible = $derived(preset ? false : dismissible);
  const resolvedRetryLabel = $derived(retryLabel ?? (preset ? 'Retry now' : 'Retry'));
  const resolvedRetryVariant = $derived(
    retryVariant ?? (presetConfiguration?.primaryRetry ? 'primary' : 'secondary'),
  );
  const showsRetry = $derived(
    onRetry !== undefined && (preset === undefined || !WITHOUT_RETRY.includes(preset)),
  );
  const showsRestartActions = $derived(preset === 'restart-failed');
  const hasActions = $derived(showsRetry || showsRestartActions || actions !== undefined);
</script>

{#snippet retryIcon()}
  <RefreshCw size={14} aria-hidden="true" />
{/snippet}

{#if visible}
  <div
    bind:this={rootElement}
    {...restWithoutLiveRegion}
    class={classNames(
      'cinder-banner',
      resolvedVariant !== 'neutral' && 'cinder-_status-surface',
      resolvedVariant !== 'neutral' && 'cinder-_status-surface-border',
      className,
    )}
    data-cinder-variant={resolvedVariant}
    data-cinder-preset={preset}
    data-cinder-sticky={sticky ? 'true' : undefined}
    role="region"
    aria-label={ariaLabel}
  >
    {#if icon || presetConfiguration?.glyph || resolvedVariant === 'success'}
      <span class="cinder-banner__icon" aria-hidden="true">
        {#if icon}
          {@render icon()}
        {:else if presetConfiguration?.glyph === 'offline'}
          <WifiOff size={16} aria-hidden="true" />
        {:else if presetConfiguration?.glyph === 'connection'}
          <Unplug size={16} aria-hidden="true" />
        {:else}
          <CircleCheck size={16} aria-hidden="true" />
        {/if}
      </span>
    {/if}

    <div class="cinder-banner__content">
      {#if resolvedTitle}
        <strong class="cinder-banner__title" data-cinder-title-layout={resolvedTitleLayout}
          >{resolvedTitle}</strong
        >{' '}
      {/if}
      {#if generated}
        <span class="cinder-banner__text">{generated.text}</span>
      {:else if children && resolvedTitle}
        <span class="cinder-banner__text">{@render children()}</span>
      {:else if children}
        {@render children()}
      {/if}
      {#if showsStaleNotice && dataUpdatedAt !== undefined}
        <span class="cinder-banner__stale"
          >{staleDataLabel} <RelativeTime date={dataUpdatedAt} /></span
        >
      {/if}
    </div>

    {#if hasActions}
      <div class="cinder-banner__actions" data-cinder-stacked={stackActions ? 'true' : undefined}>
        {#if showsRetry}
          <Button
            variant={resolvedRetryVariant}
            size="sm"
            label={resolvedRetryLabel}
            leadingIcon={retryIcon}
            onclick={() => onRetry?.()}
          />
        {/if}
        {#if showsRestartActions}
          {#if healthHref}
            <Button variant="secondary" size="sm" label="Open Health" href={healthHref} />
          {:else}
            <Button
              variant="secondary"
              size="sm"
              label="Open Health"
              onclick={() => onOpenHealth?.()}
            />
          {/if}
          <Button variant="primary" size="sm" label="Restart again" onclick={() => onRestart?.()} />
        {/if}
        {#if actions}
          {@render actions()}
        {/if}
      </div>
    {/if}

    {#if resolvedDismissible}
      <button
        type="button"
        class="cinder-_dismiss-button cinder-banner__dismiss"
        onclick={handleDismiss}
        aria-label="Dismiss banner"
      >
        <svg
          class="cinder-banner__dismiss-icon"
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
  </div>
{/if}
