# PageHeader accessibility

## Pattern

PageHeader organizes page-level heading content. Preserve heading semantics, keep supporting descriptions supplemental, and ensure breadcrumb and action controls remain operable with keyboard and assistive technology.

Purpose: Page-level heading with named title, description, breadcrumb, and action regions, as a default header, a large title that collapses on scroll, or a full-bleed hero band.

## Use when

- Rendering a route-level heading that needs consistent spacing and border treatment across pages.
- Pairing page context and supporting copy with optional right-aligned controls.
- Opening an overview page with a full-bleed hero band: an eyebrow, a display title, facts and one focal value.

## Avoid when

- Rendering section-scoped headings within page content — use section-heading.
- Building a marketing page with photography and several columns of copy — compose `container` (see its hero-section example).

## Keyboard and focus

Keyboard behavior follows the rendered native elements and any ARIA pattern documented by the component. Avoid adding handlers that change focus order without a matching visible and programmatic state update.

Keep focus indicators visible. If you wrap or restyle PageHeader, verify the focused element remains visually apparent in default and forced-colors modes.

## Names, roles, and state

Use the public props and documented examples to provide accessible names, descriptions, current state, disabled state, selection state, or value text. Do not rely on color, icon shape, placeholder text, or layout position as the only way to communicate meaning.

The caller owns semantics inside PageHeader's named snippets. Keep title and description snippets to phrasing content, render breadcrumb navigation with an accessible name, prefer native action controls, and add ARIA only when it matches the rendered behavior.

## Create action, status and title

- The create action is an icon-only button named by its `label`, so its tooltip repeats the accessible name and is not added as a description. Under a stale region it is `aria-disabled`, still focusable, and described by the region's reason.
- `status` is rendered as content, not announced; give it words (a dot is never the only signal).
- The title keeps its full text in the document when it is clamped to two lines; the tooltip is a convenience for pointer users.

## Decisions, large title and hero

- `decisions` holds approve, deny and edit for an approval, or Cancel for running or paused work. It is never put in the overflow menu and stays visible at every width, so a keyboard or screen-reader user never has to open a menu to find a decision. An overflow action marked `decision` is drawn as a visible button too.
- The overflow menu button is named by `overflowLabel` ("More actions" by default) and opens a menu of the remaining actions.
- A `large` title stays in the document as the page heading. The sticky bar that repeats it once it scrolls away is `aria-hidden`, so the heading is announced once.
- `titleSoft` renders inside the same heading element as the title, so the heading has one accessible name.
- A hero's dotted pattern and `art` glyph are decorative and `aria-hidden`, and are not drawn under `prefers-contrast: more` or forced colours. Every `tone` keeps text at 4.5:1 or better; the `accent` and `night` bands are dark theme islands, so the text inside takes its dark-theme colour, and their buttons draw a white focus ring.
- The eyebrow is plain text above the heading, not part of it.

## Verification

- Render PageHeader in the playground or a focused test fixture.
- Navigate the component with keyboard only.
- Inspect the accessible name, role, and state in browser accessibility tools.
- Check forced-colors mode when the component adds borders, focus rings, selected state, or status color.

Related components: `section-heading`, `container`, `app-bar`.
