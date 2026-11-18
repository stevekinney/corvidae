<script lang="ts">
  /**
   * Home's Agent activity band (COR-2227): the newest three events of the Bureau's own feed (chats,
   * reviews, goals, schedules, hooks and plugins), worded through `bureau.events.format` in batches
   * of at most 200, newest first. An event no formatter claims, and every event of a format call
   * that failed, reads in plain words with its raw kind on line two, with no banner or error.
   *
   * The band reads its window from the shell's Bureau source, which keeps the replay it held back
   * (`BureauEventSource.recent`): when the band opens on a source that has caught up, when the
   * source catches up, and on every resync (`ActivityFeed`). Until the first window is read it holds
   * three placeholder rows, and after 10 seconds says it is still loading; a source whose connection
   * failed before then says so in the band's own place with Try again, which connects at once. Each
   * band keeps its own state, so the other band and the rest of Home are never held by this one.
   */
  import { EmptyState, Skeleton } from '@lostgradient/cinder';
  import { Bot } from '@lucide/svelte';
  import { untrack } from 'svelte';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import { useBureauEventSource } from '../../app/live-polling.svelte.ts';
  import {
    ActivityFeed,
    followBureauActivity,
    useActivityRegion,
  } from './home-activity-feed.svelte.ts';
  import HomeActivityList from './home-activity-list.svelte';
  import HomeCard from './home-card.svelte';
  import HomeCardError from './home-card-error.svelte';

  const copy = HOME_COPY.activity.bureau;
  const source = useBureauEventSource();
  const region = useActivityRegion();
  const feed = new ActivityFeed(region);
  const follower = source === undefined ? undefined : followBureauActivity(feed, source);
  // Outside the shell there is no feed to read, so the band says there is no activity.
  if (source === undefined) feed.replace([]);

  /**
   * The failed connections that do not count: those before the person last asked to try again. It
   * is the source's own count of failures, never its reconnect attempt, which a ping resets to 0,
   * so a connection that answers after Try again and then drops says so at once.
   */
  let failuresBefore = $state(0);
  const failed = $derived(
    source !== undefined &&
      !feed.ready &&
      source.reconnectAttempt > 0 &&
      source.failedConnections > failuresBefore,
  );

  $effect(() => region?.join(feed));
  $effect(() => untrack(() => follower?.start()));
  // Each time the source has caught up (when the band opens, and after every reconnect).
  $effect(() => {
    if (source?.caughtUp === true) untrack(() => follower?.readWindow());
  });

  function tryAgain(): void {
    if (source === undefined) return;
    failuresBefore = source.failedConnections;
    source.retryNow();
  }
</script>

<HomeCard title={copy.title}>
  {#if failed}
    <HomeCardError title={HOME_COPY.states.cardFailed.bureauActivity} onRetry={tryAgain} />
  {:else if !feed.ready}
    <Skeleton
      variant="grouped"
      rows={3}
      leading
      trailing
      chevronColumn
      stillLoadingAfter={10_000}
      stillLoadingLabel={copy.stillLoading}
    />
  {:else if feed.shown.length === 0}
    <EmptyState
      kind="first-use"
      layout="row"
      headingLevel={3}
      title={copy.empty.title}
      description={copy.empty.description}
    >
      <!-- First use draws its disc only with the view's own glyph. -->
      {#snippet icon()}<Bot aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else}
    <HomeActivityList {feed} listLabel={copy.listLabel} />
  {/if}
</HomeCard>
