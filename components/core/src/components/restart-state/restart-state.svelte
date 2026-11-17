<script lang="ts" module>
  /**
   * @cinder
   * @category overlay
   * @status beta
   * @purpose The screen people see while the Interborough host restarts: a page takeover with the steps, the reconnect attempts with Retry now, and what to check and run if it fails.
   * @tag overlay
   * @tag restart
   * @tag progress
   * @useWhen The person confirmed a restart and the page must say what is happening while the host stops answering.
   * @useWhen The host did not come back and the person needs the way back: what to check, the exact command, and a choice to keep waiting.
   * @avoidWhen Asking whether to restart at all — use confirm-dialog first.
   * @avoidWhen Showing that the connection dropped on its own — use banner with the reconnecting preset.
   * @rationale Nearest alternative: Modal — a modal can be dismissed; this one is not, because the host is not answering and nothing behind it is true.
   * @related confirm-dialog, banner, steps, modal
   */
  export type { RestartStatePhase, RestartStateProps } from './restart-state.types.ts';
</script>

<script lang="ts">
  import RotateCw from '@lucide/svelte/icons/rotate-cw';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import WifiOff from '@lucide/svelte/icons/wifi-off';

  import { classNames } from '../../utilities/class-names.ts';
  import { BANNER_MAX_ATTEMPTS } from '../banner/banner-presets.ts';
  import Button from '../button/button.svelte';
  import CopyButton from '../copy-button/copy-button.svelte';
  import Modal from '../modal/modal.svelte';
  import Steps from '../steps/steps.svelte';
  import type { RestartStateProps } from './restart-state.types.ts';

  const DEFAULT_STEPS = [
    'Saved your choice',
    'Stopped the server',
    'Starting Interborough',
    'Checking plugins',
  ] as const;
  const TITLES = {
    restarting: 'Restarting Interborough',
    reconnecting: 'Waiting for Interborough',
    failed: 'Interborough didn’t come back',
  } as const;

  const descriptionId = $props.id();

  let {
    open,
    phase,
    title,
    description,
    steps = DEFAULT_STEPS,
    currentStep = 0,
    attempt,
    maxAttempts = BANNER_MAX_ATTEMPTS,
    retryInSeconds,
    retryLabel = 'Retry now',
    onRetry,
    checkTitle = 'What to check',
    check,
    details,
    detailsLabel = 'Show the error details',
    command,
    commandLabel = 'Start it again from the terminal:',
    copyLabel = 'Copy the command',
    keepWaitingLabel = 'Keep waiting',
    onKeepWaiting,
    class: className,
  }: RestartStateProps = $props();

  const resolvedTitle = $derived(title?.trim() || TITLES[phase]);
  const segmentCount = $derived(Math.max(1, Math.floor(maxAttempts)));
  const filledSegments = $derived(
    attempt === undefined ? 0 : Math.max(0, Math.min(segmentCount, Math.floor(attempt))),
  );
  const attemptText = $derived(
    attempt === undefined ? undefined : `Attempt ${filledSegments} of ${segmentCount}.`,
  );
  const retryText = $derived(
    retryInSeconds === undefined
      ? undefined
      : `Trying again in ${Math.max(0, Math.ceil(retryInSeconds))} s.`,
  );
  const resolvedDescription = $derived.by(() => {
    const given = description?.trim();
    if (given) return given;
    if (phase === 'reconnecting') {
      return ['The server stopped and hasn’t answered yet.', retryText, attemptText]
        .filter(Boolean)
        .join(' ');
    }
    if (phase === 'failed') return `It didn’t answer after ${segmentCount} tries.`;
    return undefined;
  });
  const stepItems = $derived(
    steps.map((label, index) => ({ id: `${index}`, label, done: index < currentStep })),
  );
</script>

<!--
  Nothing here dismisses the state: the host is not answering, so the page behind it would show
  nothing true. The chromeless modal gives the scrim, the focus trap and the scroll lock; the card
  is drawn here because the default header cannot carry the phase's icon.
-->
<Modal
  {open}
  chrome="none"
  aria-label={resolvedTitle}
  dismissOnEscape={false}
  dismissOnBackdropClick={false}
  closeButtonVisible={false}
  class={classNames('cinder-restart-state', className)}
  {...resolvedDescription ? { describedById: descriptionId } : {}}
>
  <div class="cinder-restart-state__layout">
    <section class="cinder-restart-state__card" data-cinder-phase={phase}>
      <h2 class="cinder-restart-state__title">
        <span class="cinder-restart-state__icon" aria-hidden="true">
          {#if phase === 'restarting'}
            <RotateCw size={18} />
          {:else if phase === 'reconnecting'}
            <WifiOff size={18} />
          {:else}
            <TriangleAlert size={18} />
          {/if}
        </span>
        {resolvedTitle}
      </h2>

      {#if resolvedDescription}
        <p id={descriptionId} class="cinder-restart-state__description">{resolvedDescription}</p>
      {/if}

      {#if phase === 'restarting'}
        <Steps variant="status" label="Restart progress" steps={stepItems} />
      {:else if phase === 'reconnecting'}
        <div class="cinder-restart-state__attempts" aria-hidden="true">
          {#each { length: segmentCount } as _, index (index)}
            <span
              class="cinder-restart-state__segment"
              data-cinder-filled={index < filledSegments ? '' : undefined}
            ></span>
          {/each}
        </div>
        <!-- The meter is decoration; the attempt count is the status. -->
        <p class="cinder-sr-only" role="status">{attemptText ?? ''}</p>
        {#if onRetry}
          <div class="cinder-restart-state__actions">
            <Button variant="primary" onclick={() => onRetry?.()}>
              {#snippet leadingIcon()}<RotateCw size={14} />{/snippet}
              {retryLabel}
            </Button>
          </div>
        {/if}
      {:else}
        {#if check}
          <div class="cinder-restart-state__check">
            <p class="cinder-restart-state__check-title">{checkTitle}</p>
            <p class="cinder-restart-state__check-text">{check}</p>
          </div>
        {/if}
        {#if details}
          <details class="cinder-restart-state__details">
            <summary class="cinder-restart-state__details-summary">{detailsLabel}</summary>
            <div class="cinder-restart-state__details-body">{@render details()}</div>
          </details>
        {/if}
        {#if command !== undefined}
          <div class="cinder-restart-state__command">
            <span class="cinder-restart-state__command-label">{commandLabel}</span>
            <!-- The command and its copy icon share one flat row; the copy sits at the inline end. -->
            <div class="cinder-restart-state__command-row">
              <code class="cinder-restart-state__command-text">{command}</code>
              <CopyButton
                value={command}
                label={copyLabel}
                copiedLabel="Copied the command."
                class="cinder-restart-state__copy"
              />
            </div>
          </div>
        {/if}
        {#if onKeepWaiting}
          <div class="cinder-restart-state__actions">
            <Button variant="primary" onclick={() => onKeepWaiting?.()}>{keepWaitingLabel}</Button>
          </div>
        {/if}
      {/if}
    </section>
  </div>
</Modal>
