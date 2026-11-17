import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

/** What a reviewer can do with a card: accept it, reject it, or set it aside until later. */
export type DecisionDeckOutcome = 'accept' | 'reject' | 'later';

/** One card in the deck: the text the built-in card body draws, and the identity the deck tracks decisions by. */
export type DecisionDeckItem = {
  /** Stable identifier, unique within the deck. The deck records each decision against it, so it must not change while the deck is mounted. */
  id: string;
  /** The card's title. It is also the card's accessible name and the text of the decision announcement. */
  title: string;
  /** A supporting line under the title, such as what the rule would do. */
  description?: string;
  /** A small line above the title, such as who sent the item. */
  eyebrow?: string;
};

/** A decision the reviewer made: the card, and what was decided about it. */
export type DecisionDeckDecision<TItem extends DecisionDeckItem = DecisionDeckItem> = {
  /** The card that was decided. */
  item: TItem;
  /** What was decided: `accept`, `reject` or `later`. */
  outcome: DecisionDeckOutcome;
};

/** Props for the DecisionDeck component. */
export type DecisionDeckProps<TItem extends DecisionDeckItem = DecisionDeckItem> = Omit<
  HTMLAttributes<HTMLElement>,
  'children' | 'class'
> & {
  /** The whole queue in reading order, decided cards included: the deck tracks decisions itself and hides a card once it is decided, so keep decided items in this list, because Undo brings the card back from it. */
  items: TItem[];
  /** Accessible name of the deck, such as "Review queue". Left unset, the deck is unnamed. */
  label?: string;
  /** How far in pixels a card must be dragged sideways before releasing it decides. Defaults to 110. A shorter release springs the card back. */
  threshold?: number;
  /** Text of the accept button, the accept stamp and the accept announcement. Defaults to "Accept". */
  acceptLabel?: string;
  /** Text of the reject button and the reject stamp. Defaults to "Reject". */
  rejectLabel?: string;
  /** Text of the later button. Defaults to "Later". */
  laterLabel?: string;
  /** Text of the undo button. Defaults to "Undo". */
  undoLabel?: string;
  /** Title of the empty state shown when every card is decided. Defaults to "All caught up". */
  emptyTitle?: string;
  /** Supporting line of the empty state. Left unset, it says how many cards were left for later. */
  emptyDescription?: string;
  /** Hidden text that names the keys on a focused card, read after the card's name. Defaults to a sentence naming ArrowRight, ArrowLeft and ArrowDown. */
  keyboardHint?: string;
  /** Builds the progress text from the position of the top card and the total, such as "2 of 5". */
  progressText?: (position: number, total: number) => string;
  /** Builds the sentence the undo bar shows and the live region announces for a decision, such as "Accepted: Archive receipts". */
  describeDecision?: (decision: DecisionDeckDecision<TItem>) => string;
  /** Called once for each decision, from a swipe, a button or the keyboard alike, as soon as it is made. The card stays undoable until the next decision, so treat the decision as provisional and reverse it in `onUndo`. */
  onDecision?: (decision: DecisionDeckDecision<TItem>) => void;
  /** Called when a decision is undone, with the decision that was reversed. */
  onUndo?: (decision: DecisionDeckDecision<TItem>) => void;
  /** Renders inside each card, replacing the built-in eyebrow, title and description. The card's name, stamps and gestures stay the deck's. */
  card?: Snippet<[TItem]>;
  /** Custom class merged with `.cinder-decision-deck`. */
  class?: string;
};
