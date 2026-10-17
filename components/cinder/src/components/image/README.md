# Image

Responsive image wrapper with aspect-ratio preservation, lazy loading, and fallback support.

## Usage

```svelte
<script lang="ts">
  import { Image } from '@lostgradient/cinder';
</script>

<Image
  src="https://picsum.photos/seed/cinder/600/338"
  alt="A randomly selected placeholder photograph"
  ratio="16/9"
  width={600}
  height={338}
/>
```

## Fit and size

`fit` (`contain`, `cover`, `fill`, `none`, `scale-down`) sets `object-fit`; omitted, the image covers its box. `size` (`icon`, `avatar`, `small`, `medium`, `large`, `header`) sets token-based dimensions: `icon` and `avatar` are squares, `small`, `medium`, and `large` set the width, and `header` spans its container at a banner height. Omitted, the image keeps its container-driven size.

```svelte
<Image src="/logo.png" alt="Logo" size="avatar" fit="contain" />
```

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `alt` | `string` | yes | — | Alternative text. Required with no default — pass `alt=""` explicitly for decorative images so the choice is intentional, not silent. |
| `class` | `string` | no | — | Additional class names merged with `.cinder-image`. |
| `decoding` | `"async"` \| `"sync"` \| `"auto"` | no | — | Decoding hint. Default `async`. |
| `fit` | `"contain"` \| `"cover"` \| `"fill"` \| `"none"` \| `"scale-down"` | no | — | How the image fills its box, mapped onto CSS `object-fit`. Omitted, the image covers the box (`cover`). |
| `height` | `number` | no | — | Native pixel height. |
| `loading` | `"lazy"` \| `"eager"` | no | — | Loading strategy. Default `lazy`. Override to `eager` for above-the-fold images. |
| `placeholder` | `string` | no | — | Low-resolution image source (typically a base64 data URI) shown as a pixelated background while the main image loads. Fades out once the `<img>` fires `load`. |
| `ratio` | `string` | no | — | CSS aspect-ratio applied to the wrapper (e.g. `'16 / 9'`) so layout is stable while the image loads. |
| `size` | `"icon"` \| `"avatar"` \| `"small"` \| `"medium"` \| `"large"` \| `"header"` | no | — | Token-based dimensions. `icon` and `avatar` are squares; `small`, `medium`, and `large` set the width and let `ratio` or the image's own proportions set the height; `header` spans the container at a banner height. Omitted, the image keeps its natural, container-driven size. |
| `src` | `string` | yes | — | Image source URL. |
| `width` | `number` | no | — | Native pixel width. |
| `fallback` | `(opaque)` | no | — | Rendered in place of the `<img>` when it fails to load. Not expressible in JSON Schema; see the component types for the signature. |
| `onError` | `(opaque)` | no | — | Forwarded after internal state updates. Not expressible in JSON Schema; see the component types for the signature. |
| `onLoad` | `(opaque)` | no | — | Forwarded after internal state updates. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

None.

<!-- generated:subcomponents:end -->
