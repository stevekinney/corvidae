# ThemeSwitch accessibility

## Pattern

ThemeSwitch is the WAI-ARIA **radio group** pattern: a `<div role="radiogroup">` holding three `<button type="button" role="radio">` elements, one each for Light, System and Dark. Exactly one is `aria-checked="true"` at any time, because a theme preference always has a value. The radiogroup is named by `label` (default "Theme"), and each radio is named by its position.

Purpose: Three-position Light, System, Dark switch on a quiet sky and night track, for choosing a color theme.

## Keyboard and focus

| Key | Behavior |
| --- | --- |
| Tab | Moves focus into the group, onto the selected position. The other positions are `tabindex="-1"` (roving tabindex), so the group is one Tab stop. |
| Arrow Right, Arrow Down | Moves focus to the next position and selects it. Wraps from Dark to Light. |
| Arrow Left, Arrow Up | Moves focus to the previous position and selects it. Wraps from Light to Dark. |
| Home | Selects Light and moves focus to it. |
| End | Selects Dark and moves focus to it. |
| Space, Enter | Select the focused position, through the native button click. |

A `disabled` switch disables all three buttons and removes the group from the tab order.

## Names, roles, and state

The icons are decorative (`aria-hidden`); each position's accessible name comes from its `aria-label`, which is also its tooltip. The selected state is `aria-checked`, and the track color is never the only cue: the raised thumb marks the selected position, and in forced-colors mode it is drawn with `Highlight` so the selection still shows. The sky and night tracks keep their own lightness in light and dark themes, and the icons on them use fixed contrast ramps so they stay readable on either.

With a coarse pointer each position grows to a 44px target.

## Verification

- Tab to the switch and confirm focus lands on the selected position, then press the arrow keys, Home and End and confirm the selection and the focus ring move together.
- With a screen reader, confirm the group is announced as "Theme" and each position as a radio button with its checked state.
- Turn on forced colors and confirm the thumb and the selected icon are still distinguishable.

Related components: `toggle`, `segmented-control`.
