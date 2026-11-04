<script lang="ts" module>
  export const title = 'Clamped run with Show all';
  export const description =
    "A long run holds to five lines; Show all opens the rest in place and the page's own link sits beside it.";
</script>

<script lang="ts">
  import { Text } from '@lostgradient/cinder';

  const reply =
    'Here is where the refund queue stands. Four refunds are waiting for approval: 4455 ($18.50, arrived damaged), 4456 ($42.00, wrong size), 4457 ($9.99, duplicate charge) and 4458 ($27.00, never arrived). Three of them look routine and I would approve them. 4458 needs a look first, because the carrier shows it as delivered. I have not issued anything; each refund asks you first. If you want, I can draft a note to the customer for 4458 while you decide on the others.';
</script>

<div style="max-inline-size: 24rem;">
  <Text clamp={5}>
    {reply}
    {#snippet actions()}
      <button type="button">Show raw payloads</button>
    {/snippet}
  </Text>
</div>
