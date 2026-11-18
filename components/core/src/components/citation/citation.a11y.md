# Citation design and accessibility review

This record documents the design and accessibility review for the inline source marker and its Popover disclosure.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Approved.
- Nearest neighbours: Popover.
- Why this component exists: It combines an inline source marker with one list of source references and their URL policy, which Popover alone does not provide.
- Findings and resolutions: The marker is a keyboard-focusable native button; every source is one row of one ordered list, so a reader compares them without paging; a source with a safe web address is one native link covering its whole row, and otherwise a text note says it has no public link or that its address was hidden; the row a reader followed a marker for carries `aria-current` and a visible edge and tint, so it is not marked by colour alone.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: Yes—the marker opens a rich Popover disclosure and the disclosure contains interactive source links.
- Reviewer: Cinder maintainers
- Review outcome: Approved.

### Focus management

Focus enters the marker through normal document order. Popover opens on activation and keeps the marker as the trigger; Escape and pointer/focus exit dismiss the card. Focus returns to the marker after dismissal, and removing the trigger safely unmounts the card.

### Keyboard matrix

| Key or gesture | Context         | Expected behavior                                |
| -------------- | --------------- | ------------------------------------------------ |
| Enter or Space | Citation marker | Open the source Popover.                         |
| Tab            | Open card       | Reach each source link, in order.                |
| Escape         | Open card       | Dismiss the Popover and restore trigger context. |
| Shift+Tab      | Source link     | Move backward through the normal focus order.    |

### Assistive-technology announcements

The marker is a button named “Sources (N)” and exposes the Popover through the existing Popover trigger semantics. Source details use a native ordered list, with a strong title, a domain or note, and an excerpt in each row; a linked row is one link whose accessible name is its text, and the open glyph is hidden from assistive technology. With `inPlace` on a wide viewport the marker reports `aria-expanded` and names the list in `aria-controls`. Verified against keyboard navigation and the browser accessibility tree in Chromium with the default light and dark themes.
