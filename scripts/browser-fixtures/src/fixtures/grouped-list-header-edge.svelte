<script lang="ts">
  import { GroupedList, GroupedListItem, PageHeader, Section } from '@lostgradient/cinder';
</script>

<!-- COR-2768: a GroupedList's header and footer are outside its surface, so their text shares the
     page edge (the surface's own edge) with the page heading; the rows keep their inset. -->
{#snippet rows()}
  <GroupedListItem href="/workflows/1">
    {#snippet title()}Order fulfilment{/snippet}
    {#snippet subtitle()}Running{/snippet}
  </GroupedListItem>
  <GroupedListItem href="/workflows/2">
    {#snippet title()}Invoice reminder{/snippet}
    {#snippet subtitle()}Waiting on a signal{/snippet}
  </GroupedListItem>
{/snippet}

<div class="example-frame">
  <div data-testid="alone">
    <GroupedList header="Needs attention" footer="Two workflows are waiting.">
      {@render rows()}
    </GroupedList>
  </div>

  <div data-testid="in-page">
    <PageHeader title="Attention" headingLevel={2} />
    <Section title="Waiting on you" level={3}>
      <GroupedList header="Needs attention" footer="Two workflows are waiting.">
        {@render rows()}
      </GroupedList>
    </Section>
  </div>

  <div data-testid="rtl" dir="rtl">
    <GroupedList header="Needs attention" footer="Two workflows are waiting.">
      {@render rows()}
    </GroupedList>
  </div>
</div>

<style>
  .example-frame {
    display: grid;
    gap: var(--cinder-space-6);
  }
</style>
