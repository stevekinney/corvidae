# DisclosureTrigger Accessibility

## ARIA Roles and Attributes

DisclosureTrigger is the button half of the [WAI-ARIA Disclosure pattern](https://www.w3.org/WAI/ARIA/apg/patterns/disclosure/); the host draws the region it shows.

- A native `<button type="button">`, so Enter and Space and the tab order come from the browser.
- `aria-expanded` reflects `open`, so a screen reader says expanded or collapsed with the words.
- `aria-controls` is the `controls` id. Pass it only while the region is in the document, or keep the region in the document with `hidden` while it is closed.
- The chevron is decorative (`aria-hidden`); the state is in `aria-expanded`, never in the glyph alone.
- A disabled trigger uses the native `disabled` attribute and leaves the tab order.

## Keyboard Interactions

| Key           | Behaviour                                 |
| ------------- | ----------------------------------------- |
| Tab           | Moves focus to the trigger.               |
| Enter / Space | Fires `onclick`; the host toggles `open`. |

## Visual

- The focus ring is the shared Cinder ring; forced colours draw a real outline.
- On a touch screen the trigger keeps its painted size, and a 44px hit area that takes no layout reaches past it.
- Closed, the chevron points at the words, mirrored in a right-to-left layout; open, it points down in either.
- Reduced motion turns the chevron without animation.
