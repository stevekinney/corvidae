# SideNavigation Accessibility Notes

## Landmark labeling

`SideNavigation` renders a `<nav aria-label="…">` landmark. The `ariaLabel` prop is required and validated at runtime — an empty string throws during render so a blank label never reaches the DOM.

The label must be distinct from every other `<nav>` on the page. When a `NavigationBar` is present (which uses `"Main navigation"`), use a different label for the sidebar: `"Sections"`, `"Workspace"`, `"Project"`, or similar. Screen readers expose multiple nav landmarks in the landmark rotor; identical labels collapse them, making navigation ambiguous for assistive technology users.

## Section header role decision

`SideNavigationGroup` uses a plain `<button type="button">` as the disclosure trigger rather than wrapping it in a heading element (`<h2>`, `<h3>`). Rationale:

- A sidebar section label is UI chrome for a navigation list, not a document outline entry. Wrapping it in a heading would inject spurious items into the screen-reader heading list and confuse the document structure.
- The nested `<ul>` carries its accessible name via `aria-labelledby` pointing at the trigger's `id`. This is the WAI-ARIA Authoring Practices recommended approach for a "labeled list" pattern — the group label is conveyed to AT through list labeling, not through heading semantics.

## Disclosure pattern

Follows WAI-ARIA APG [Disclosure](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/):

- `aria-expanded` on the trigger reflects open/closed state.
- `aria-controls` on the trigger points at the disclosed `<ul>`'s `id`.
- The disclosed region uses the `hidden` attribute (not a CSS class) when collapsed. `hidden` is equivalent to `display: none` at the layout level, which means the browser and all assistive technologies consistently exclude collapsed children from focus order and the accessibility tree — no extra ARIA is needed to enforce this.

## Counts, dots and collapsed rows

A `SideNavigationItem` with a `label` and a non-zero `count` is named `"<label>, <count> <countLabel>"` ("Health, 3 need attention"), so the figure carries the meaning. The numeric pill and the status dot are `aria-hidden` decoration over that name. On a collapsed icon rail the visible label is clipped, not removed, so the name is unchanged; hover or focus shows the same words in a tooltip (`"Reviews, 2 need you"`). The tooltip is not the row's description (`aria-describedby` is not set), because the name already says it.

## Keyboard model

This is a navigation landmark containing links and disclosure buttons — it is **not** a composite widget like `tablist` or `menubar`.

| Key | Behavior |
| --- | --- |
| `Tab` / `Shift-Tab` | Moves focus between interactive elements: disclosure triggers and visible navigation items. |
| `Enter` / `Space` | Activates the focused disclosure trigger (toggles expand/collapse). |
| `Enter` on a link | Follows the link. |

We deliberately do **not** implement roving tabindex or arrow-key navigation. WCAG SC 2.1.1 and the APG explicitly differentiate list-of-links navigation (where Tab is correct) from composite widgets (where arrow keys are expected). Sidebar navigation falls in the former category.

## Disabled rows and their reason

A disabled `SideNavigation.Item` is removed from the tab order by `NavigationItem` and drawn in the disabled text colour at the regular weight, against the medium weight of an enabled row, so it differs by more than colour (COR-2665). A `disabledReason` is drawn under the label as a second line, in the disabled colour at the extra-small size so it never reads louder than the name it explains (COR-2680), at every width, so a touch screen, which never shows a hover tooltip, reads it too; `emptyLabel` is never drawn and is no place for a reason. The reason is the row's description (`aria-describedby`) and `label` stays its name, so a screen reader hears "Workers, Open a task queue first" on a disabled button. The reason is not hidden from assistive technology, so a disabled link, which loses its `href` and is read as text in browse mode, still reads it. A collapsed icon-rail row clips the reason with its label, keeps it as its description, and says it in the tooltip. An expanded row that shows its reason draws no tooltip repeating it, and a disabled row that does answer hover with a tooltip (a collapsed rail row) takes the enabled row's neutral hover tint, so hover always shows feedback. `side-navigation-item-reason.test.ts` asserts the markup, name and description, and `scripts/browser-fixtures/tests/side-navigation-disabled-reason.playwright.ts` the line's geometry, colour and size and the weight difference, in both themes at 375 and 1280px.

## A group's shared reason

A `SideNavigation.Group` with a `disabledReason` says it once, between its header and its rows, in the disabled colour at the extra-small size (COR-2680). Every disabled row in the group that has no reason of its own, or repeats the group's, draws no line and is described by the group's reason through `aria-describedby`, so a screen reader still hears why each row is off. A row with a different reason draws and is described by its own. An enabled row is never described by it. The reason hides with the rows when the group collapses, and a collapsed icon rail clips it while keeping it as the rows' description. `side-navigation-group-reason.test.ts` asserts the markup and descriptions, and `side-navigation-disabled-reason.playwright.ts` that the reason is drawn once, aligned with the rows' text, and quieter than them, in both themes.

## Generated IDs and SSR

`useId` is a process-wide counter. If server-side rendering produces a different render order than the client, IDs may diverge (hydration mismatch). This matches every existing consumer in this library (`AccordionItem`, etc.) and is acceptable for current usage. Consumers who need stable IDs should pass the `id` prop explicitly.

## Forced-colors mode

The `SideNavigationGroup` trigger uses a `box-shadow`-based focus ring consistent with `NavigationItem`. In forced-colors mode (Windows High Contrast), `box-shadow` is suppressed by the browser. The CSS provides a `@media (forced-colors: active)` fallback that uses a real `outline: var(--cinder-ring-width) solid ButtonText` instead, keeping focus indicators visible.

## Motion

The chevron rotation transition is controlled by `--cinder-duration-fast`. The `@media (prefers-reduced-motion: reduce)` block in `side-navigation-group.css` sets `transition: none` so users who have opted out of motion see an instant state change. Panel show/hide is instant by default (via `hidden` attribute, which cannot be animated) — no motion reduction override is needed for the panel.

## Required prop discipline

`SideNavigation` does not fall back to any default `aria-label` string, because every default would be wrong in at least some context. The TypeScript type enforces `ariaLabel` at compile time; the runtime validation ensures nothing slips through in untyped JS consumers.
