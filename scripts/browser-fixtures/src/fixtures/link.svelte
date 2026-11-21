<script lang="ts">
  import { GroupedList, GroupedListItem, Link } from '@lostgradient/cinder';
</script>

<!-- Links inside a text block must stay distinguishable without relying on color
     (WCAG 1.4.1 / axe link-in-text-block), so in-prose links use underline="always". -->
<p>
  Read the
  <Link href="/docs" underline="always">documentation</Link>
  for more details, or visit the
  <Link href="https://example.com" external underline="always">official site</Link>.
</p>

<!-- Underline/color variants shown as a standalone list (one link per row), not inside
     running prose. Outside a text block the hover/none treatments are an acceptable,
     intentional choice and don't trip axe's link-in-text-block rule. -->
<ul class="ul gap-2">
  <li><Link href="/pricing" underline="always">Always underlined</Link></li>
  <li><Link href="/pricing" underline="hover">Underline on hover</Link></li>
  <li><Link href="/pricing" underline="none">No underline</Link></li>
  <li><Link href="/pricing" color="inherit" underline="always">Inherits text color</Link></li>
  <li><Link href="/pricing" disabled>Disabled link</Link></li>
</ul>

<!-- The more form (COR-2329): the way out of a section to the page that holds the rest. -->
<div data-testid="link-more" class="link-more-layout">
  <h2 class="h2">Needs you</h2>
  <Link href="/reviews" variant="more">Open Reviews</Link>
</div>

<!-- A more link with a list row directly beneath it: the row, itself positioned and drawn after
     the link, must not cover the bottom of the link's hit area. -->
<div data-testid="link-more-over-row" class="link-more-over-row-layout margin-block-start-8">
  <div class="example-layout">
    <Link href="/health" variant="more">Open Health</Link>
  </div>
  <GroupedList aria-label="System problems">
    <GroupedListItem href="/health/storage">
      {#snippet title()}Storage is over its warning level{/snippet}
    </GroupedListItem>
  </GroupedList>
</div>

<style>
  .ul {
    list-style: none;
    padding: 0;
    display: flex;
    flex-direction: column;
  }

  .link-more-layout {
    display: flex;
    align-items: center;
    justify-content: space-between;
    max-inline-size: 24rem;
  }

  .h2 {
    margin: 0;
    font-size: var(--cinder-text-xl);
  }

  .link-more-over-row-layout {
    max-inline-size: 24rem;
  }

  .example-layout {
    display: flex;
    justify-content: flex-end;
  }
</style>
