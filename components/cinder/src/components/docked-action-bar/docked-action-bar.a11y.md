# DockedActionBar design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved.
- Nearest neighbours: Drawer footer, Banner, StaleRegion, Toolbar.
- Why this component exists: A live page has actions that must stay in reach while its content scrolls, must clear the safe area and the on-screen keyboard, and must go off together for one stated reason. A sticky element written per page gets the keyboard and safe-area handling wrong in a different way each time, and a toast cannot sit above it without knowing its height.
- Findings and resolutions: The bar is sticky rather than fixed, so it never covers content and respects the scrolling container's width. It reuses the stale-region context for its off state instead of a second inert mechanism, and it overrides the shared control-height tokens for touch instead of reaching into Button or Input.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the bar adds no keyboard pattern and no top layer; it is a group of ordinary controls whose off state reuses the `aria-disabled`, still-focusable pattern of `StaleRegion`.
- Reviewer: Not applicable.
- Review outcome: No novel interaction review required.

### Focus management

Focus is never moved. An off control stays in the tab order, so a keyboard or screen-reader user can still land on it and hear the reason. Focusing a field in the bar on a phone raises the keyboard; the bar rides above it through `--_cinder-keyboard-inset`, so the field and its buttons stay visible.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab | Any control in the bar | Moves through the bar's controls in DOM order; off controls stay reachable. |
| Enter, Space | Off button | Does nothing. |
| Any | Controls that did not opt in with `mutating` | Unchanged. |

### Assistive-technology announcements

The bar is a `group` named by `label` ("Run actions", "Decision"). Its reason lives in a status region that is always mounted, so a reason that appears is announced politely, and every off control lists it in `aria-describedby`. Off controls announce as unavailable (`aria-disabled="true"`).

## Forced colors

The bar's border repaints with `CanvasText` and its shadow is dropped.
