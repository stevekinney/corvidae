<script lang="ts" module>
  /**
   * @cinder
   * @category feedback
   * @status stable
   * @purpose In-flow confirmation for reversible actions without modal interruption.
   * @useWhen Confirming a reversible action in the same flow as its trigger.
   * @avoidWhen The action requires modal interruption or extensive consequences; use ConfirmDialog.
   * @related confirm-dialog
   * @rationale Nearest alternative: ConfirmDialog interrupts with a modal; this keeps confirmation in flow.
   */
  export type { InlineConfirmProps } from './inline-confirm.types.ts';
</script>

<script lang="ts">
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import { onDestroy, tick, untrack } from 'svelte';
  import { default as Button } from '../button/index.ts';
  import { pushEscapeHandler } from '../../_internal/overlay.ts';
  import { classNames } from '../../utilities/class-names.ts';
  import type { InlineConfirmProps } from './inline-confirm.types.ts';

  let {
    prompt,
    confirmLabel,
    cancelLabel = 'Cancel',
    destructive = false,
    flush = false,
    open = $bindable(false),
    onConfirm,
    onCancel,
    class: className,
    children,
    presentation = 'strip',
    armed = $bindable(false),
    requestKey,
    disabled = false,
    blocked = false,
    requiresSecondPress = true,
    ariaDisabled,
    armedLabel,
    armedHint,
    armedEscapeHint,
    loading = false,
    loadingLabel,
    ariaDescribedBy,
    hintClass,
    hintId,
  }: InlineConfirmProps = $props();
  let root: HTMLElement | null = $state(null);
  let trigger: HTMLElement | null = $state(null);
  let releaseEscape: (() => void) | null = null;
  let wasOpen = false;
  // How the user last interacted, so moving focus to Cancel shows a focus ring
  // after a keyboard activation and not after a click. Tracked for the whole
  // time the component is mounted, because the input that OPENS the strip
  // happens before it renders.
  let lastInputWasKeyboard = false;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseArmEscape: (() => void) | null = null;
  let previousRequestKey = untrack(() => requestKey);

  function disarm(): void {
    if (armTimer !== undefined) clearTimeout(armTimer);
    armTimer = undefined;
    releaseArmEscape?.();
    releaseArmEscape = null;
    armed = false;
  }

  function arm(): void {
    // A parent may have cleared the bindable `armed` value. Clear any old resources before a
    // fresh arm so an externally disarmed action can never inherit its prior timer or Escape hook.
    disarm();
    armed = true;
    armTimer = setTimeout(disarm, 3_000);
    releaseArmEscape = pushEscapeHandler((event) => {
      event.preventDefault();
      disarm();
    });
  }

  $effect(() => {
    if (presentation !== 'two-press' || armed) return;
    if (armTimer !== undefined || releaseArmEscape !== null) disarm();
  });

  $effect(() => {
    const onKeydown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.altKey && !event.ctrlKey) lastInputWasKeyboard = true;
    };
    const onPointerdown = () => {
      lastInputWasKeyboard = false;
    };
    document.addEventListener('keydown', onKeydown, true);
    document.addEventListener('pointerdown', onPointerdown, true);
    return () => {
      document.removeEventListener('keydown', onKeydown, true);
      document.removeEventListener('pointerdown', onPointerdown, true);
    };
  });

  $effect(() => {
    if (presentation !== 'two-press' || requestKey === previousRequestKey) return;
    previousRequestKey = requestKey;
    disarm();
  });

  $effect(() => {
    if (presentation === 'two-press' && (disabled || blocked || loading)) disarm();
  });

  $effect(() => {
    if (presentation === 'two-press' || open === wasOpen) return;
    wasOpen = open;
    if (open) {
      trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      releaseEscape = pushEscapeHandler((event) => {
        event.preventDefault();
        cancel();
      });
      void tick().then(() =>
        root
          ?.querySelector<HTMLElement>('[data-cinder-inline-cancel]')
          ?.focus({ preventScroll: true, focusVisible: lastInputWasKeyboard }),
      );
    } else {
      releaseEscape?.();
      releaseEscape = null;
      restoreTriggerFocus();
    }
  });

  onDestroy(() => {
    disarm();
    releaseEscape?.();
    releaseEscape = null;
    restoreTriggerFocus();
  });

  function restoreTriggerFocus(): void {
    if (trigger?.isConnected) trigger.focus({ preventScroll: true });
    trigger = null;
  }

  function cancel(): void {
    open = false;
    onCancel?.();
  }
  function confirm(): void {
    open = false;
    onConfirm?.();
  }

  function pressTwoPressAction(): void {
    if (disabled || blocked || loading) return;
    if (requiresSecondPress && !armed) {
      arm();
      return;
    }
    disarm();
    onConfirm?.();
  }
</script>

{#if presentation === 'two-press'}
  <span class={classNames('cinder-inline-confirm__two-press', className)}>
    <Button
      variant={armed ? 'danger' : 'primary'}
      size="sm"
      disabled={disabled || loading}
      {loading}
      {...ariaDisabled || blocked ? { 'aria-disabled': 'true' } : {}}
      {...loadingLabel !== undefined ? { loadingStatus: loadingLabel } : {}}
      {...ariaDescribedBy !== undefined ? { 'aria-describedby': ariaDescribedBy } : {}}
      onclick={pressTwoPressAction}
      label={loading
        ? (loadingLabel ?? confirmLabel)
        : armed
          ? (armedLabel ?? `Press again to ${confirmLabel.toLowerCase()}`)
          : confirmLabel}
    ></Button>
    {#if armed && armedHint !== undefined}
      <span
        id={hintId}
        class={classNames('cinder-inline-confirm__two-press-hint', hintClass)}
        role="status"
      >
        {armedHint}
        {#if armedEscapeHint !== undefined}
          <span class="cinder-inline-confirm__armed-escape">
            {' '}{armedEscapeHint}
          </span>
        {/if}
      </span>
    {/if}
  </span>
{:else if open}
  <div
    bind:this={root}
    class={classNames('cinder-inline-confirm', className)}
    data-cinder-destructive={destructive ? '' : undefined}
    data-cinder-flush={flush ? '' : undefined}
    role="group"
    aria-label={prompt ?? confirmLabel}
  >
    <p class="cinder-inline-confirm__prompt">
      {#if destructive}
        <TriangleAlert class="cinder-icon-sm cinder-inline-confirm__glyph" aria-hidden="true" />
      {/if}
      <span>{prompt}</span>
    </p>
    {@render children?.()}
    <div class="cinder-inline-confirm__actions">
      <Button
        variant="secondary"
        size="xs"
        data-cinder-inline-cancel
        onclick={cancel}
        label={cancelLabel}
      ></Button>
      <Button
        variant={destructive ? 'danger' : 'primary'}
        size="xs"
        onclick={confirm}
        label={confirmLabel}
      ></Button>
    </div>
  </div>
{/if}
