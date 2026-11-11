import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    label: {
      type: 'string',
      description:
        'Accessible name of the deck, such as "Review queue". Left unset, the deck is unnamed.',
    },
    threshold: {
      type: 'number',
      description:
        'How far in pixels a card must be dragged sideways before releasing it decides. Defaults to 110. A shorter release springs the card back.',
    },
    acceptLabel: {
      type: 'string',
      description:
        'Text of the accept button, the accept stamp and the accept announcement. Defaults to "Accept".',
    },
    rejectLabel: {
      type: 'string',
      description: 'Text of the reject button and the reject stamp. Defaults to "Reject".',
    },
    laterLabel: {
      type: 'string',
      description: 'Text of the later button. Defaults to "Later".',
    },
    undoLabel: {
      type: 'string',
      description: 'Text of the undo button. Defaults to "Undo".',
    },
    emptyTitle: {
      type: 'string',
      description:
        'Title of the empty state shown when every card is decided. Defaults to "All caught up".',
    },
    emptyDescription: {
      type: 'string',
      description:
        'Supporting line of the empty state. Left unset, it says how many cards were left for later.',
    },
    keyboardHint: {
      type: 'string',
      description:
        "Hidden text that names the keys on a focused card, read after the card's name. Defaults to a sentence naming ArrowRight, ArrowLeft and ArrowDown.",
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-decision-deck`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'card',
        reason: 'function-or-snippet',
        description:
          "Renders inside each card, replacing the built-in eyebrow, title and description. The card's name, stamps and gestures stay the deck's.",
      },
      {
        name: 'describeDecision',
        reason: 'function-or-snippet',
        description:
          'Builds the sentence the undo bar shows and the live region announces for a decision, such as "Accepted: Archive receipts".',
      },
      {
        name: 'items',
        reason: 'generic-type-parameter',
        required: true,
        description:
          'The whole queue in reading order, decided cards included: the deck tracks decisions itself and hides a card once it is decided, so keep decided items in this list, because Undo brings the card back from it.',
      },
      {
        name: 'onDecision',
        reason: 'function-or-snippet',
        description:
          'Called once for each decision, from a swipe, a button or the keyboard alike, as soon as it is made. The card stays undoable until the next decision, so treat the decision as provisional and reverse it in `onUndo`.',
      },
      {
        name: 'onUndo',
        reason: 'function-or-snippet',
        description: 'Called when a decision is undone, with the decision that was reversed.',
      },
      {
        name: 'progressText',
        reason: 'function-or-snippet',
        description:
          'Builds the progress text from the position of the top card and the total, such as "2 of 5".',
      },
    ],
  },
} satisfies ComponentSchema;

/** JSON Schema describing the props of this component. */
export default schema as ComponentSchema;
