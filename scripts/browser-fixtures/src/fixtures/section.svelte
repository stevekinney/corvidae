<script lang="ts">
  import { Button, Link, Section } from '@lostgradient/cinder';

  const rows = [1, 2, 3, 4, 5, 6, 7, 8];
</script>

{#snippet actions()}
  <Button size="sm" variant="secondary">See all</Button>
{/snippet}

<!-- A short flex column that scrolls: the case where a flex item with overflow hidden collapses. -->
<div
  id="section-scroll-parent"
  style="display: flex; flex-direction: column; block-size: 10rem; overflow: auto;"
>
  <Section title="Tonight" description="Eight stops" {actions}>
    {#each rows as row (row)}
      <p class="section-row" style="margin: 0; block-size: 3rem; overflow: hidden;">Stop {row}</p>
    {/each}
  </Section>
  <Section title="Saved">
    <p>Nothing saved yet.</p>
  </Section>
</div>

<!-- A small "more" link as the action (COR-2329): centred on the title's line like a button. -->
<div data-testid="section-more-link">
  <Section title="Needs attention">
    {#snippet actions()}<Link href="/health" variant="more">Open Health</Link>{/snippet}
    <p style="margin: 0;">Nothing needs attention.</p>
  </Section>
</div>
