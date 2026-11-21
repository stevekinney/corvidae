<script lang="ts">
  /**
   * The bars, card and form placeholders, each drawn twice: still loading, with the slow-load line
   * and its Cancel, and plain beside it, so the layout test can measure that the line holds its
   * place (the two are as tall) and that Cancel is never cut short on a phone (COR-2489). The list
   * variant with a leading day band shows the line under the band.
   */
  import { Skeleton } from './index.ts';
  import type { SkeletonProps } from './skeleton.types.ts';

  const label = 'Still loading. This is taking longer than usual.';
  const samples: { name: string; props: SkeletonProps }[] = [
    { name: 'bars', props: { lines: 3 } },
    { name: 'card', props: { variant: 'card', lines: 3 } },
    { name: 'form', props: { variant: 'form', rows: 2 } },
  ];
</script>

<div class="skeleton-still-loading">
  {#each samples as sample (sample.name)}
    <section data-testid={`still-loading-${sample.name}`}>
      <div data-testid="slow">
        <Skeleton
          {...sample.props}
          stillLoadingAfter={0}
          stillLoadingLabel={label}
          onCancel={() => {}}
        />
      </div>
      <div data-testid="plain">
        <Skeleton {...sample.props} />
      </div>
    </section>
  {/each}
  <section data-testid="still-loading-day-band">
    <Skeleton
      variant="list"
      rows={2}
      dayBandLabel="Today, Monday, Nov 2"
      stillLoadingAfter={0}
      stillLoadingLabel="Still loading runs. This is taking longer than usual."
      onCancel={() => {}}
    />
  </section>
</div>

<style>
  .skeleton-still-loading {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    padding: var(--cinder-space-4);
  }

  section {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }
</style>
