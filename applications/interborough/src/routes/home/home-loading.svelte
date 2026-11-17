<script lang="ts">
  /**
   * Home while its first reads are out: the page's own layout with placeholders where the data
   * goes, so nothing moves when it arrives. The date line, the count's label and the section
   * headings are real text; the Spotlight, the count's value, the rows and the composer are
   * placeholders, the rows in Cinder's grouped shape. The Needs you rows have no heading, as the
   * loaded ones do: the Spotlight is their title. Cinder's `skeleton` owns the timing: nothing
   * is drawn for the first 300 ms, so a load that is quick never flashes a placeholder, and after
   * 10 s its own status line says the load is slow, with a ghost Cancel, in the Spotlight
   * placeholder's place, so the page does not move when it appears. The placeholders shimmer,
   * and are still under `prefers-reduced-motion`.
   */
  import { Skeleton, Stack, Statistic, StatisticGroup } from '@lostgradient/cinder';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { dateLine, timesShowIn } from '../../lib/format/clock.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCard from './home-card.svelte';
  import HomeLayout from './home-layout.svelte';
  import { START_CHAT_MESSAGE_HEIGHT } from './home-start-chat.ts';

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
      <div data-testid="home-loading-focus">
        <!-- One line of the Spotlight (32px type at its 1.1 leading), so nothing moves when it
             arrives. It is the page's first placeholder, so after 10 s the "Still loading" line
             takes its place and nothing moves then either (COR-2329). -->
        <Skeleton width="11rem" height="2.2rem" radius="var(--cinder-radius-md)" holdsStatusLine />
      </div>
    {/snippet}
    {#snippet primary()}
      <!-- The Spotlight is the list's title, so the placeholder rows sit under its placeholder with
           no heading, as the loaded rows do. -->
      <div data-home-card={HOME_COPY.needsYou.title}>
        <Skeleton variant="grouped" rows={2} action />
      </div>
    {/snippet}
    {#snippet counts()}
      <!-- The count follows the list, as the loaded count does. -->
      <StatisticGroup
        label={HOME_COPY.countsLabel}
        columns={1}
        variant="plain"
        data-testid="home-loading-counts"
      >
        <Statistic label={HOME_COPY.counts.failed} value="" loading />
      </StatisticGroup>
    {/snippet}
    {#snippet attention()}
      <HomeCard title={HOME_COPY.attention.title}>
        <Skeleton variant="grouped" rows={3} action />
      </HomeCard>
    {/snippet}
    {#snippet startChatAside()}
      <HomeCard title={HOME_COPY.startChat.title}>
        <Stack gap="var(--cinder-space-3)">
          <!-- As tall as the message box it stands for: Cinder's Textarea is 6rem at least, and the
               box's three-line placeholder sits inside that, so nothing below moves when the box
               arrives (COR-2489: the placeholder was 4.75rem). -->
          <Skeleton height={START_CHAT_MESSAGE_HEIGHT} radius="var(--cinder-radius-md)" />
          <Stack direction="row" justify="between" align="center" gap="var(--cinder-space-3)">
            <!-- The agent picker is a small Select, which takes the small control height, and Send a
                 Button at its painted height. -->
            <Skeleton
              width="8.25rem"
              height="var(--cinder-control-height-sm)"
              radius="var(--cinder-radius-md)"
            />
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
