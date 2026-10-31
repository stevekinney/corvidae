<script lang="ts">
  /**
   * Recent activity on the Health overview: a fixed window of the latest six lines, never a growing
   * list. It starts from the frames the shell's fleet feed has already seen
   * (`FleetEventSource.recent`), so a page opened after the feed began does not start empty, and
   * then follows the feed live, batched to 100ms with a "+N new events" pause-to-read affordance.
   * Repeats in a row collapse into one line with a count (`activity-feed-batcher.svelte.ts`), and
   * the footer link opens the audit log. One live indicator says whether the feed is connected.
   *
   * **Shares the shell's one connection.** Plan §5 and `FleetEventSource`'s
   * own module doc require exactly ONE fleet SSE connection, fanned out to
   * every consumer (dashboard feed, task evidence, list liveness).
   * `Shell` (`src/app/shell/shell.svelte`) constructs the one
   * `EngineStatusController` and provides its `fleetSource` via
   * `provideFleetEventSource()` (`src/app/engine-status.svelte.ts`); this
   * band reads it back with `getFleetEventSource()` and only `subscribe()`s
   * — the same pattern the Workflows and Schedules tracks already use
   * (`workflow-list.svelte`, `workflow-detail.svelte`, `schedule-detail.svelte`).
   * `FleetEventSource` is designed for exactly this fan-out: the connection
   * opens lazily on first `subscribe()` and stays open as long as ANY
   * subscriber remains, so this band must only `unsubscribe()` on unmount —
   * never `close()` the shared source, which would tear down the shell's
   * bell/notification feed too.
   */
  import type { LucideIcon } from '@lucide/svelte';
  import { untrack } from 'svelte';
  import {
    Ban,
    CalendarClock,
    CalendarX,
    CheckCheck,
    CircleAlert,
    CircleCheck,
    CircleX,
    ClockAlert,
    Database,
    FileCheck,
    HardDrive,
    Pause,
    Pencil,
    Play,
    Plug,
    PlugZap,
    Radio,
    ShieldAlert,
    Siren,
    Tag,
    Trash,
    TriangleAlert,
    UserCheck,
  } from '@lucide/svelte';

  import {
    ConnectionIndicator,
    EmptyState,
    Feed,
    FeedEvent,
    Link,
    SectionHeading,
    Skeleton,
  } from '@lostgradient/cinder';

  import { getFleetEventSource } from '../../app/engine-status.svelte.ts';
  import { classifyFleetEvent } from '../../app/fleet-event-classification.ts';
  import { HEALTH_OVERVIEW_COPY } from '../../app/copy.ts';
  import { formatRelativeTime } from '../../lib/format/index.ts';
  import type { FleetEventFrame } from '../../lib/live-source/fleet-event-source.svelte.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { ActivityFeedBatcher, type ActivityFeedRow } from './activity-feed-batcher.svelte.ts';

  /** The whole trail, which the footer link opens. */
  const AUDIT_PATH = '/health/audit';

  const source = getFleetEventSource();
  const batcher = new ActivityFeedBatcher();

  function rowOf(frame: FleetEventFrame): ActivityFeedRow | null {
    const classified = classifyFleetEvent(frame);
    return classified === null ? null : { id: frame.cursor, ...classified };
  }

  $effect(() => {
    // What already happened first, then what follows. `recent` and `subscribe` run in one task, so
    // no frame falls between them.
    // `seed` reads the window it fills, so it runs untracked: an effect that reads what it writes
    // would run again forever.
    untrack(() =>
      batcher.seed(
        source
          .recent()
          .map(rowOf)
          .filter((row): row is ActivityFeedRow => row !== null),
      ),
    );
    const unsubscribe = source.subscribe((frame) => {
      const row = rowOf(frame);
      if (row !== null) batcher.ingest(row);
    });

    return () => {
      unsubscribe();
      batcher.dispose();
    };
  });

  /** The icon each `classifyFleetEvent` icon name stands for. */
  const ICONS: Readonly<Record<string, LucideIcon>> = {
    siren: Siren,
    'circle-alert': CircleAlert,
    'circle-x': CircleX,
    'calendar-x': CalendarX,
    'shield-alert': ShieldAlert,
    database: Database,
    'user-check': UserCheck,
    'check-check': CheckCheck,
    plug: Plug,
    'plug-zap': PlugZap,
    play: Play,
    'circle-check': CircleCheck,
    ban: Ban,
    'clock-alert': ClockAlert,
    pause: Pause,
    'trash-2': Trash,
    radio: Radio,
    tag: Tag,
    pencil: Pencil,
    'file-check': FileCheck,
    'calendar-clock': CalendarClock,
    'triangle-alert': TriangleAlert,
    'hard-drive': HardDrive,
  };

  function iconFor(name: string): LucideIcon {
    return ICONS[name] ?? TriangleAlert;
  }

  function goTo(href: string): void {
    router.navigate(href);
  }
</script>

<section class="weft-activity" aria-label={HEALTH_OVERVIEW_COPY.activity.title}>
  <SectionHeading level={2} title={HEALTH_OVERVIEW_COPY.activity.title}>
    {#snippet actions()}
      <ConnectionIndicator status={source.status} />
    {/snippet}
  </SectionHeading>

  <div
    class="weft-activity-feed"
    role="group"
    aria-label={HEALTH_OVERVIEW_COPY.activity.windowLabel}
    onmouseenter={() => batcher.pause()}
    onmouseleave={() => batcher.resume()}
    onfocusin={() => batcher.pause()}
    onfocusout={() => batcher.resume()}
  >
    {#if batcher.pendingCount > 0}
      <button type="button" class="weft-activity-feed__pending" onclick={() => batcher.resume()}>
        +{batcher.pendingCount} new {batcher.pendingCount === 1 ? 'event' : 'events'}
      </button>
    {/if}

    {#if batcher.items.length === 0}
      {#if source.status === 'connecting'}
        <div class="weft-activity-feed__skeleton" aria-busy="true" aria-label="Loading activity">
          <Skeleton height="1.2rem" />
          <Skeleton height="1.2rem" />
          <Skeleton height="1.2rem" />
        </div>
      {:else}
        <EmptyState
          kind="first-use"
          size="compact"
          headingLevel={3}
          title={HEALTH_OVERVIEW_COPY.activity.emptyTitle}
          description={HEALTH_OVERVIEW_COPY.activity.emptyDescription}
        />
      {/if}
    {:else}
      <Feed live class="weft-activity-feed__list">
        {#each batcher.items as item (item.id)}
          {@const Icon = iconFor(item.icon)}
          <FeedEvent datetime={new Date(item.emittedAtMs).toISOString()} timestamp="">
            {#snippet icon()}
              <Icon aria-hidden="true" size={14} />
            {/snippet}
            <a
              href={router.href(item.href)}
              class="weft-activity-feed__row"
              data-tier={item.tier}
              onclick={(event) => {
                event.preventDefault();
                goTo(item.href);
              }}
            >
              <span class="weft-activity-feed__text">
                {item.count > 1
                  ? HEALTH_OVERVIEW_COPY.activity.repeated(item.title, item.count)
                  : item.title}
                <span class="weft-activity-feed__detail">{item.body}</span>
              </span>
              <span class="weft-activity-feed__time">{formatRelativeTime(item.emittedAtMs)}</span>
            </a>
          </FeedEvent>
        {/each}
      </Feed>
    {/if}
  </div>

  <p class="weft-activity__footer">
    <Link
      href={router.href(AUDIT_PATH)}
      onclick={(event) => {
        if (
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey ||
          event.button !== 0
        ) {
          return;
        }
        event.preventDefault();
        goTo(AUDIT_PATH);
      }}>{HEALTH_OVERVIEW_COPY.activity.auditLink}</Link
    >
  </p>
</section>
