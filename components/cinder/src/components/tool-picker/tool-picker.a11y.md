# ToolPicker design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved.
- Nearest neighbours: Modal, Checkbox, TransferList, Combobox.
- Why this component exists: Choosing the tools an agent can use needs a catalogue that is searchable, grouped by where each tool comes from, and honest about risk before a tool is added: the name, the identifier once, what it does, how risky it is and the level it starts at all have to be on the row. Skills are listed in the same place but cannot be chosen, so the list has to show them read-only. A Modal with a checkbox group has none of that, and a Combobox hides the facts a person needs to decide.
- Findings and resolutions: The dialog is a Modal with a counter on the title's line (the Modal's `headerTrailing`), not a bespoke overlay, so it keeps the focus trap, the scroll lock and the exit transition. Each row is a native checkbox named by the tool's human name, so the identifier and description describe it instead of lengthening its name.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: Yes—the picker enters the top layer through Modal, and in the long-list layout each group header is a new disclosure.
- Reviewer: Cinder maintainers
- Review outcome: Approved. Every control is a native checkbox or button in tab order; there is no custom arrow-key model to learn.

### Focus management

Modal traps focus inside the dialog. Focus starts on the dialog body, then Tab reaches the search field, each group's disclosure (long-list layout), each checkbox, Cancel and Done, and wraps. Closing returns focus to `triggerRef`. Clear search puts focus back in the search field.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab, Shift+Tab | Anywhere in the dialog | Moves between the search field, group disclosures, checkboxes and the two buttons, and stays inside the dialog. |
| Space | A focused checkbox | Chooses or clears the tool. |
| Enter, Space | A group header button | Opens or closes the group. |
| Enter, Space | Clear search, Cancel, Done | Activates the button. |
| Escape | Anywhere | Closes the picker without keeping its choices, as Cancel does. |
| Click or tap | A row's text | Chooses or clears the tool, as its checkbox does. |
| Click or tap | The scrim | Closes the picker without keeping its choices. |

### Assistive-technology announcements

The dialog is named by its title. The counter ("3 of 9 tools chosen") is a polite live region, so each choice is announced as it changes the count. A checkbox is named by the tool's human name and described by its description; the identifier, risk and starting level are read as part of the row's text. A tool with no risk word draws an em dash that is named "No risk word". A skill has no checkbox and reads "Follows its tools". Each group is a `role="group"` named by its header. The empty state reads as text in the list, and the loading placeholder is announced politely as "Loading tools and skills".

## Forced colors

Rows and group headers keep their borders, and the chosen state is carried by the checkbox itself, so nothing depends on a fill colour.

## Reduced motion

The skeleton placeholder does not animate under `prefers-reduced-motion: reduce`, and the dialog's own entrance follows Modal's reduced-motion rule.
