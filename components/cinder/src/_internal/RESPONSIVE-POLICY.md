# Cinder Responsive Layout Policy

Component-owned responsive behavior should use container queries. If a component changes because its own inline size is constrained, the stylesheet should set `container-type: inline-size` on the component root and query that container.

Viewport queries are reserved for viewport-owned behavior: app shells, drawers, and modality switches where the viewport itself is the constraint. The documented exceptions share one set of breakpoints: phones are narrower than 640px, tablets run from 640px to 1023px, and desktops start at 1024px.

- Sidebar's mobile Drawer switch (`SIDEBAR_MOBILE_BREAKPOINT`, `639.98px`), so tablets keep the inline column and its icon rail.
- Table's `stackBelow`, which stacks rows into labelled values on a phone.
- Popover's, Dropdown's, Combobox's, and MultiSelect's `sheetBelow`, which open them as bottom sheets on a phone.
- Breadcrumbs' `collapseBelow`, which collapses a trail to a back link to the parent and the current page on a phone, and Tabs' `collapseBelow`, which turns a horizontal tab bar into one select. Both are phone-form choices made in script (`useViewportBelow`), so what is not shown is not in the page.
- StackedListItem's phone form: below 640px a status moves to line two beside the kind and agent, and trailing `actions` collapse into one menu button. Many rows ask the same question, so they read one shared query through `phoneViewport` in `phone-viewport.svelte.ts` rather than one `MediaQuery` each.

Each reads the viewport through `useViewportBelow` in `viewport-below.svelte.ts` (or the shared `phoneViewport`, for the row), which wraps Svelte's `MediaQuery`, so none of them adds a viewport `@media` rule to component CSS.

Quality checks for responsive components should include both cases:

- a narrow component container inside a wide viewport
- a wide component container inside a narrow viewport
