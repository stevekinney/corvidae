# ListDetail accessibility

## Pattern

ListDetail is two labelled regions, the list and the detail, with a separator between them when both show. The list region is named by the required `label`, and the detail region by `detailLabel`. Each row is a native `<li>` holding the row you render; with `SelectableRow` the primary action is a native button or link, so the browser supplies its role, Tab stop and activation.

Purpose: Resizable list-and-detail layout with a list header, keyboard selection, the open item kept in the URL, a remembered divider width, and a one-pane-at-a-time layout on narrow containers.

## Keyboard and focus

| Key | Behavior |
| --- | --- |
| Tab | Moves through the header controls, then each row's primary action and trailing controls, then the detail. |
| J | Moves the keyboard cursor and focus to the next row. Stops at the last row. |
| K | Moves the keyboard cursor and focus to the previous row. Stops at the first row. |
| Enter | Opens the row whose primary action has focus. |
| Arrow keys, Home, End | On the separator, resize the panes, as in `ResizablePanels`. |

`J` and `K` are single-letter shortcuts, so they never act while focus is in a text field, a menu, a listbox, a combobox or a dialog, or while Control, Meta or Alt is held. The list region declares them with `aria-keyshortcuts`. They are an addition to Tab, not a replacement: every row stays reachable with Tab and activates with Enter or Space.

Below `pushBelow` the list is replaced by the detail when a row opens, so focus moves to the Back button. Back returns to the list and moves focus to the row that was open, so a keyboard user does not start again from the top.

## Names, roles, and state

The open row carries `aria-current` when it uses `selectedState="current"`. Meaning never depends on color alone. Row actions are always visible and focusable; none is revealed only on hover.

## Verification

- Tab through the header, the rows and their menus, then the separator and the detail.
- Press `J`, `K` and `Enter` with focus on a row, and confirm they do nothing in the filter field.
- Narrow the container below `pushBelow`, open a row, press Back, and confirm focus returns to the row.
- Reload with the selection in the URL and confirm the same item is open.

Related components: `resizable-panels`, `data-list`, `selectable-row`, `empty-state`.
