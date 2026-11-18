<script lang="ts">
  import { DescriptionList } from '@lostgradient/description-list/components/description-list/index.ts';
  import { InspectorRow } from '../inspector-row/index.ts';

  import { Inspector } from './index.ts';

  let title = $state('Spring menu launch');
  let status = $state('open');
  let due = $state('2026-11-30');
  let notify = $state(true);
</script>

<div class="inspector-fixture-page">
  <div class="inspector-fixture" data-testid="inspector-detail-page">
    <div class="inspector-fixture__content" data-testid="inspector-detail-content">
      <h2 class="inspector-fixture__title">{title}</h2>
      <p class="inspector-fixture__body">
        Three new dishes go on the menu on the first of the month. The kitchen needs the final
        recipes a week before, and the front of house needs the tasting notes the same day.
      </p>
      <DescriptionList
        variant="fields"
        framed
        data-testid="inspector-detail-facts"
        items={[
          { term: 'Owner', definition: 'Ada Lovelace', href: '#owner' },
          { term: 'Kitchen', definition: 'Central commissary' },
        ]}
      />
    </div>
    <div class="inspector-fixture__rail" data-testid="inspector-detail-rail">
      <Inspector header="Details">
        <InspectorRow
          label="Title"
          kind="text"
          current={title}
          onCommit={(next) => (title = String(next))}
        >
          {#snippet value()}{title}{/snippet}
        </InspectorRow>
        <InspectorRow
          label="Status"
          kind="select"
          current={status}
          options={[
            { value: 'open', label: 'Open' },
            { value: 'closed', label: 'Closed' },
          ]}
          onCommit={(next) => (status = String(next))}
        >
          {#snippet value()}{status === 'open' ? 'Open' : 'Closed'}{/snippet}
        </InspectorRow>
        <InspectorRow
          label="Due"
          kind="date"
          current={due}
          onCommit={(next) => (due = String(next))}
        >
          {#snippet value()}{due}{/snippet}
        </InspectorRow>
        <InspectorRow
          label="Notify"
          kind="toggle"
          current={notify}
          onCommit={(next) => (notify = next === true)}
        >
          {#snippet value()}{notify ? 'On' : 'Off'}{/snippet}
        </InspectorRow>
        <InspectorRow label="Created">
          {#snippet value()}Nov 10, 2026{/snippet}
        </InspectorRow>
      </Inspector>
    </div>
  </div>
</div>

<style>
  /* The page a detail inspector sits on: the content, then the properties as a right rail. Below
   * 700px of the page, where InspectorRow stacks its labels on a phone, the rail becomes a section
   * under the content. The page is the container, so the fixture reads its own width. */
  .inspector-fixture {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 20rem;
    align-items: start;
    gap: var(--cinder-space-6);
  }

  .inspector-fixture__content {
    min-inline-size: 0;
  }

  .inspector-fixture__title {
    margin: 0 0 var(--cinder-space-2);
    font-size: var(--cinder-text-xl);
    font-weight: var(--cinder-font-semibold);
    color: var(--cinder-text-default);
  }

  .inspector-fixture__body {
    margin: 0 0 var(--cinder-space-4);
    color: var(--cinder-text-default);
  }

  .inspector-fixture-page {
    container-type: inline-size;
  }

  @container (width < 700px) {
    .inspector-fixture {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
