# FilterBar accessibility

## Pattern

`FilterBar` is a composed filter surface, not a single widget. It uses the `role="search"` landmark to group the filtering controls, and every control inside follows its own pattern: a radio group of segments, listbox selects, popover dialogs for the choice facets, toggle buttons, and a search input.

Roving-tabindex Toolbar semantics are intentionally NOT applied to the outer container: the search input and selects own their own arrow-key semantics (text cursor, option navigation), which conflict with the toolbar pattern's arrow-key model. Normal Tab order is used throughout. The bar has one row, and the DOM order is the visual order: an applied choice chip follows the chips still waiting for a value, and an applied filter that no facet draws follows the facets.

## Roles names states

| Element | Role / Semantics | Notes |
| --- | --- | --- |
| Root `div` | `role="search"` | Consumer must supply a meaningful `aria-label` (for example `"Run filters"`). |
| Segments | `role="radiogroup"` of `role="radio"` | Named by `segmentsLabel` (visually hidden). Each segment's count is part of its name ("Waiting on you, 2"), so it never depends on colour. |
| Collapsed segments | Listbox `Select` | Named by `segmentsLabel`; the visible prefix "Status:" is decorative. Options read "Failed 1". |
| Select facet | Listbox `Select` | Named by the facet label; the prefix "Kind:" is decorative. The first option clears the facet. |
| Choice chip (label) | `button`, `aria-haspopup="dialog"`, `aria-expanded` | Opens a dialog named by the facet's title. An applied chip reads "Started by: Chats, Goals". |
| Choice chip (x) | `button` | `aria-label="Remove filter: Started by: Chats, Goals"`. Focus returns to the facet's chip after removal. |
| Choice options | `group` of checkboxes, or a `radiogroup` | Each count is the checkbox's or radio's `aria-describedby`. |
| Applied filter without a facet | `span` with a `button` | A chip that reads "Updated: Last 24 hours" with the same Remove button. In the narrow form it is a row in the Filter menu. |
| Toggle chip | `button`, `aria-pressed` | Name includes the count ("Missed runs 1"). The dot is decorative. |
| Search | `type="search"` | Provided by `SearchField`. In the medium layout an icon button named "Search" opens it in a dialog; in the narrow layout it is the Filter menu's Search row. |
| Filter button | `button`, `aria-haspopup="dialog"`, `aria-expanded` | Named "Filter", or "Filter, 2 applied" while filters are applied. |
| Filter menu rows | `button`, `aria-expanded`, `aria-controls` | One row per facet and one for Search; a row opens its controls in place beneath it. |
| Live region | `role="status"` (`aria-live="polite"`, `aria-atomic="true"`) | Always in DOM; announces the active filter count and values on change. Never conditionally rendered. |

## Keyboard

| Key | Action |
| --- | --- |
| Tab | Move focus sequentially through the segments, the facet controls, and the search field. |
| Arrow keys | Move between segments; move through the options of an open select. |
| Enter / Space | Open a chip's popover, press a toggle, activate Remove, Clear, or a Filter menu row. |
| Escape | Close an open popover or select and return focus to its trigger. In the search field, clear the text (native `type="search"` behaviour). |

## Mouse and pointer

- Clicking a chip's label opens its popover; clicking its x fires `onFilterRemove` with the facet key.
- Ticking a checkbox fires `onFacetValuesChange` with every chosen value in the facet's own option order; Clear fires it with an empty list.
- Choosing a radio row, a select option or a toggle fires `onFacetChange`; clearing reports an empty string.
- Typing in the search field fires `onSearchChange` on every keystroke.

## Responsive behaviour

The bar never wraps and never scrolls sideways. Below 1024px of viewport (or when its own width cannot hold the wide form) the segments fold into a select and the search into an icon button. Below 640px only the Status select and a Filter button remain; on a phone the Filter menu opens as a bottom sheet with 44px rows. Under `prefers-reduced-motion` the popovers cross-fade instead of sliding, as every Cinder popover does.

## Hard scope caps

- The bar does not implement routing, URL-sync, or persistence. The consumer owns those.
- The bar does not implement data fetching or debouncing. The consumer owns those.
- No date-range primitive is included. A `type: 'custom'` facet is the extension point for date pickers.
- The bar draws no Clear all button. A list that filters to nothing offers Clear filters in its own empty state.
