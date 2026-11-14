<script lang="ts">
  /**
   * Home while its first reads are out: the page's own layout with placeholders where the data
   * goes, so nothing moves when it arrives. The date line, the count's label and the section
   * headings are real text; the Spotlight, the count's value, the rows and the composer are
   * placeholders, the rows in Cinder's grouped shape. Cinder's `skeleton` owns the timing: nothing
   * is drawn for the first 300 ms, so a load that is quick never flashes a placeholder, and after
   * 10 s its own status line says the load is slow, with a ghost Cancel. The placeholders shimmer,
   * and are still under `prefers-reduced-motion`.
   */
  import { Skeleton, Stack, Statistic, StatisticGroup } from '@lostgradient/cinder';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { dateLine, timesShowIn } from '../../lib/format/clock.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeLayout from './home-layout.svelte';

  interface HomeLoadingProps {
    /** Called when the person cancels a load that is taking long. */
    onCancel: () => void;
  }

  let { onCancel }: HomeLoadingProps = $props();

  const clock = useMinuteClock();
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
    {#snippet focus()}
      <Stack gap="var(--cinder-space-4)" data-testid="home-loading-focus">
        <Skeleton width="11rem" height="2.25rem" radius="var(--cinder-radius-md)" />
        <StatisticGroup
          label={HOME_COPY.countsLabel}
          columns={1}
          variant="plain"
          data-testid="home-loading-counts"
        >
          <Statistic label={HOME_COPY.counts.failed} value="" loading />
        </StatisticGroup>
      </Stack>
    {/snippet}
    {#snippet primary()}
      <HomeCard title={HOME_COPY.needsYou.title}>
        <Skeleton variant="grouped" rows={2} action />
      </HomeCard>
    {/snippet}
    {#snippet attention()}
      <HomeCard title={HOME_COPY.attention.title}>
        <Skeleton variant="grouped" rows={3} action />
      </HomeCard>
    {/snippet}
    {#snippet startChatAside()}
      <HomeCard title={HOME_COPY.startChat.title}>
        <Stack gap="var(--cinder-space-3)">
          <Skeleton height="4.75rem" radius="var(--cinder-radius-md)" />
          <Stack direction="row" justify="between" align="center" gap="var(--cinder-space-3)">
            <Skeleton width="8.25rem" height="2rem" radius="var(--cinder-radius-md)" />
            <Skeleton width="4.75rem" height="2rem" radius="var(--cinder-radius-md)" />
          </Stack>
        </Stack>
      </HomeCard>
    {/snippet}
    {#snippet recent()}
      <HomeCard title={HOME_COPY.recent.title}><Skeleton variant="grouped" rows={3} /></HomeCard>
    {/snippet}
  </HomeLayout>
</Skeleton>
