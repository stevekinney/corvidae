# Combobox · accessibility

## Pattern

[WAI-ARIA Authoring Practices: Combobox](https://www.w3.org/WAI/ARIA/apg/patterns/combobox/) — single-select, "list autocomplete with manual selection" variant. The input drives both filtering and the open/close state of the listbox.

## Roles, names, states

- The text input carries `role="combobox"`, `aria-autocomplete="list"`, `aria-expanded`, and `aria-activedescendant` (pointing at the visually-active option, if any). `aria-controls` is only present while the listbox is mounted, so it never references a popup element that is absent from the DOM.
- The listbox carries `role="listbox"`. Each option is a `<li>` with `role="option"`, `aria-selected` reflecting whether it matches the current value, and `aria-disabled` when the option is non-selectable.
- The visible label rendered by the `label` prop sits in a `<label for={id}>`. Consumers without a visible label should pass the first-class `aria-label` prop.
- `description` and `error` are wired via the shared `field-control.ts` contract: the input carries `aria-describedby` pointing at the rendered helper paragraph(s), and `aria-invalid="true"` when `error` is set.

## Keyboard

| Key       | Behavior                                                            |
| --------- | ------------------------------------------------------------------- |
| ArrowDown | Open the listbox (if closed); move active option to next; wraps     |
| ArrowUp   | Open the listbox (if closed); move active option to previous; wraps |
| Home      | Move active option to first (when listbox is open)                  |
| End       | Move active option to last (when listbox is open)                   |
| Enter     | Select the active option (when listbox is open)                     |
| Escape    | Close the listbox without selecting                                 |
| Type      | Filter the option list and reset active to first match              |

Disabled options are part of the arrow-key order: ArrowUp, ArrowDown, Home and End stop on them, so a keyboard user can scroll the whole list and read why a row is disabled, as the WAI-ARIA listbox pattern expects. Enter on a disabled option selects nothing and leaves the list open. Hovering a disabled option does not move the active option. Typing starts the active option on the first _enabled_ match.

The listbox is the scrolling surface: the element with `role="listbox"` that the input's `aria-controls` names caps its height and scrolls, so axe's `scrollable-region-focusable` rule treats it as a combobox popup. The scroller is not a tab stop, because focus stays on the input.

The active option is **visually highlighted but not focused** — focus stays on the input throughout. Mouse hover updates the active index for keyboard parity.

## Mouse / pointer

Options select on `mousedown` rather than `click` so the selection completes before the input's `blur` handler closes the listbox. Mouse hover updates the active index but does not select.

## Rich option content

Options can carry optional `description` and `avatar` fields to render richer rows.

**Accessible name composition.** When an option has a `description`, the `<li role="option">` carries an explicit `aria-label` composed as `"${label}, ${description}"`. This guarantees screen readers announce both lines regardless of how the assistive technology handles `aria-activedescendant` text composition from multi-element children. Options without a description omit `aria-label` so the accessible name derives from the visible label text — no behavior change for plain options.

**Avatar is decorative.** The avatar `<img>` carries `alt=""` explicitly. The image conveys no information beyond what the label already provides, so empty alt is correct per WAI's decorative-image guidance. Consumers needing a meaningful avatar description should pre-format that text into the `label` or `description` field.

**Broken avatar URLs.** The component does not intercept broken image URLs. A bad `src` renders the browser's default broken-image indicator. Consumers are responsible for supplying valid URLs. Whitespace-only avatar strings are treated the same as a missing avatar — no `<img>` element is rendered.

**Default filter matches description.** Typing a substring that appears in an option's `description` (case-insensitive) keeps that option visible, matching the visual affordance. Consumers who want label-only matching pass a custom `filter` prop.

**Selection from a rich option.** Selecting a rich option sets `value` to `option.value` and `textInputValue` to `option.label` — the description is not appended to the text input.

## Grouped options

Options with a `group` render inside a `role="group"` element whose `aria-labelledby` points at the group's heading text, so a screen reader announces the group as it enters it. The visible option count in the heading is decorative (`aria-hidden`) and is not part of the group's name. The headings are not options: they are not focusable, never become the active descendant, and `aria-activedescendant` still walks only `role="option"` elements. Ungrouped options sit directly in the listbox. The DOM order, the option ids (`{id}-option-{index}`) and keyboard navigation all follow the same display order (ungrouped first, then groups by first appearance), so Home, End and the arrow keys never skip or reorder across a group boundary. A group whose options are all filtered out is removed along with its heading.

## Empty result set (COR-499)

When `filteredOptions` is empty, the open listbox renders zero `role="option"` elements — no fake disabled option. The single visible "No results" line renders as plain, roleless text in the panel beside the (hidden, empty) listbox the input controls, never inside it (the text is `noMatchLabel`, "No results" by default); the one status description that names the empty state for assistive technology lives outside the listbox (`.cinder-combobox__empty-status`, `role="status"`) and is referenced from the text field's own `aria-describedby`, the same describedby-based association CommandMenu uses from its `role="listbox"` element (`command-menu.svelte`'s `emptyStateId`). Focus stays on the text field throughout; `aria-activedescendant` is absent; Arrow keys and Enter cannot select or emit a value change while empty. Clearing the filter removes the empty description and restores normal option rows, active-descendant navigation, and selection.

## Panel structure

The panel is a Popover with `role="group"`, named by the field's label. Inside it, in order: the picker's search field, the load error, the `role="listbox"` element (the one `aria-controls` names, and the scroller), the empty message, and the `footer`. Only options live inside the listbox, so the search field, the retry button and footer links are never children of a `role="listbox"`. The empty message and the footer are plain content; the arrow keys and Enter never reach them.

The retry button and any link or button in the `footer` are keyboard stops of their own after the options: Tab from the field lands on the first one and the list stays open; Tab from the last closes the list and hands focus back to the field so the next Tab leaves the control; Shift+Tab from the first returns to the field. When the list closes while focus is inside the panel, focus returns to the field.

## Picker presentation

The closed field is a `<button role="combobox" aria-haspopup="listbox">` labelled by the field's `<label for>`, with `aria-expanded` and (while open) `aria-controls`. Enter, Space, ArrowDown and ArrowUp open it. Opening moves focus into the panel's search field, which is itself a `role="combobox"` with `aria-autocomplete="list"`, `aria-controls` and `aria-activedescendant` naming the option under the cursor; focus stays there while the arrow keys move the cursor, Enter chooses, Escape closes without changing the value, and the value's label in the closed field is never edited by searching. Choosing an option closes the panel and returns focus to the button. The "N of M" count is a polite status.

## Loading and load error

While `loading`, the field is `aria-busy`, shows the loading label as its placeholder (input) or button text (picker), and does not open. The input is read-only, not disabled, so it stays in the tab order and keeps its label. Skeleton's status line below it is a `role="status"` region. A `loadError` is a `role="alert"` message at the top of the panel, so it is announced when the list opens.

## Hard scope caps (v1)

These are deliberate non-goals for the first version. Consumers who need them should compose their own combobox or open an issue tracking demand.

- **Single-select only.** No multi-select, no token chips.
- **Synchronous local filtering only.** Pass `filter` for custom logic, but don't expect debounced fetches. A consumer that loads its options draws the wait with `loading` and a failure with `loadError`.
- **No virtualization.** Visible option count is capped at `maxVisibleOptions` (default 200). Larger lists should be paginated or pre-filtered.
- **Custom values are opt-in.** With `customValueAllowed`, typed text can be committed with Enter or on blur; when the text exactly matches an existing option label or value, the component still commits that option's canonical value instead of treating it as arbitrary text.
- **No custom option renderer.** Rich rows support `description`, `avatar`, `code` and `meta` (or the `optionMeta` snippet) out of the box. Consumers needing a different layout should open a feature request; a snippet-based renderer is a candidate for a future iteration.
