# DecisionDeck

<!-- generated:a11y-record:required -->

`DecisionDeck` is a stack of decision cards for working through a review queue on a phone, where a grid of buttons reads worse than one card at a time. Drag the top card right to accept it and left to reject it: a stamp fades in as the card moves, a release past the threshold (110px by default) decides, and a shorter release springs the card back. Under the card sit equal round buttons for reject, later and accept, which do exactly what a swipe does, and the focused card also takes the arrow keys. Every decision is announced, an Undo appears after each one, and a progress bar and an "All caught up" state frame the queue.

A swipe is only a shortcut. Every decision is reachable by button and by keyboard, a reject is never hidden or folded into a menu, and an accidental swipe is never final: the Undo stays visible until the next decision, and it brings back the exact card and returns focus to the control that made the decision.

Use `ApprovalCard` for one pending request that needs its full detail. Use `DecisionDeck` for a queue of short cards.

## Usage

```svelte
<script lang="ts">
  import { DecisionDeck } from '@lostgradient/cinder';

  const items = [
    {
      id: 'receipts',
      title: 'Archive receipts',
      description: 'Move mail from receipts@shop.example to Receipts.',
    },
    { id: 'digest', title: 'Label the weekly digest', eyebrow: 'News Weekly' },
  ];
</script>

<DecisionDeck
  label="Review queue"
  {items}
  onDecision={({ item, outcome }) => console.info(item.id, outcome)}
  onUndo={({ item }) => console.info('undone', item.id)}
/>
```

## Decisions and Undo

`items` is the whole queue, decided cards included. The deck records each decision against the item's `id` and hides the card, so keep decided items in the list: Undo brings the card back from it, and the progress bar counts against its length. `onDecision` fires once per decision, from a swipe, a button or a key alike, with `{ item, outcome }` where `outcome` is `accept`, `reject` or `later`. Treat the decision as provisional, because the person can still undo it, and reverse it in `onUndo`. A card decided `later` leaves the deck like the others, and the empty state says how many were left for later.

Undo steps back through the decisions one at a time, most recent first, and stays visible after the last card, next to the "All caught up" state.

## Keyboard

The top card is a focus stop. With it focused, `ArrowRight` accepts, `ArrowLeft` rejects and `ArrowDown` sets the card aside for later. The three round buttons are ordinary buttons in the tab order, so a keyboard decision never needs the arrow keys. After a decision, focus stays on the button that made it, or moves to the next card when a key made it, or to the empty state when the last card is gone. Undo returns focus to the control that made the undone decision.

## Custom card content

By default a card shows an `eyebrow`, a `title` and a `description`. Pass a `card` snippet to draw your own body for each item; the card's accessible name, stamps and gestures remain the deck's. A link, button or field inside a card keeps working: a drag does not start on it.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `acceptLabel` | `string` | no | — | Text of the accept button, the accept stamp and the accept announcement. Defaults to "Accept". |
| `class` | `string` | no | — | Custom class merged with `.cinder-decision-deck`. |
| `emptyDescription` | `string` | no | — | Supporting line of the empty state. Left unset, it says how many cards were left for later. |
| `emptyTitle` | `string` | no | — | Title of the empty state shown when every card is decided. Defaults to "All caught up". |
| `keyboardHint` | `string` | no | — | Hidden text that names the keys on a focused card, read after the card's name. Defaults to a sentence naming ArrowRight, ArrowLeft and ArrowDown. |
| `label` | `string` | no | — | Accessible name of the deck, such as "Review queue". Left unset, the deck is unnamed. |
| `laterLabel` | `string` | no | — | Text of the later button. Defaults to "Later". |
| `rejectLabel` | `string` | no | — | Text of the reject button and the reject stamp. Defaults to "Reject". |
| `threshold` | `number` | no | — | How far in pixels a card must be dragged sideways before releasing it decides. Defaults to 110. A shorter release springs the card back. |
| `undoLabel` | `string` | no | — | Text of the undo button. Defaults to "Undo". |
| `card` | `(opaque)` | no | — | Renders inside each card, replacing the built-in eyebrow, title and description. The card's name, stamps and gestures stay the deck's. Not expressible in JSON Schema; see the component types for the signature. |
| `describeDecision` | `(opaque)` | no | — | Builds the sentence the undo bar shows and the live region announces for a decision, such as "Accepted: Archive receipts". Not expressible in JSON Schema; see the component types for the signature. |
| `items` | `(opaque)` | yes | — | The whole queue in reading order, decided cards included: the deck tracks decisions itself and hides a card once it is decided, so keep decided items in this list, because Undo brings the card back from it. Not expressible in JSON Schema; see the component types for the signature. |
| `onDecision` | `(opaque)` | no | — | Called once for each decision, from a swipe, a button or the keyboard alike, as soon as it is made. The card stays undoable until the next decision, so treat the decision as provisional and reverse it in `onUndo`. Not expressible in JSON Schema; see the component types for the signature. |
| `onUndo` | `(opaque)` | no | — | Called when a decision is undone, with the decision that was reversed. Not expressible in JSON Schema; see the component types for the signature. |
| `progressText` | `(opaque)` | no | — | Builds the progress text from the position of the top card and the total, such as "2 of 5". Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## Authoring checklist

<!-- generated:authoring:start -->
<!-- generated:authoring:end -->

## CSS Variables

<!-- generated:variables:start -->

This component does not declare any local CSS variables.
<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->
<!-- generated:subcomponents:end -->
