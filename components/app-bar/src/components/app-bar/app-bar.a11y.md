# AppBar design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: Toolbar, NavigationBar, PageHeader.
- Why this component exists: Pages needed a unified, translucent top bar like the platform's own: a material with a backdrop blur, icon actions with tooltips, and a title that appears when a large title scrolls away. Toolbar is already the WAI-ARIA roving-tabindex control group and NavigationBar is a bar of navigation items, so this has its own name.
- Findings and resolutions: The bar is 56px tall with no rule, the canvas mixed at 82% with a 16px blur, and opaque where blur is unsupported or less transparency is asked for. On a phone detail page the page's identity lives in the bar, so there is never an empty bar above a separate title.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: No. The bar holds ordinary buttons and links in document order; it adds no keyboard pattern of its own.
- Reviewer: Not applicable.
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

Back, the leading content, the trailing content and the icon actions are reached with Tab in that order. Nothing moves focus.

### Keyboard matrix

| Key or gesture | Context     | Expected behavior                           |
| -------------- | ----------- | ------------------------------------------- |
| Tab            | Any control | Moves focus to the next control in the bar. |
| Enter, Space   | Icon action | Activates it, as a native button or link.   |

### Assistive-technology announcements

- Every icon-only action is named by its required `label`, and its tooltip repeats the name without describing it a second time. Back is named "Back" unless `label` says otherwise.
- The bar is not a landmark. With `headingLevel` the title is the page's heading; without it the title is plain text, because a PageHeader carries the heading.
- While `titleVisible` is false the title is `aria-hidden`, so the heading of a paired PageHeader is announced once.

## Touch targets

Under a coarse pointer every icon action, Back included, is at least 44px square.

## Forced colors

The bar draws the system canvas and a rule in system text colour, because its translucent material is not drawn.
