<script lang="ts" module>
  export const title = 'A review queue';
  export const description =
    'Drag the top card right to accept and left to reject, or press the round buttons. Each decision shows an Undo, and the deck shows progress and an All caught up state.';
</script>

<script lang="ts">
  import { DecisionDeck } from '@lostgradient/cinder';

  const items = [
    {
      id: 'receipts',
      eyebrow: 'Receipts',
      title: 'Archive receipts',
      description: 'Move mail from receipts@shop.example to the Receipts label.',
    },
    {
      id: 'digest',
      eyebrow: 'News Weekly',
      title: 'Label the weekly digest',
      description: 'Add the Reading label to mail from digest@news.example.',
    },
    {
      id: 'invoices',
      eyebrow: 'Billing',
      title: 'Star invoices',
      description: 'Star mail whose subject starts with Invoice.',
    },
  ];
</script>

<DecisionDeck label="Review queue" {items} />
