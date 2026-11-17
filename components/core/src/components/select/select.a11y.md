# Select Accessibility

## Element Choice

By default this component uses a native `<select>` element rather than a custom listbox. The native element gives keyboard and pointer users correct operating-system-native behaviour for free and is announced correctly by every major screen reader without any custom ARIA.

Set `presentation="listbox"` when the choices need what a native `<select>` cannot draw: a sentence under an option, group headings with messages, the check on the current option, or a footer. The listbox presentation is described in its own section below; everything above and below that section is about the native element.

## Listbox presentation

The listbox presentation is the WAI-ARIA select-only combobox pattern. The trigger is a `<button type="button" role="combobox" aria-haspopup="listbox">` with `aria-expanded`, `aria-controls` (while open), and `aria-activedescendant` naming the option the cursor is on. Focus stays on the trigger for the whole interaction, so typing and arrow keys never leave the control. The label is a real `<label for>`, so the trigger is named by it; a visible `valuePrefix` is decorative (`aria-hidden`) and never part of the name.

The panel is a Popover that does not take focus. Inside it, a `role="listbox"` element owns the options (by `aria-owns`, because they are drawn beside it so that a group message can sit outside it), each a `role="option"` with `aria-selected` for the current value and `aria-disabled` for one that cannot be chosen. Its text (label, description, note) is the option's accessible name, so a reason such as "Plugin Demo is disabled" is read with the option. A check glyph marks the current option and is hidden from assistive technology (`aria-selected` carries the state). Option groups are `role="group"` lists named by their heading.

A group `message` and the `footer` are outside the options: they are plain content, never `role="option"`, so the arrow keys and typeahead skip them. A link in either is a keyboard stop of its own, after the last option: Tab from the trigger lands on the first such stop (the list stays open), Tab from the last stop closes the list and hands focus back to the trigger so the next Tab leaves the control, and Shift+Tab from the first stop returns to the trigger. When the list closes while focus is inside the panel, focus returns to the trigger.

| Key (list closed) | Behaviour |
| --- | --- |
| Enter / Space / Arrow Down or Up | Opens the list with the cursor on the current option. |
| A letter | Opens the list and moves the cursor to the next matching label. |

| Key (list open) | Behaviour |
| --- | --- |
| Arrow Down / Up | Moves the cursor, wrapping. A disabled option can hold the cursor so its reason can be read. |
| Home / End | First or last option. |
| Enter / Space | Chooses the option under the cursor and closes. A disabled option is refused. |
| A letter | Moves the cursor to the next option whose label starts with what was typed. |
| Escape | Closes without changing the value; focus stays on the trigger. |
| Tab | To the first panel stop (footer or message link) if there is one; otherwise closes and moves on. |

`readonly` shows the value and keeps the control focusable (`aria-readonly="true"`) but never opens it. On the native presentation it also blocks the picker. It is drawn as plain text, without a border or chevron, and keeps the focus ring. `required` sets `aria-required` on the listbox trigger; unlike a native `<select>`, a button takes no native constraint validation, so validate the value yourself and report it through `error`.

Below `sheetBelow` (640px by default) the panel docks to the bottom edge as a sheet, with focus still on the trigger.

## ARIA Roles and Attributes

- The `<select>` element carries the implicit `listbox` role; no explicit `role` attribute is needed.
- When `label` prop is provided, a `<label>` element is rendered with a `for` attribute matching the `<select>`'s `id`. This is the recommended accessible labelling technique — it gives the control its accessible name and expands the click target to include the label text.
- If no `label` prop is provided, the consumer is responsible for supplying an accessible name via `aria-label` or `aria-labelledby` on the `<select>` through a wrapper.
- When `description` or `error` is provided, the `<select>` carries `aria-describedby` pointing at the rendered helper paragraph(s). This wiring is produced by the shared `field-control.ts` contract used by all form-control components in this library.
- When `error` is set, `aria-invalid="true"` is added to the `<select>`. The attribute is omitted entirely (not set to `"false"`) when no error is present, which avoids some assistive technologies announcing "invalid" on every focus.

## Description and Error

The `description` and `error` props render small paragraphs below the `<select>` and are automatically wired into `aria-describedby` via `field-control.ts`:

- `description` → `<p id="{id}-description">` → referenced by `aria-describedby`.
- `error` → `<p id="{id}-error" aria-live="polite">` → referenced by `aria-describedby` and causes `aria-invalid="true"` on the `<select>`. The `aria-live="polite"` region ensures screen readers announce validation feedback when it appears without stealing focus from the control.

When both are present, `aria-describedby` lists the description id first and the error id second, matching the visual top-to-bottom reading order.

Consumer-supplied `aria-describedby` is composed, not replaced. Any id passed directly through the prop spread is appended after the component-generated ids, so external hints such as a tooltip id continue to work.

## Required

The `required` prop maps directly to the native HTML `required` attribute on `<select>`. This is the WAI-ARIA–recommended technique for native form controls: the browser handles the built-in constraint validation and announces the field as required consistently across assistive technologies. `aria-required` is intentionally not used alongside native `required`.

The visible label should also indicate required-ness textually (e.g., with the required dot and a legend) so the requirement is communicated to users who cannot perceive the field's validation state until submission.

## Keyboard Interactions

| Key             | Behaviour                                                          |
| --------------- | ------------------------------------------------------------------ |
| Tab / Shift+Tab | Moves focus to and from the select control.                        |
| Space / Enter   | Opens the native OS dropdown when the select has focus.            |
| Arrow Up / Down | Moves between options while the dropdown is open (OS-native).      |
| Escape          | Collapses the dropdown without changing the selection (OS-native). |

All keyboard interactions are handled natively by the browser and operating system — no custom key-down handlers are required or added.

## Disabled State

The `disabled` prop maps directly to the native `disabled` HTML attribute on `<select>`. This causes the element to be skipped during Tab navigation and announced as "dimmed" or "unavailable" by screen readers. `aria-disabled` is intentionally not used because native `disabled` provides stronger guarantees: the browser prevents value changes even from JavaScript, while `aria-disabled` only communicates state to assistive technology.

Individual options may also be disabled via the `disabled` field on a `SelectOption` object. A disabled option is still announced by screen readers but cannot be selected.

## Empty Options Guard

When `options` is an empty array the component renders a `<select data-cinder-empty="true">` with no children and fires `console.warn('Select: options is empty')`. The `data-cinder-empty` attribute provides a hook for test assertions and CSS rules. A select with no options is functionally useless and should be treated as a developer error. The ARIA wiring (`aria-invalid`, `aria-describedby`) is still applied to the empty `<select>` so a consumer who combines an empty options array with an error message (e.g., a "loading failed" UI) gets correct ARIA.

## Focus Visibility

The `.cinder-select` element relies on the browser's native `:focus-visible` outline to keep focus visible for keyboard users. The CSS layer enhances this with a custom focus ring using `box-shadow` so the ring respects the token-defined offset and colour. A `@media (forced-colors: active)` block restores an `outline`-based ring for Windows High Contrast Mode where `box-shadow` is ignored.

## Color and Contrast

All colour values in `select.css` reference design tokens (`--cinder-*`). Token values must meet WCAG 2.1 AA contrast ratios: at least 4.5:1 for normal text and 3:1 for large text and UI components. The border-to-background contrast of the select control must meet the 3:1 non-text contrast requirement (WCAG 1.4.11).

When in an invalid state, the `border-color` switches to `--cinder-status-danger-solid`. The error `<p>` text remains visible via the `CanvasText` system color in forced-colors mode; the danger border is replaced by the system border color anyway, so no additional forced-colors block is needed for the invalid border.
