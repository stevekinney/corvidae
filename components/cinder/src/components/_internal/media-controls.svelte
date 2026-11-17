<!--
  Private playback controls shared by AudioPlayer and VideoPlayer. Not exported from
  `@lostgradient/cinder`: the players are the public surface.
-->
<script lang="ts">
  import { classNames } from '@lostgradient/foundation/utilities/class-names.ts';
  import VisuallyHiddenLiveRegion from '@lostgradient/foundation/components/_visually-hidden-live-region.svelte';
  import type { MediaControlsProps } from './media-controls.types.ts';
  import { formatMediaTime, seekFractionForKey } from './media-time.ts';

  let {
    playing = false,
    replay = false,
    disabled = false,
    loading = false,
    unavailable = false,
    progress,
    progressLabel = 'Playback progress',
    layout = 'compact',
    onPlay,
    onPause,
    onReplay,
    onSeek,
    elapsed,
    duration,
    muted = false,
    onToggleMute,
    fullscreen = false,
    onToggleFullscreen,
    class: customClassName,
    ...rest
  }: MediaControlsProps = $props();

  // The time reads only once the length is known: a live stream's Infinity and an unloaded
  // element's NaN show no time rather than a misleading 0:00.
  const hasTime = $derived(
    Number.isFinite(duration) && (duration as number) > 0 && Number.isFinite(elapsed),
  );
  const elapsedText = $derived(formatMediaTime(elapsed ?? 0));
  const durationText = $derived(formatMediaTime(duration ?? 0));

  const isDisabled = $derived(disabled || loading || unavailable);
  const iconOnly = $derived(layout === 'compact');
  // A non-finite progress (NaN/Infinity) is treated as "no progress" rather than
  // rendering a progressbar with NaN aria values — `typeof NaN === 'number'` is
  // true, so the finite check is what actually guards the bar.
  const hasProgress = $derived(Number.isFinite(progress));
  const clampedProgress = $derived(
    Number.isFinite(progress) ? Math.max(0, Math.min(1, progress as number)) : 0,
  );
  const progressPercent = $derived(Math.round(clampedProgress * 100));
  const progressText = $derived(
    hasTime ? `${elapsedText} of ${durationText}` : `${progressPercent}%`,
  );

  let announcement = $state('');

  function handlePlay() {
    if (isDisabled) return;
    announcement = 'Playing';
    onPlay?.();
  }

  function handlePause() {
    if (isDisabled) return;
    announcement = 'Paused';
    onPause?.();
  }

  function handleReplay() {
    if (isDisabled) return;
    announcement = 'Replaying';
    onReplay?.();
  }

  function handleSeek(event: Event & { currentTarget: HTMLInputElement }) {
    if (isDisabled) return;
    const next = event.currentTarget.valueAsNumber;
    if (Number.isFinite(next)) onSeek?.(Math.max(0, Math.min(1, next)));
  }

  // With a known length, the arrow keys move five seconds and Page Up and Page Down a tenth,
  // whatever the length; the slider's own step would move a hundredth, which is a fraction of a
  // second on a short clip and half a minute on an hour. Home and End stay native.
  function handleSeekKey(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (isDisabled || !hasTime) return;
    const next = seekFractionForKey(event.key, clampedProgress, duration as number);
    if (next === undefined) return;
    event.preventDefault();
    onSeek?.(next);
  }

  function handleToggleMute() {
    if (disabled) return;
    onToggleMute?.();
  }

  function handleToggleFullscreen() {
    if (disabled) return;
    onToggleFullscreen?.();
  }

  function handlePrimaryAction() {
    if (replay) {
      handleReplay();
    } else if (playing) {
      handlePause();
    } else {
      handlePlay();
    }
  }

  // The play/pause control is a TOGGLE button, so it keeps a STABLE label and
  // communicates on/off via aria-pressed — never both a changing label AND
  // aria-pressed (which makes AT announce confusing output like "Pause,
  // pressed"). Replay is a momentary action (changing label, no pressed state).
  // Loading / unavailable take precedence so the spoken name matches the visual.
  const isToggle = $derived(!loading && !unavailable && !replay);
  const primaryLabel = $derived(
    loading
      ? 'Loading playback controls'
      : unavailable
        ? 'Playback unavailable'
        : replay
          ? 'Replay'
          : 'Play or pause',
  );

  // aria-pressed applies only to the play/pause toggle (true while playing).
  const primaryPressed = $derived(isToggle ? (playing ? 'true' : 'false') : undefined);
</script>

<div
  {...rest}
  class={classNames('cinder-media-controls', customClassName)}
  data-cinder-layout={layout}
  data-cinder-playing={playing ? '' : undefined}
  data-cinder-loading={loading ? '' : undefined}
  data-cinder-unavailable={unavailable ? '' : undefined}
>
  <button
    type="button"
    class="cinder-media-controls__button"
    aria-label={primaryLabel}
    aria-pressed={primaryPressed}
    aria-disabled={isDisabled ? 'true' : undefined}
    aria-busy={loading ? 'true' : undefined}
    onclick={handlePrimaryAction}
    data-cinder-state={loading
      ? 'loading'
      : unavailable
        ? 'unavailable'
        : replay
          ? 'replay'
          : playing
            ? 'playing'
            : 'paused'}
  >
    {#if loading}
      <!-- Loading state: spinner-like indicator -->
      <span class="cinder-media-controls__icon" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="cinder-media-controls__svg cinder-media-controls__svg--loading"
        >
          <path d="M21 12a9 9 0 1 1-6.219-8.56" />
        </svg>
      </span>
      {#if !iconOnly}
        <span class="cinder-media-controls__label">Loading</span>
      {/if}
    {:else if unavailable}
      <!-- Unavailable state -->
      <span class="cinder-media-controls__icon" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="cinder-media-controls__svg"
        >
          <circle cx="12" cy="12" r="10" />
          <line x1="4.93" y1="4.93" x2="19.07" y2="19.07" />
        </svg>
      </span>
      {#if !iconOnly}
        <span class="cinder-media-controls__label">Unavailable</span>
      {/if}
    {:else if replay}
      <!-- Replay icon -->
      <span class="cinder-media-controls__icon" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="cinder-media-controls__svg"
        >
          <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </span>
      {#if !iconOnly}
        <span class="cinder-media-controls__label">Replay</span>
      {/if}
    {:else if playing}
      <!-- Pause icon -->
      <span class="cinder-media-controls__icon" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="cinder-media-controls__svg"
        >
          <rect x="6" y="4" width="4" height="16" rx="1" />
          <rect x="14" y="4" width="4" height="16" rx="1" />
        </svg>
      </span>
      {#if !iconOnly}
        <span class="cinder-media-controls__label">Pause</span>
      {/if}
    {:else}
      <!-- Play icon -->
      <span class="cinder-media-controls__icon" aria-hidden="true">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="currentColor"
          class="cinder-media-controls__svg"
        >
          <polygon points="5,3 19,12 5,21" />
        </svg>
      </span>
      {#if !iconOnly}
        <span class="cinder-media-controls__label">Play</span>
      {/if}
    {/if}
  </button>

  {#if hasProgress && onSeek}
    <input
      type="range"
      class="cinder-media-controls__seek"
      aria-label={progressLabel}
      aria-valuetext={progressText}
      aria-disabled={isDisabled ? 'true' : undefined}
      min="0"
      max="1"
      step={hasTime ? 'any' : '0.01'}
      value={clampedProgress}
      oninput={handleSeek}
      onkeydown={handleSeekKey}
    />
  {:else if hasProgress}
    <div
      class="cinder-media-controls__progress"
      role="progressbar"
      aria-label={progressLabel}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={progressPercent}
      aria-valuetext={progressText}
    >
      <div class="cinder-media-controls__progress-track">
        <div class="cinder-media-controls__progress-fill" style:width="{progressPercent}%"></div>
      </div>
    </div>
  {/if}

  {#if hasTime}
    <!-- The slider's value text already speaks the time, so the visible copy stays out of the
         accessibility tree rather than reading twice. -->
    <span class="cinder-media-controls__time" aria-hidden="true">
      <span class="cinder-media-controls__elapsed">{elapsedText}</span>
      <span class="cinder-media-controls__time-separator">/</span>
      <span class="cinder-media-controls__duration">{durationText}</span>
    </span>
  {/if}

  {#if onToggleMute && !unavailable}
    <button
      type="button"
      class="cinder-media-controls__action"
      aria-label="Mute"
      aria-pressed={muted ? 'true' : 'false'}
      aria-disabled={disabled ? 'true' : undefined}
      data-cinder-action="mute"
      onclick={handleToggleMute}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="cinder-media-controls__svg"
        aria-hidden="true"
      >
        <path d="M11 5 6 9H2v6h4l5 4V5z" fill="currentColor" />
        {#if muted}
          <line x1="22" y1="9" x2="16" y2="15" />
          <line x1="16" y1="9" x2="22" y2="15" />
        {:else}
          <path d="M15.5 8.5a5 5 0 0 1 0 7" />
          <path d="M19 5a10 10 0 0 1 0 14" />
        {/if}
      </svg>
    </button>
  {/if}

  {#if onToggleFullscreen && !unavailable}
    <button
      type="button"
      class="cinder-media-controls__action"
      aria-label="Full screen"
      aria-pressed={fullscreen ? 'true' : 'false'}
      aria-disabled={disabled ? 'true' : undefined}
      data-cinder-action="fullscreen"
      onclick={handleToggleFullscreen}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="cinder-media-controls__svg"
        aria-hidden="true"
      >
        {#if fullscreen}
          <path
            d="M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3"
          />
        {:else}
          <path
            d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"
          />
        {/if}
      </svg>
    </button>
  {/if}
</div>

<!-- Announce state changes to assistive technology via a polite live region. -->
<VisuallyHiddenLiveRegion message={announcement} />
