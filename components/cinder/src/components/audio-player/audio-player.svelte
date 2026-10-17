<script lang="ts" module>
  /**
   * @cinder
   * @category action
   * @status alpha
   * @purpose Native audio element with Cinder media controls for play, pause, replay, and seeking.
   * @tag media
   * @tag audio
   * @useWhen Playing a single audio track from an https, http, or blob URL with accessible controls.
   * @avoidWhen You need streaming protocols, caption authoring, or playlists — wire those separately.
   * @avoidWhen You only need playback buttons for media you control elsewhere — use media-controls.
   * @related media-controls, video-player
   */
  export type { AudioPlayerProps } from './audio-player.types.ts';
</script>

<script lang="ts">
  import { classNames } from '../../utilities/class-names.ts';
  import { MediaPlayerState } from '../_internal/media-player-state.svelte.ts';
  import MediaControls from '../media-controls/media-controls.svelte';
  import type { AudioPlayerProps } from './audio-player.types.ts';

  let { src, label, class: customClassName, ...rest }: AudioPlayerProps = $props();

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
  class={classNames('cinder-audio-player', customClassName)}
  data-cinder-unavailable={player.unavailable ? '' : undefined}
>
  <audio
    bind:this={player.element}
    class="cinder-audio-player__media"
    src={player.playable ? src : undefined}
    preload="metadata"
    aria-label={label}
    {...player.handlers}
  ></audio>
  <MediaControls
    class="cinder-audio-player__controls"
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
