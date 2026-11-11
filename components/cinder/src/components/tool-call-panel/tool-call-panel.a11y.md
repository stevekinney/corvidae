# ToolCallPanel design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved against the agreed tool-call board (the rail's recommended side panel, the panel for each kind of call, below 1280px and at 375px).
- Nearest neighbours: Drawer, PayloadInspector, ApprovalCard.
- Why this component exists: Every kind of call opens the same panel: a name and state, Input and Result as fields, a failure's message first with the next steps, and a waiting call's note and decision. A Drawer is always an overlay and PayloadInspector shows one payload, so neither docks beside a conversation or knows what a failed call needs.
- Findings and resolutions: The panel docks as a plain aside from 1280px and is a Drawer below it, so the overlay and the phone sheet reuse the shared scrim, Esc, focus trap, grabber and reduced-motion cross-fade. Drawer gained `closeLabel` so a sheet closes with the word "Close".

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: Yes—the overlay and the sheet enter the top layer, and the docked panel is a region that opens and closes beside the page.
- Reviewer: Cinder maintainers
- Review outcome: Approved. The overlay and the sheet inherit Drawer's modal dialog behaviour; the docked panel is a labelled region with native buttons.

### Focus management

The overlay and the sheet are Drawers: opening moves focus into the panel, Tab stays inside it, and closing returns focus to `triggerRef` or to the element that had it. The docked panel does not move focus when it opens, because it is part of the page; the page decides, and calls `focusCall(id)` on the rail from `onClose` so Esc, the X or Close return focus to the row that opened the panel.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab, Shift+Tab | Anywhere in the panel | Moves between the close control, the retry button, the copy buttons, the note field, Deny and Approve. |
| Esc | Overlay or sheet | Closes the panel (Drawer). |
| Esc | Docked panel, focus inside | Closes the panel and reports `onClose`. |
| Enter, Space | Any button | Activates it. |

### Assistive-technology announcements

The docked panel is an `aside` named by the tool's heading. The overlay and the sheet are modal dialogs named by the same heading. The status dot and glyph are decorative; the state is in words ("Failed", "Waiting on you"). Each section is a region named by its heading ("Input", "Error", "Result"), and fields are a description list so a screen reader hears each label with its value. Copying announces "Copied" through the copy button's live region. A running call's spinner is decorative; the status says "Running". The X is named "Close panel" and the sheet's text button "Close".

## Verification

- Render each example in the playground and tab through the panel with the keyboard, in the docked, overlay and sheet forms.
- Check the heading, the sections and the buttons for names in the accessibility tree.
- Check forced-colors mode for the status dot and the Error block's border.
- Check the sheet at 375px under reduced motion: it cross-fades instead of sliding.
