# Citation design and accessibility review

This record documents the design and accessibility review for the inline source marker and its Popover disclosure.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Approved.
- Nearest neighbours: Popover and Pagination.
- Why this component exists: It combines an inline source marker with paginated source disclosure, which neither neighbour provides alone.
- Findings and resolutions: The marker is a keyboard-focusable native button; up to five sources are one ordered list, so a reader compares them without paging; each source keeps a native link only for a safe web address, and otherwise a text note says it has no public link or that its address was hidden; more than five sources are paged, and the pager exposes its current position and disables unavailable directions.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: Yes—the marker opens a rich Popover disclosure and the disclosure contains interactive source links and pagination controls.
- Reviewer: Cinder maintainers
- Review outcome: Approved.

### Focus management

Focus enters the marker through normal document order. Popover opens on activation and keeps the marker as the trigger; Escape and pointer/focus exit dismiss the card. Focus returns to the marker after dismissal, and removing the trigger safely unmounts the card.

### Keyboard matrix

| Key or gesture | Context            | Expected behavior                                       |
| -------------- | ------------------ | ------------------------------------------------------- |
| Enter or Space | Citation marker    | Open the source Popover.                                |
| Tab            | Open card          | Reach source links, then pagination controls, in order. |
| Escape         | Open card          | Dismiss the Popover and restore trigger context.        |
| Shift+Tab      | Pagination control | Move backward through the normal focus order.           |

### Assistive-technology announcements

The marker is a button named “Sources (N)” and exposes the Popover through the existing Popover trigger semantics. Source details use a native ordered list for two to five sources, with strong titles, paragraphs and links; the arrow after a link's text is hidden from assistive technology. With more than five, the current-page text is polite live text (“N of M”); disabled previous/next buttons communicate pagination bounds. Verified against keyboard navigation and the browser accessibility tree in Chromium with the default light and dark themes.
