<script lang="ts" module>
  export const title = 'Reacting to decisions';
  export const description =
    'onDecision fires as soon as a decision is made, and onUndo when it is reversed, so the page can keep its own record in step with the deck.';
</script>

<script lang="ts">
  import { DecisionDeck } from '@lostgradient/cinder';
  import type { DecisionDeckOutcome } from '@lostgradient/cinder';

  const items = [
    { id: 'one', title: 'Archive receipts' },
    { id: 'two', title: 'Label the weekly digest' },
  ];

  let decided = $state<Record<string, DecisionDeckOutcome>>({});
</script>

<DecisionDeck
  label="Review queue"
  {items}
  onDecision={({ item, outcome }) => (decided[item.id] = outcome)}
  onUndo={({ item }) => delete decided[item.id]}
/>
<p>{Object.keys(decided).length} decided</p>
