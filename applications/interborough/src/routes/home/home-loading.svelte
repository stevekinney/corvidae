<script lang="ts">
  /**
   * Home while its first reads are out: the page's own layout with placeholders where the data
   * goes, so nothing moves when it arrives. The date line, the four count labels and the section
   * headings are real text; the count values, the rows and the composer are placeholders. Cinder's
   * `skeleton` owns the timing: nothing is drawn for the first 300 ms, so a load that is quick
   * never flashes a placeholder, and after 10 s its own status line says the load is slow, with a
   * ghost Cancel. The placeholders shimmer, and are still under `prefers-reduced-motion`.
   */
  import { Skeleton, Statistic, StatisticGroup } from '@lostgradient/cinder';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { dateLine, timesShowIn } from '../../lib/format/clock.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeLayout from './home-layout.svelte';
  import HomeSkeletonRows from './home-skeleton-rows.svelte';

  interface HomeLoadingProps {
    /** Called when the person cancels a load that is taking long. */
    onCancel: () => void;
  }

  let { onCancel }: HomeLoadingProps = $props();

  const clock = useMinuteClock();
  const labels = HOME_COPY.counts;
</script>

<Skeleton
  label={HOME_COPY.states.loadingLabel}
  delay={300}
  stillLoadingAfter={10_000}
  stillLoadingLabel={HOME_COPY.states.stillLoading}
  {onCancel}
>
  <HomeLayout mode="loading" busy>
    {#snippet date()}{dateLine(clock())}. {timesShowIn(clock())}.{/snippet}
    {#snippet counts()}
      <StatisticGroup
        label={HOME_COPY.countsLabel}
        columns={4}
        variant="cards"
        data-testid="home-loading-counts"
      >
        <Statistic label={labels.running} value="" loading />
        <Statistic label={labels.needsYou} value="" loading />
        <Statistic label={labels.failed} value="" loading />
        <Statistic label={labels.missed} value="" loading />
      </StatisticGroup>
    {/snippet}
    {#snippet primary()}
      <HomeCard title={HOME_COPY.needsYou.title}><HomeSkeletonRows rows={2} action /></HomeCard>
    {/snippet}
    {#snippet attention()}
      <HomeCard title={HOME_COPY.attention.title}><HomeSkeletonRows rows={3} action /></HomeCard>
    {/snippet}
    {#snippet startChatAside()}
      <HomeCard title={HOME_COPY.startChat.title}>
        <div class="ib-home-loading__composer">
          <Skeleton height="4.75rem" radius="var(--cinder-radius-md)" />
          <div class="ib-home-loading__controls">
            <Skeleton width="8.25rem" height="2rem" radius="var(--cinder-radius-md)" />
            <Skeleton width="4.75rem" height="2rem" radius="var(--cinder-radius-md)" />
          </div>
        </div>
      </HomeCard>
    {/snippet}
    {#snippet recent()}
      <HomeCard title={HOME_COPY.recent.title}><HomeSkeletonRows rows={3} /></HomeCard>
    {/snippet}
  </HomeLayout>
</Skeleton>

<style>
  .ib-home-loading__composer {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
  }

  .ib-home-loading__controls {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-3);
  }
</style>
