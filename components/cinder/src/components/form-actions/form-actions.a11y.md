# FormActions design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved.
- Nearest neighbours: DockedActionBar, Drawer footer, Alert, Button group.
- Why this component exists: Three pages hand-built the bar at the end of their form, each with a different divider, summary position and failed-save message, and one of them lost its Save. The bar belongs to a form, so it carries the unsaved-change count, the effect of saving and the failed-save alert that a docked page bar does not.
- Findings and resolutions: The sticky mode reuses the docked bar's keyboard-inset and height publishing instead of a second mechanism. The failed-save message is the existing danger Alert, so it keeps its assertive announcement.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the bar adds no keyboard pattern and no top layer; it is a named group of ordinary buttons with a status line.
- Reviewer: Not applicable.
- Review outcome: No novel interaction review required.

### Focus management

Focus is never moved by the bar. The form that contains it moves focus to the first field with a problem when Save is pressed, and Save is never disabled by validation.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab | Any control in the bar | Moves through the bar's controls in DOM order, summary first, buttons last. |
| Enter, Space | A button | Activates it; the submit button submits the form. |

### Assistive-technology announcements

The bar is a `group` named by `label`. The summary is a status region that is always mounted, so an unsaved-change count that appears or changes is announced politely. A failed save is a danger Alert, an assertive live region, so it is announced when it appears.

## Forced colors

The top divider repaints with `CanvasText`.
