# VideoPlayer

Native video element with its own controls for play, pause, replay, seeking, elapsed and total time, mute, and full screen.

The seek slider runs the full width under the video, and the buttons wrap in a row beneath it: the filled play button, Back 5 seconds, the elapsed and total time (`1:05 / 3:20`, or `1:02:05` from an hour up) once the length is known, the playback speed menu, then the mute and full-screen toggles, with the `actions` snippet at the inline end. `markers` draw numbered buttons on the seek track, `chapters` list the sections under the controls, and `currentTime` binds the position in seconds, so a page can read it and seek by writing it. The arrow keys move the slider five seconds and Page Up and Page Down a tenth of the video; Home and End go to the start and the end. Full screen takes the whole player, controls included, and its toggle shows only where the document may go full screen. The player shows no captions yet: pair spoken video with a transcript.

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
| `chapters` | { time: `number`; title: `string` }[] | no | — | Sections listed as buttons under the controls, each named by its start time and title. |
| `chaptersLabel` | `string` | no | `"Chapters"` | Accessible name of the chapter group. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-video-player`. |
| `currentTime` | `number` | no | `0` | Playback position in seconds; bindable. Writing it seeks, clamped to the length, and a value written before the length is known is applied once it is. |
| `label` | `string` | yes | — | Accessible name for the player. |
| `markers` | { badge: `string`; label: `string`; time: `number` }[] | no | — | Moments drawn as buttons on the seek track once the length is known. Each seeks to its `time`; close markers overlap, and the tab order reaches them in ascending `time`. |
| `playbackRates` | `number`[] | no | `[0.5,1,1.5,2]` | Rates the playback speed menu offers. |
| `poster` | `string` | no | — | Image shown before playback starts. |
| `src` | `string` | yes | — | Media source. Only `https:`, `http:`, and `blob:` URLs load; any other scheme renders the unavailable state. |
| `actions` | `(opaque)` | no | — | Content drawn last in the controls row, given the current position. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
