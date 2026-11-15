<script lang="ts" module>
  /**
   * @cinder
   * @category action
   * @status alpha
   * @purpose Native video element with its own controls for play, pause, replay, seeking, elapsed and total time, mute, and full screen.
   * @tag media
   * @tag video
   * @useWhen Playing a single video from an https, http, or blob URL with accessible controls.
   * @useWhen Showing a poster image until the viewer starts playback.
   * @avoidWhen You need streaming protocols, caption authoring, or playlists — wire those separately.
   * @related audio-player, image
   */
  export type { VideoPlayerProps } from './video-player.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import { MediaPlayerState } from '../_internal/media-player-state.svelte.ts';
  import MediaControls from '../_internal/media-controls.svelte';
  import type { VideoPlayerProps } from './video-player.types.ts';

  let { src, label, poster, class: customClassName, ...rest }: VideoPlayerProps = $props();

  const player = new MediaPlayerState(() => src);

  $effect(() => {
    void src;
    player.reset();
  });

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
    elapsed={player.currentTime}
    duration={player.duration}
    muted={player.muted}
    onToggleMute={player.toggleMute}
    {fullscreen}
    onToggleFullscreen={fullscreenSupported ? toggleFullscreen : undefined}
  />
</div>
