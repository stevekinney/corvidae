# ToolCallRail design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved against the agreed tool-call board (step rail with the side panel).
- Nearest neighbours: Timeline, RunStepTimeline, Collapsible, StackedListItem.
- Why this component exists: A turn can make thirty tool calls. Chat and the run pages need the same rail: one line per call, the first and last few visible, the middle folded behind one control that says what it hides, and the calls that failed or need a person never folded away. Timeline leads with a timestamp that a tool call does not have, and RunStepTimeline draws a heavier row per step, so neither fits a dense, one-line, selectable row.
- Findings and resolutions: The rail draws Timeline's marker column and connector rather than reusing its items. Failures carry one danger-text line with quiet links instead of a filled block, and a denied call is neutral so it is never read as a failure.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: Yes—the summary line is a disclosure, folded groups open in place, and rows become toggle buttons that open a panel.
- Reviewer: Cinder maintainers
- Review outcome: Approved. Every control is a native button in tab order.

### Focus management

Opening a group keeps focus on the control that opened it; the rows it reveals follow it in order. Selecting a row does not move focus: the page that docks the panel decides where focus goes, and `focusCall(id)` returns it to the row when the panel closes. The selected row keeps the visible focus ring after focus has moved away, so the person can see which call the panel belongs to.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab, Shift+Tab | Anywhere in the rail | Moves between the summary button, the rows, the group buttons, the failure links and `Show fewer`. |
| Enter, Space | Summary button | Opens or closes the rail (`aria-expanded`). |
| Enter, Space | Row | Selects the call (`aria-pressed`). |
| Enter, Space | `Show N more`, `Show fewer`, a failure link | Activates the control. |

### Names, roles and state

The rail is a labelled region (`label`, default "Tool calls") around an ordered list, so the number of rows is announced. Status glyphs and dots are decorative and hidden from assistive technology; the state is in words: a failed call's row begins with a visually hidden "Failed", an approved call with "Approved", and `Running…`, `Waiting on you` and the denial words are visible text. The running spinner is decorative; the summary says `so far…`. The tooltip carrying the identifier is a `title`, so the name never relies on it.

## Verification

- Render the long turn in the playground and tab through it with the keyboard.
- Check the summary button, rows and group buttons for names and state in the accessibility tree.
- Check forced-colors mode for the connector, the dots and the selected row.
