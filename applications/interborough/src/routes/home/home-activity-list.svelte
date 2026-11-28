<script lang="ts">
  /**
   * The rows of one of Home's activity bands (COR-2227): one Cinder `GroupedList` of Cinder
   * `GroupedListItem` rows, the row Home's other lists use, with no row markup or styling of its
   * own. Each row is the kind's glyph on the title's first line, the title in at most two lines, a
   * status badge for a warning or critical event leading line two with the body after a comma
   * (at most two lines), and the time at the end ("10:42 AM", "Yesterday, 4:12 PM", "Thu, Oct 29,
   * 4:12 PM"). An event the application could not word keeps its plain title.
   * A row with a link is one link, opened inside the application; one without keeps the chevron's
   * column, so every time ends on one edge. Clamped text reads in one tooltip on the row.
   *
   * The list is not a live region: an arrival is not announced, never moves focus and never
   * scrolls the page, and while focus, a hovering pointer or a press is in the list the rows hold
   * still (`ActivityFeed.hold`); while the bands are stacked, the other band's rows hold too.
   */
  import { Badge, GroupedList, GroupedListItem } from '@lostgradient/cinder';

  import { rowTime } from '../../lib/format/clock.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { ActivityFeed } from './home-activity-feed.svelte.ts';
  import { lineTwoText, tierWord } from './home-activity-rows.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';

  interface HomeActivityListProps {
    /** The band's rows. */
    feed: ActivityFeed;
    /** The list's accessible name. */
    listLabel: string;
  }

  let { feed, listLabel }: HomeActivityListProps = $props();

  const clock = useMinuteClock();
</script>

<div {@attach feed.hold}>
  <GroupedList aria-label={listLabel}>
    {#each feed.shown as entry (entry.key)}
      {@const Icon = entry.icon}
      {@const word = tierWord(entry.tier)}
      {@const lineTwo = lineTwoText(entry)}
      {#snippet lineTwoLine()}
        {#if word !== undefined}
          <Badge variant={entry.tier === 'critical' ? 'danger' : 'warning'} size="xs">{word}</Badge
          >{#if entry.body !== undefined}, {entry.body}{/if}
        {:else}
          {entry.body}
        {/if}
      {/snippet}
      <GroupedListItem
        data-activity={entry.key}
        {...entry.href === undefined ? {} : { href: router.href(entry.href) }}
        subtitleLines={2}
        {...lineTwo === undefined ? {} : { subtitle: lineTwoLine, subtitleTooltip: lineTwo }}
        chevronColumn
        titleLines={2}
        tooltip={entry.title}
        arriving={feed.arrived.has(entry.key)}
      >
        {#snippet leading()}<Icon aria-hidden="true" size={16} />{/snippet}
        {#snippet title()}{entry.title}{/snippet}
        {#snippet trailing()}
          <time datetime={new Date(entry.at).toISOString()}>{rowTime(entry.at, clock())}</time>
        {/snippet}
      </GroupedListItem>
    {/each}
  </GroupedList>
</div>
