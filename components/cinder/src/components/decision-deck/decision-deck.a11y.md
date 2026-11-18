# DecisionDeck design and accessibility review

Complete this record before merge. Automated checks can detect malformed APIs, missing semantics, and structural regressions. They cannot decide that a component is drab, bulbous, ugly, has a poor layout, or whether the interaction model is wrong. Those judgments require human review.

## Design review (required)

- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.
- Nearest neighbours: ApprovalCard, Carousel, ActionRow.
- Why this component exists: On a phone, a review queue of accept, reject and later buttons reads as a grid of controls with no sense of progress. A stack of decision cards shows one item at a time, lets a swipe stand in for the buttons, and keeps Undo and progress beside it. ApprovalCard resolves one request with its detail, Carousel browses without deciding, and ActionRow is a row of actions with no queue.
- Findings and resolutions: Reject and accept are the same size and weight, and later is smaller, so neither answer is favoured and a deny is never hidden. The stamps carry their word (Accept, Reject) as well as a colour. A swipe never decides alone: the Undo bar is visible after every decision.

## Novel interaction accessibility review

A novel interaction model includes a new disclosure or keyboard pattern, entering or leaving the top layer, or making previously static content interactive.

- Applies: Yes—the component introduces a pointer drag that decides, a keyboard pattern on the card, and focus that moves when a card leaves the stack.
- Reviewer: Cinder maintainers
- Review outcome: Pending. The design-reviewer verdict has not been recorded yet.

### Focus management

The top card is a focus stop (`tabindex="0"`, `role="group"`, named by the item's title). The cards under it are `inert` and `aria-hidden`, so a control inside a hidden card is never reachable. A decision made with a round button leaves focus on that button. A decision made with an arrow key moves focus to the next card, and the last decision moves focus to the empty state (`tabindex="-1"`). A swipe moves focus only when the card held it. Undo restores the exact previous card and puts focus back on the control that made the decision (the button, or the card for a key or a swipe).

### Keyboard matrix

| Key or gesture | Context | Expected behavior |
| --- | --- | --- |
| Tab / Shift+Tab | Deck | Moves from the top card to the reject, later and accept buttons, then Undo. |
| ArrowRight | Top card focused | Accepts the card left to right; rejects it right to left. |
| ArrowLeft | Top card focused | Rejects the card left to right; accepts it right to left. |
| ArrowDown | Top card focused | Sets the card aside for later. |
| Enter / Space | A round button or Undo | Activates the native button: the same decision as the swipe or key. |
| Drag sideways, release past the threshold | Top card, pointer or touch | Accepts (toward the inline-end side: right, or left right to left) or rejects (the other way). A shorter release springs back and decides nothing. |
| Drag vertically | Top card, touch | Scrolls the page; the gesture is dropped without a decision. |

The arrow keys only act when the card itself has focus, so a link or field inside a custom card body keeps its own keys.

### Assistive-technology announcements

The card names itself by its title and is described by a hidden sentence naming the three keys. Every decision and every undo is announced through a polite status region, for example "Accepted: Archive receipts". The progress bar is a `progressbar` named by its visible text ("2 of 5") with the number of decided cards as its value. The empty state is plain text with a title and a line saying how many cards were left for later. The stamps are decorative and hidden from assistive technology, because the buttons and announcements already say what happened.

## Motion and forced colors

A decided card leaves as a decorative copy (`data-cinder-decision-exit`) that slides toward the side of its decision, turning a little, and fades; the copy is inert, hidden from assistive technology and removed when its animation ends. The deck reads its direction from the nearest `dir` attribute (or the computed direction), so the arrow keys, the swipe, the stamps and the exit all put accept on the inline-end side. Under reduced motion the exit copy is never drawn and the spring is skipped: a short release snaps the card back at once, and the progress bar does not ease. The drag itself still follows the pointer, because it is direct manipulation and not an animation. In forced colors the card, the stamps and the progress track take a `CanvasText` border and the progress fill takes `Highlight`.
