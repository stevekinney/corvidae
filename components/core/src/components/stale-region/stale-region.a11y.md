# StaleRegion design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Final review complete—approved.
- Nearest neighbours: Banner, Button (`loading`), Form field `disabled`.
- Why this component exists: A page that cannot reach its server keeps the data it has, so the controls that change something have to turn off together, for one reason, without dimming the data. Native `disabled` removes a control from the tab order and says nothing about why; `opacity` on a wrapper drops the data below 4.5:1. The region publishes one fact (the data is old) and one reason, and each opted-in control turns itself `aria-disabled`, keeps focus and points at the reason.
- Findings and resolutions: Controls opt in with `mutating` rather than the region scanning the DOM, so reads (links, filters, tabs, Retry now) can never be switched off by accident and the inert state reaches each control's own press handling. The wrapper takes no box (`display: contents`) and its stylesheet declares no `opacity`, `filter` or colour, so the old data is drawn exactly as the live data is.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No—the region adds no keyboard pattern and no top layer; it reuses the `aria-disabled`, still-focusable state that `Button` already has while it is loading.
- Reviewer: Not applicable.
- Review outcome: No novel interaction review required.

### Focus management

Focus is never moved. An inert control stays in the tab order, so a keyboard user can reach it and hear its reason. When the region stops being stale the controls return to normal without remounting, so focus stays where it was.

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab | Any control | Moves through inert controls like any other. |
| Enter, Space | Inert button, switch or checkbox | Does nothing; a toggled switch or checkbox is put back. |
| Enter, Space, arrows | Inert select or menu trigger | The picker or menu does not open. |
| Any | A control that did not opt in | Unchanged. |

### Assistive-technology announcements

An inert control is announced as unavailable (`aria-disabled="true"`) and its description reads the reason: "Off until it’s back" unless the page words its own through `reason`, or points at its banner with `describedBy`. The reason lives in a visually hidden element inside the region, rendered only while stale. The region itself has no role and announces nothing; the banner carries the announcement that the data is old.

## Forced colors

The region draws nothing of its own. An inert control uses the same muted treatment as a disabled one, and the old data keeps the system colours it already had.
