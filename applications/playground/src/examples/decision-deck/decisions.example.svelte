<script lang="ts" module>
  export const title = 'Reacting to decisions';
  export const description =
    'onDecision fires as soon as a decision is made, and onUndo when it is reversed, so the page can keep its own record in step with the deck.';
</script>

<script lang="ts">
  import { DecisionDeck } from '@lostgradient/cinder';

  const items = [
    { id: 'one', title: 'Archive receipts' },
    { id: 'two', title: 'Label the weekly digest' },
  ];

  let log = $state<string[]>([]);
</script>

<DecisionDeck
  label="Review queue"
  {items}
  onDecision={({ item, outcome }) => {
    log.push(`${outcome}: ${item.title}`);
  }}
  onUndo={() => {
    log.pop();
  }}
/>
<p>{log.length} decided</p>
