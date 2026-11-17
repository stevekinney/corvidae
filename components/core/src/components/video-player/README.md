# VideoPlayer

Native video element with its own controls for play, pause, replay, seeking, elapsed and total time, mute, and full screen.

The controls are one flat row under the video: the filled play button, the seek slider, the elapsed and total time (`1:05 / 3:20`, or `1:02:05` from an hour up) once the length is known, then the mute and full-screen toggles at the inline end. The arrow keys move the slider five seconds and Page Up and Page Down a tenth of the video; Home and End go to the start and the end. Full screen takes the whole player, controls included, and its toggle shows only where the document may go full screen. The player shows no captions yet: pair spoken video with a transcript.

## Usage

```svelte
<script lang="ts">
  import { VideoPlayer } from '@lostgradient/cinder';
</script>

<VideoPlayer
  src="https://example.com/media/intro.mp4"
  label="Product introduction"
  poster="https://example.com/media/intro.jpg"
/>
```

## Guidance

### Use When

- Playing a single video from an https, http, or blob URL with accessible controls.
- Showing a poster image until the viewer starts playback.

### Avoid When

- You need streaming protocols, caption authoring, or playlists — wire those separately.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-video-player`. |
| `label` | `string` | yes | — | Accessible name for the player. |
| `poster` | `string` | no | — | Image shown before playback starts. |
| `src` | `string` | yes | — | Media source. Only `https:`, `http:`, and `blob:` URLs load; any other scheme renders the unavailable state. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
