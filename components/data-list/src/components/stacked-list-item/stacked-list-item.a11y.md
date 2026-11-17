# StackedListItem — Accessibility Notes

## Pattern

`StackedListItem` is a presentational row primitive that renders a single `<li>`. It **must** be placed inside a consumer-owned `<ul role="list">` (or `<ol>` for ordered/chronological content). The component owns the `<li>`; the consumer owns the parent list element.

```svelte
<ul role="list">
  <StackedListItem title={myTitleSnippet} />
  <StackedListItem title={myTitleSnippet} />
</ul>
```

> [!TIP] Composing with DataList `DataList` renders a `<ul role="list">`, so it is a valid parent for `StackedListItem`. Prefer it over a hand-rolled `<ul>` when you want a styled empty state and a list-level `density` that each row inherits:
>
> ```svelte
> <DataList items={records} density="condensed">
>   {#snippet children(record)}
>     <StackedListItem>
>       {#snippet title()}{record.name}{/snippet}
>     </StackedListItem>
>   {/snippet}
> </DataList>
> ```

## Roles, Names, States

- **Root element (`.cinder-stacked-list-item`)**: Renders as `<li>`. List item role is provided implicitly by the element. No `role` override is applied or forwarded.
- **Title region (`.cinder-stacked-list-item__title`)**: Plain `<div>` when `href` is absent; wraps an `<a>` when `href` is supplied. The anchor is the focusable, interactive element — not the row itself.
- **Leading region (`.cinder-stacked-list-item__leading`)**: Purely visual by default. Consumer controls semantics of the child (e.g., `Avatar` with a `name` prop, or `aria-hidden="true"` on decorative icons).
- **Trailing region (`.cinder-stacked-list-item__trailing`)**: Consumer-supplied interactive controls (buttons, dropdown triggers, chevron icons). Each control must have its own accessible name.

## No Interactive `<li>`

`StackedListItem` does not attach event handlers to the `<li>` element, and consumers must not add them either. The ARIA `listitem` role has no interactive semantics — assistive technologies do not reliably announce interactive list items, and keyboard users would encounter an extra focus stop with no associated action.

All interaction lives inside child elements:

- **Navigation:** via the `title` link when `href` is supplied.
- **Actions:** via controls placed in the `trailing` snippet.

If you need the entire row to be clickable, pass `href`: the row's one link is stretched over it, rather than attaching `onclick` to the `<li>`.

## Disambiguated Action Labels

When the `trailing` snippet contains interactive controls — "Edit", "Delete", "View", etc. — the accessible name of each control must identify the specific row. Screen readers reading row-by-row otherwise announce a stream of identical button labels, violating [WCAG 2.4.6 Headings and Labels](https://www.w3.org/WAI/WCAG21/Understanding/headings-and-labels.html) and [WCAG 2.4.4 Link Purpose in Context](https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html).

```svelte
{#snippet trailing()}
  <!-- imports and props… -->
  <Button aria-label={`Edit ${person.name}`}>Edit</Button>
{/snippet}
```

The snippet receives no automatic row context — the consumer is responsible for capturing the row's identity in the surrounding `{#each}` block and threading it into the `trailing` snippet.

## Linkified Rows

When `href` is set, the title anchor is the one link of the row, and it is stretched over the whole row (the stretched-link pattern): the anchor's pseudo-element covers the row, so a click anywhere follows it, hover tints the whole row, and the keyboard focus ring wraps the whole row rather than the title. There is still exactly one link and one tab stop for the row, and its accessible name is the title, so assistive technology reads the same thing it always did.

Focus order within the row is: title link → any trailing controls or actions (left-to-right in DOM order). Controls in `trailing`, `actions`, `meta` and the group disclosure sit above the cover, so they stay separately reachable and activatable; ensure they have distinct, disambiguated accessible names.

Under forced colors the focus ring is a real outline in the system colour drawn inside the row.

## Density and Touch Target Size

`StackedListItem` exposes `density="comfortable"` (default) and `density="condensed"`. Both affect row padding only — the `trailing` slot's own dimensions are untouched by the density setting.

The component cannot enforce minimum touch target sizes on `trailing` content because that region is consumer-supplied markup. Two separate WCAG criteria apply:

- **[WCAG 2.5.8 Target Size (Minimum)](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html)** — Level AA — requires at least 24×24 CSS pixels, with documented exceptions and a spacing allowance for smaller targets. This is the **baseline**.
- **[WCAG 2.5.5 Target Size (Enhanced)](https://www.w3.org/WAI/WCAG21/Understanding/target-size.html)** — Level AAA — recommends at least 44×44 CSS pixels for pointer-input targets. This is the **recommendation** for comfortable interaction.

Condensed density reduces row padding; it does not reduce trailing control dimensions. Consumers must ensure their trailing controls independently satisfy the applicable target size criterion.

## Leading Content Semantics

The `leading` snippet is not automatically hidden from assistive technologies. If the leading slot contains an avatar that identifies the same person as the row title:

- Either supply a `name` prop to `Avatar` (which provides a visible accessible name), _or_
- Apply `aria-hidden="true"` to the `Avatar` when the title already communicates the identity and the leading visual is purely decorative.

Duplicating identity information is acceptable and sometimes preferred — it makes the row easier to scan with a screen reader. Hiding it is only correct when the title already provides a complete, unambiguous label.

## Status-first row

With `status`, `time` or `details` the row is a two-line grid: the status dot and word in a fixed 128px leading column, then the title and the time, then the muted `meta` on line two. The status is a `StatusDot`, so the word, not the colour, carries the meaning, and a row with nothing to report has no status at all (the column stays empty to keep titles aligned). The status element comes first in the DOM, so a screen reader reads the status before the title. On a phone, and in the chat list's `line-two` placement, the same element sits at the start of line two; it is not duplicated.

The title is clamped at two lines with an ellipsis; set `tooltip` to the title's text so the full text is available on hover. Line two is one line that ends in an ellipsis, so give a long value its full text through the surrounding page (the detail page) rather than relying on the row.

## Failed row

A row with `error` says the message as plain text on line two; the warning glyph is decorative and hidden, so the message, not the colour, carries the meaning. The "Try again" button is described by the message (`aria-describedby`), so a list of several failed rows still tells them apart by their titles in reading order. A failed row is not a link.

## Group row

A group row (`details`) is a non-link row with a real `<button>` that carries `aria-expanded` and `aria-controls`; the region is `hidden` while collapsed. Its name is the visible "Show" or "Hide", so pass `expandLabel` and `collapseLabel` that name what they open when several appear on a page.

With `groupLayout="band"` the whole band is one `<button>` whose name is its content: the title, the muted text and the visible "Show each" or "Hide", so the label comes first in the name (WCAG 2.5.3). The status dot sits outside the band; give its `StatusDot` a `label`, because the band carries no word for it. The chevron is decorative and hidden. The amber tint is never the only signal: the title says what was missed.

## Selected row

`selected` sets `aria-current="true"` on the row's link, or on the row when it has no link, so the open item is announced and not only tinted. Under forced colors the row gets a `Highlight` outline.

## Glyph tile

The tile behind `leading` (`leadingTone`) is decoration and carries `aria-hidden="true"`. The glyph names the kind of row, so the title must say the same thing in words.

## Line two tooltip

`metaTooltip` is a native tooltip, which keyboard and touch users do not reach. It repeats text the row's page shows in full; it is never the only place the text appears.

## Trailing actions

`actions` render as buttons, or on a phone as one menu button named by `actionsLabel`. A disabled action keeps `aria-disabled="true"` and stays focusable; `disabledReason` is its `aria-describedby` text and its tooltip, so the reason is reachable by keyboard and screen reader, not only by hover.

## Reading Order and Container Queries

The responsive layout (trailing dropping below body at narrow widths) is purely visual — implemented via CSS container queries on the `<li>`. DOM order is always `leading → title → description → meta → trailing`, regardless of how the grid re-flows at narrow container widths. (With `status`, the status element leads the order.) Screen readers follow DOM order, so the reading sequence is stable and predictable across all breakpoints.

## Animation and Motion

`StackedListItem` does not apply any transition or animation by default, so there is nothing to suppress for users who prefer reduced motion. Consumers who add hover or focus animations via the `class` prop should wrap those styles in `@media (prefers-reduced-motion: no-preference)` to respect user system preferences.
