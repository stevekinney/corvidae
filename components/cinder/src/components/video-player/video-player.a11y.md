# VideoPlayer · accessibility

## Pattern

VideoPlayer renders a native `<video>` element without its built-in controls and drives it with Cinder's `MediaControls`. The player is a `group` named by `label`, and the seek slider is named "`label` position".

Purpose: Native video element with Cinder media controls for play, pause, replay, and seeking.

## Use when

- Playing a single video from an https, http, or blob URL with accessible controls.
- Showing a poster image until the viewer starts playback.

## Avoid when

- You need streaming protocols, caption authoring, or playlists — wire those separately.
- You only need playback buttons for media you control elsewhere — use media-controls.

## Keyboard and focus

The play, pause, and replay button is a native button, so Enter and Space activate it. Once the duration is known, the seek control is a native range input: the arrow, Home, End, and Page keys move the playback position. Focus indicators come from `MediaControls`.

## Names, roles, and state

`label` is required and names the group and the media element. The button keeps a stable name and reports playback through `aria-pressed`; loading and unavailable states keep the button in the tab order with `aria-disabled` so assistive technology still announces them. A `src` whose scheme is not `https:`, `http:`, or `blob:` is never loaded, and the controls show the unavailable state. Provide captions or a transcript for spoken content; this component does not author captions.

## Verification

- Play, pause, and seek with the keyboard only.
- Confirm the unavailable state for a `data:` or `javascript:` source.
- Check focus visibility in light, dark, and forced-colors modes.

Related components: `media-controls`, `audio-player`, `image`.
