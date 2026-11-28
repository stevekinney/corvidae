<script lang="ts" module>
  export type {
    VideoPlayerActionsContext,
    VideoPlayerChapter,
    VideoPlayerMarker,
    VideoPlayerProps,
  } from './video-player.types.ts';
</script>

<script lang="ts">
  import { untrack } from 'svelte';

  import { classNames } from '../../utilities/class-names.ts';
  import { MediaPlayerState } from '../_internal/media-player-state.svelte.ts';
  import MediaControls from '../_internal/media-controls.svelte';
  import { formatMediaTime } from '../_internal/media-time.ts';
  import { Dropdown } from '../dropdown/index.ts';
  import type { VideoPlayerProps } from './video-player.types.ts';

  const DEFAULT_PLAYBACK_RATES = [0.5, 1, 1.5, 2];
  const BACK_SECONDS = 5;

  let {
    src,
    label,
    poster,
    markers,
    chapters,
    chaptersLabel = 'Chapters',
    playbackRates = DEFAULT_PLAYBACK_RATES,
    currentTime = $bindable(0),
    actions,
    class: customClassName,
    ...rest
  }: VideoPlayerProps = $props();

  const generatedId = $props.id();

  // The element reports its position through `onTimeChange`, which writes the bound prop; the
  // effect below seeks only when the prop differs from the element's own position, so a reported
  // position never seeks back.
  const player = new MediaPlayerState(
    () => src,
    (seconds) => {
      currentTime = seconds;
    },
  );

  $effect(() => {
    void src;
    player.reset();
  });

  // Declared after the reset so a source and a position given together seek the new source.
  $effect(() => {
    const requested = currentTime;
    untrack(() => {
      if (requested !== player.currentTime) player.seekTo(requested);
    });
  });

  const hasDuration = $derived(Number.isFinite(player.duration) && player.duration > 0);

  // Markers draw only once the length is known, and only those inside it, in ascending time so
  // the tab order runs along the track and a later marker paints over an earlier one it overlaps.
  const visibleMarkers = $derived(
    hasDuration && !player.unavailable && markers !== undefined
      ? markers
          .filter((marker) => Number.isFinite(marker.time) && marker.time >= 0)
          .filter((marker) => marker.time <= player.duration)
          .toSorted((first, second) => first.time - second.time)
      : [],
  );

  const markerPosition = (time: number): string => `${(time / player.duration) * 100}%`;

  let playbackRate = $state(1);

  const rateText = (rate: number): string => `${rate}x`;
  const speedLabel = $derived(
    `Playback speed, ${playbackRate === 1 ? 'normal' : `${playbackRate} times`}`,
  );

  function choosePlaybackRate(rate: number): void {
    playbackRate = rate;
    if (player.element === null) return;
    // A new source resets `playbackRate` to `defaultPlaybackRate`, so both carry the choice.
    player.element.defaultPlaybackRate = rate;
    player.element.playbackRate = rate;
  }

  function back(): void {
    player.seekTo(Math.max(0, player.currentTime - BACK_SECONDS));
  }

  // Full screen takes the whole player, controls included: the video has no native controls, so
  // full-screening the element alone would strand the viewer with no way to pause or leave.
  let root = $state<HTMLDivElement | null>(null);
  let fullscreenSupported = $state(false);
  let fullscreen = $state(false);

  $effect(() => {
    fullscreenSupported = document.fullscreenEnabled === true;
    const sync = () => {
      fullscreen = root !== null && document.fullscreenElement === root;
    };
    sync();
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  });

  function toggleFullscreen(): void {
    if (root === null) return;
    // Both calls reject when the browser refuses (no user activation, a policy); the
    // fullscreenchange event carries any change that did happen.
    if (document.fullscreenElement === root) {
      void document.exitFullscreen().catch(() => {});
    } else {
      void root.requestFullscreen().catch(() => {});
    }
  }
</script>

{#snippet markerButtons()}
  {#if visibleMarkers.length > 0}
    <div class="cinder-video-player__markers">
      {#each visibleMarkers as marker, index (index)}
        <button
          type="button"
          class="cinder-video-player__marker"
          aria-label={marker.label}
          style:--_cinder-video-player-marker-position={markerPosition(marker.time)}
          onclick={() => player.seekTo(marker.time)}
        >
          {marker.badge}
        </button>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet speedMenu()}
  {#if !player.unavailable}
    <Dropdown id={`${generatedId}-speed`} placement="top-end" class="cinder-video-player__speed">
      <Dropdown.Trigger variant="ghost" size="sm" caretVisible={false} aria-label={speedLabel}>
        {rateText(playbackRate)}
      </Dropdown.Trigger>
      <Dropdown.Menu>
        {#each playbackRates as rate (rate)}
          <Dropdown.Item
            itemRole="menuitemradio"
            checked={rate === playbackRate}
            onclick={() => choosePlaybackRate(rate)}
          >
            {rateText(rate)}
          </Dropdown.Item>
        {/each}
      </Dropdown.Menu>
    </Dropdown>
  {/if}
{/snippet}

{#snippet trailingActions()}
  {#if actions}{@render actions({ currentTime: player.currentTime })}{/if}
{/snippet}

<div
  {...rest}
  bind:this={root}
  role="group"
  aria-label={label}
  class={classNames('cinder-video-player', customClassName)}
  data-cinder-unavailable={player.unavailable ? '' : undefined}
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <video
    bind:this={player.element}
    class="cinder-video-player__media"
    src={player.playable ? src : undefined}
    {poster}
    preload="metadata"
    playsinline
    aria-label={label}
    {...player.handlers}
  ></video>
  <MediaControls
    class="cinder-video-player__controls"
    layout="expanded"
    seekAbove
    playing={player.playing}
    replay={player.ended}
    loading={player.waiting}
    unavailable={player.unavailable}
    progress={player.progress}
    progressLabel="{label} position"
    onPlay={player.play}
    onPause={player.pause}
    onReplay={player.replay}
    onSeek={player.seek}
    onBack={back}
    elapsed={player.currentTime}
    duration={player.duration}
    muted={player.muted}
    onToggleMute={player.toggleMute}
    {fullscreen}
    onToggleFullscreen={fullscreenSupported ? toggleFullscreen : undefined}
    seekOverlay={markerButtons}
    secondary={speedMenu}
    trailing={actions ? trailingActions : undefined}
  />
  {#if chapters !== undefined && chapters.length > 0 && !player.unavailable}
    <div class="cinder-video-player__chapters" role="group" aria-label={chaptersLabel}>
      {#each chapters as chapter, index (index)}
        <button
          type="button"
          class="cinder-video-player__chapter"
          onclick={() => player.seekTo(chapter.time)}
        >
          <span class="cinder-video-player__chapter-time">{formatMediaTime(chapter.time)}</span>
          {' '}
          <span class="cinder-video-player__chapter-title">{chapter.title}</span>
        </button>
      {/each}
    </div>
  {/if}
</div>
