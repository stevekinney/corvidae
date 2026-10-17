<script lang="ts" module>
  /**
   * @cinder
   * @category action
   * @status alpha
   * @purpose Native video element with Cinder media controls for play, pause, replay, and seeking.
   * @tag media
   * @tag video
   * @useWhen Playing a single video from an https, http, or blob URL with accessible controls.
   * @useWhen Showing a poster image until the viewer starts playback.
   * @avoidWhen You need streaming protocols, caption authoring, or playlists — wire those separately.
   * @avoidWhen You only need playback buttons for media you control elsewhere — use media-controls.
   * @related media-controls, audio-player, image
   */
  export type { VideoPlayerProps } from './video-player.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import { MediaPlayerState } from '../_internal/media-player-state.svelte.ts';
  import MediaControls from '../media-controls/media-controls.svelte';
  import type { VideoPlayerProps } from './video-player.types.ts';

  let { src, label, poster, class: customClassName, ...rest }: VideoPlayerProps = $props();

  const player = new MediaPlayerState(() => src);

  $effect(() => {
    void src;
    player.reset();
  });
</script>

<div
  {...rest}
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
  />
</div>
