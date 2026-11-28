# VideoPlayer accessibility

## Pattern

VideoPlayer renders a native `<video>` element without its built-in controls and drives it with its own playback controls. The player is a `group` named by `label`, and the seek slider is named "`label` position".

Purpose: Native video element with its own controls for play, pause, replay, seeking, elapsed and total time, mute, and full screen.

## Use when

- Playing a single video from an https, http, or blob URL with accessible controls.
- Showing a poster image until the viewer starts playback.

## Avoid when

- You need streaming protocols, caption authoring, or playlists — wire those separately.

## Keyboard and focus

The seek slider sits above the buttons and comes first in the tab order, followed by any markers in ascending time, the play, pause, and replay button, Back 5 seconds, the playback speed menu, Mute and Full screen, the `actions` snippet, and then the chapter buttons. The play button is a native button, so Enter and Space activate it. Once the duration is known, the seek control is a native range input: the arrow keys move the playback position five seconds, Page Up and Page Down a tenth of the video, and Home and End go to the start and the end. Every control shows Cinder's focus ring, and under a coarse pointer each reaches a 44px target without growing its face.

## Names, roles, and state

`label` is required and names the group and the media element. The slider's value text is the time, such as "1:05 of 3:20"; the visible elapsed and total time repeat it and stay out of the accessibility tree so it is not read twice. Mute and Full screen keep stable names and report their state through `aria-pressed`; mute follows the element's own `volumechange`, so a change made outside the controls still shows. Full screen takes the whole group, so the controls stay reachable, and its toggle is absent where `document.fullscreenEnabled` is false. The button keeps a stable name and reports playback through `aria-pressed`; loading and unavailable states keep the button in the tab order with `aria-disabled` so assistive technology still announces them. A `src` whose scheme is not `https:`, `http:`, or `blob:` is never loaded, and the controls show the unavailable state without markers, chapters, Back 5 seconds, or the speed menu. Provide captions or a transcript for spoken content; this component does not author captions.

## Markers

Each marker is a native button on the seek track, named by its `label` (such as "Comment 1 at 0:12") while it shows its short `badge`; the caller chooses both, so the numbering and wording match the page. A marker draws only once the length is known and only within it, and activating it moves the position to its `time`. Markers that sit close together overlap rather than move, so each keeps its true position; the later one paints on top, and the tab order still reaches every one in ascending time.

## Chapters

The chapters are a `group` named by `chaptersLabel` ("Chapters" by default) holding one native button per chapter. Each button's name is its start time and title, such as "0:12 Add card", and activating it moves the position to that start. No chapter is marked current, so no button carries `aria-current`. Without `chapters` the group is not rendered.

## Playback speed

The speed control is Cinder's `Dropdown`. Its trigger shows the rate ("1x") and is named "Playback speed, normal" at 1 and "Playback speed, {rate} times" otherwise, such as "Playback speed, 0.5 times". The menu lists one `menuitemradio` per rate in `playbackRates` (0.5x, 1x, 1.5x, and 2x by default), with the current rate checked through `aria-checked`; the menu's own keyboard, focus return, and dismissal apply.

## Back five seconds

"Back 5 seconds" is a native button after the play button that moves the position five seconds earlier, never before the start. It keeps `aria-disabled` while the player is loading, matching the play button.

## Verification

- Play, pause, seek, mute, and go full screen with the keyboard only.
- Tab from the seek slider through the markers in time order, then the buttons.
- Choose a playback speed from the menu with the keyboard and hear the trigger's new name.
- Confirm the unavailable state for a `data:` or `javascript:` source.
- Check focus visibility in light, dark, and forced-colors modes.

Related components: `audio-player`, `image`.
