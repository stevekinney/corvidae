<script lang="ts">
  /**
   * `/`: Home, the first item in the sidebar and the page the app opens on. Its heading is Cinder's
   * `visually-hidden` wrapper, so the page shows no heading of its own: the breadcrumb already says
   * "Home", and Home's heading row carries no status or actions. The date line leads the content,
   * then four counts in one row (the labels and windows Health uses), then two columns: what needs
   * you and what needs attention at the left, the box that starts a chat at the right, and the
   * chats you were last in across the full width below.
   *
   * Each card reads on its own, so one that cannot be read says so in its own place and the rest
   * stay live. On a phone the cards stack in the order counts, Needs you, Start a chat, Needs
   * attention, Recent chats, which is the order they are written in here.
   */
  import { VisuallyHidden } from '@lostgradient/cinder';

  import { HOME_COPY } from '../../app/copy.ts';
  import { dateLine, timesShowIn } from '../../lib/format/clock.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCounts from './home-counts.svelte';
  import HomeNeedsAttention from './home-needs-attention.svelte';
  import HomeNeedsYou from './home-needs-you.svelte';
  import HomeRecentChats from './home-recent-chats.svelte';
  import HomeStartChat from './home-start-chat.svelte';

  // The day and the zone's name follow the clock the page reads, so a page left open past midnight
  // says the new day.
  const clock = useMinuteClock();
</script>

<VisuallyHidden as="h1">{HOME_COPY.heading}</VisuallyHidden>

<div class="ib-home" data-page="home">
  <p class="ib-home__date" data-testid="home-date">
    {dateLine(clock())} · {timesShowIn(clock())}
  </p>
  <HomeCounts />
  <div class="ib-home__columns">
    <div class="ib-home__needs-you"><HomeNeedsYou /></div>
    <div class="ib-home__start-chat"><HomeStartChat /></div>
    <div class="ib-home__needs-attention"><HomeNeedsAttention /></div>
  </div>
  <HomeRecentChats />
</div>

<style>
  .ib-home {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-inline-size: 0;
  }

  .ib-home__date {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-base);
  }

  /* Two columns on a tablet or desktop: what needs you and what needs attention in the wide one,
   * the box that starts a chat in the narrow one beside both. They are written in the phone's order
   * (Needs you, Start a chat, Needs attention), so the areas place them. */
  .ib-home__columns {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cinder-space-4);
    align-items: start;
  }

  @media (min-width: 64rem) {
    .ib-home__columns {
      grid-template-columns: minmax(0, 1fr) 23.75rem;
      /* The box that starts a chat spans both rows, and what it is taller than goes under the lists. */
      grid-template-rows: auto 1fr;
      grid-template-areas:
        'needs-you start-chat'
        'needs-attention start-chat';
    }

    .ib-home__needs-you {
      grid-area: needs-you;
    }

    .ib-home__start-chat {
      grid-area: start-chat;
    }

    .ib-home__needs-attention {
      grid-area: needs-attention;
    }
  }
</style>
