# AudioPlayer accessibility

## Pattern

AudioPlayer renders a native `<audio>` element without its built-in controls and drives it with its own playback controls. The player is a `group` named by `label`, and the seek slider is named "`label` position".

Purpose: Native audio element with its own controls for play, pause, replay, seeking, and elapsed and total time.

## Use when

- Playing a single audio track from an https, http, or blob URL with accessible controls.

## Avoid when

- You need streaming protocols, caption authoring, or playlists — wire those separately.

## Keyboard and focus

The play, pause, and replay button is a native button, so Enter and Space activate it. Once the duration is known, the seek control is a native range input: the arrow keys move the playback position five seconds, Page Up and Page Down a tenth of the track, and Home and End go to the start and the end. Every control shows Cinder's focus ring.

## Names, roles, and state

`label` is required and names the group and the media element. The slider's value text is the time, such as "1:05 of 3:20"; the visible elapsed and total time repeat it and stay out of the accessibility tree so it is not read twice. The button keeps a stable name and reports playback through `aria-pressed`; loading and unavailable states keep the button in the tab order with `aria-disabled` so assistive technology still announces them. A `src` whose scheme is not `https:`, `http:`, or `blob:` is never loaded, and the controls show the unavailable state. Provide a transcript for spoken content.

## Verification

- Play, pause, and seek with the keyboard only.
- Confirm the unavailable state for a `data:` or `javascript:` source.
- Check focus visibility in light, dark, and forced-colors modes.

Related components: `video-player`.
