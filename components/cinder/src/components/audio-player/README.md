# AudioPlayer

Native audio element with its own controls for play, pause, replay, seeking, and elapsed and total time.

The controls are one flat row: the filled play button, the seek slider, then the elapsed and total time (`1:05 / 3:20`, or `1:02:05` from an hour up) once the length is known. The arrow keys move the slider five seconds and Page Up and Page Down a tenth of the track; Home and End go to the start and the end.

## Usage

```svelte
<script lang="ts">
  import { AudioPlayer } from '@lostgradient/cinder';
</script>

<AudioPlayer src="https://example.com/media/briefing.mp3" label="Daily briefing" />
```

## Guidance

### Use When

- Playing a single audio track from an https, http, or blob URL with accessible controls.

### Avoid When

- You need streaming protocols, caption authoring, or playlists — wire those separately.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `class` | `string` | no | — | Additional class names merged with `.cinder-audio-player`. |
| `label` | `string` | yes | — | Accessible name for the player. |
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
