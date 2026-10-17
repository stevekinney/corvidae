# VideoPlayer

Native video element with Cinder media controls for play, pause, replay, and seeking.

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
- You only need playback buttons for media you control elsewhere — use media-controls.

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
