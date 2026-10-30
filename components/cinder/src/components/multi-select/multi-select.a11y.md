# MultiSelect · accessibility

## Pattern

MultiSelect uses an anchored picker surface with a listbox (`aria-multiselectable="true"`) and option rows that expose `aria-selected`.

## Roles, names, states

- Trigger is a native button with `aria-haspopup="listbox"`, `aria-expanded`, and `aria-controls`.
- Options are rendered as `role="option"` and expose `aria-selected` and `aria-disabled`.
- The listbox exposes `aria-multiselectable="true"` so assistive tech announces multi-selection behavior.
- `description`, `warning`, and `error` are composed into `aria-describedby`.
- `error` is referenced by the trigger through `aria-describedby` and sets `data-cinder-invalid` on the trigger.

## Keyboard

| Key                  | Behavior                                        |
| -------------------- | ----------------------------------------------- |
| Enter / Space        | Open the menu from the trigger.                 |
| ArrowDown / ArrowUp  | Open and move active option.                    |
| Home / End           | Jump to first/last enabled option.              |
| Enter / Space (list) | Toggle the active option (non-filterable mode). |
| Space (filter input) | Insert a literal space in the query.            |
| Escape               | Close the menu and return focus to the trigger. |

## Grouped items

Items with a `group` render inside a `role="group"` element whose `aria-labelledby` points at the group's heading text. The count shown in the heading is decorative (`aria-hidden`) and is not part of the group's name. Headings are not options and never become the active descendant. Ungrouped items sit directly in the listbox, before the groups. The DOM order, the option ids (`{id}-option-{index}`) and keyboard navigation all follow the same display order (ungrouped first, then groups by first appearance). A group whose items are all filtered out is removed along with its heading. With `selectionFeedback` set to `top` or `top-after-reopen`, selected items move to the top of their own group rather than across a heading.

## Empty result set (COR-499)

When the filtered/visible item set is empty, the listbox renders zero `role="option"` children — no fake disabled option row. The listbox instead carries `aria-describedby` pointing at a `role="status"` sibling (`.cinder-multi-select__empty`, outside the listbox subtree) that shows the "No matching options"/"No options" copy, mirroring CommandMenu's own empty-state pattern (`command-menu.svelte`'s `emptyStateId`/`showEmptyState`). Focus stays on the filter input (or the trigger, when not filterable); no `aria-activedescendant` is set while the list is empty; Arrow keys and Enter cannot select or emit a value change. Clearing the filter removes the status region and restores normal option rows and active-descendant navigation.

## Notes

- Disabled options remain visible but are not toggleable.
- Readonly mode keeps content perceivable but blocks selection changes.
- Required mode uses a hidden validity proxy so native form validation can enforce at least one selected value.
