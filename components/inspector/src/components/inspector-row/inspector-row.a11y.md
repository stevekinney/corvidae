# InspectorRow design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: SettingRow, DescriptionList, InlineConfirm.
- Why this component exists: A property of a record needs a quiet label and value that become an editor only when a person asks to change it, where a setting row always shows its control.
- Findings and resolutions: Editable and read-only rows are told apart by more than colour: an editable row draws a trailing chevron (a small switch for a toggle), a hover tint and a pointer, and a read-only row draws none of them. The label stays visible while the value is edited. A toggle commits on activation, because opening an editor to pick on or off would be a second step for a one-bit choice.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: Yes. Static-looking text becomes an inline editor on activation, and a custom editor opens in a popover.
- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

An editable row's value is a native button, so it is a tab stop. Activating it replaces the button with the editor and moves focus into the editor; a text value is selected. When the edit ends by commit or cancel, focus returns to the row's button. A custom editor opens in a Popover, which owns focus inside the panel and returns it to the button when it closes.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab / Shift+Tab | Rows | Moves between the buttons of editable rows. Read-only rows have no tab stop. |
| Enter / Space | Row button | Opens the editor; on a toggle row, switches it. |
| Enter | Text or date field | Commits the value and returns focus to the row. |
| Enter | Select | Commits the chosen option and returns focus to the row. |
| Escape | Inline editor | Cancels, discards the draft, and returns focus to the row. The inline editor joins the shared Escape stack, so Escape never also closes an enclosing dialog. |
| Escape | Popover editor | The popover closes, the edit is cancelled, and focus returns to the row. |
| Blur | Inline field | Commits the value, so a person who tabs away does not lose it. |

### Assistive-technology announcements

The row's button is named by its label and its value together ("Status Open"). A toggle row is a switch whose state is `aria-checked`. A row with a popover editor sets `aria-haspopup="dialog"` and `aria-expanded`. The inline editor and the popover are named "Edit" and the label, or `editLabel`. A read-only row is plain text in a description list, so it is announced as a term and its definition and offers no action.

## Verification

- Verify Enter commits and Escape cancels a text, date and select editor, and that focus returns to the row's button.
- Verify Escape inside an inline editor in a dialog cancels the edit and leaves the dialog open.
- Verify a toggle row announces its state and flips on Enter and Space.

## Forced colors

The focus ring is an inset outline in system colours, the switch draws a border and a Highlight fill when on, and the inset separator uses GrayText.
