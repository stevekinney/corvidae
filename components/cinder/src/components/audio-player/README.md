# AudioPlayer

Native audio element with Cinder media controls for play, pause, replay, and seeking.

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
- You only need playback buttons for media you control elsewhere — use media-controls.

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
