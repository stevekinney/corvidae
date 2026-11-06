<script lang="ts">
  /**
   * `/`: Home, the first item in the sidebar and the page the app opens on. Its heading is Cinder's
   * `visually-hidden` wrapper, so the page shows no heading of its own: the breadcrumb already says
   * "Home", and Home's heading row carries no status or actions. The date line leads the content,
   * then four counts in one row (the labels and windows Health uses), then two columns: what needs
   * you, what is running and what needs attention at the left, the box that starts a chat at the
   * right, and the chats you were last in across the full width below.
   *
   * Each card reads on its own, so one that cannot be read says so in its own place and the rest
   * stay live. On a phone the cards stack in the order counts, Needs you, Running now, Start a chat,
   * Needs attention, Recent chats. Running now is there only while a run is going.
   *
   * On a new installation the page is the first-run checklist instead (`useHomeFirstRun`): it
   * leads with "Welcome. …" in place of the date line, and the counts, Needs you and the provider
   * notice give way to the checklist, whose first step says the notice. The box that starts a chat
   * comes back below the checklist once a provider is connected, and Recent chats says there are
   * none yet. Until the
   * three answers the checklist is made of are in, nothing is drawn, so the overview is never drawn
   * only to be replaced.
   */
  import { VisuallyHidden } from '@lostgradient/cinder';

  import { HOME_COPY } from '../../app/copy.ts';
  import { dateLine, timesShowIn } from '../../lib/format/clock.ts';
  import { useMinuteClock } from './home-clock.svelte.ts';
  import HomeCounts from './home-counts.svelte';
  import HomeFirstRun from './home-first-run.svelte';
  import { useHomeFirstRun } from './home-first-run.svelte.ts';
  import HomeNeedsAttention from './home-needs-attention.svelte';
  import HomeNeedsYou from './home-needs-you.svelte';
  import { useAttentionItems, useRunningTasks } from './home-queries.svelte.ts';
  import HomeRecentChats from './home-recent-chats.svelte';
  import HomeRunningNow from './home-running-now.svelte';
  import HomeStartChat from './home-start-chat.svelte';

  // The day and the zone's name follow the clock the page reads, so a page left open past midnight
  // says the new day.
  const clock = useMinuteClock();
  const firstRun = useHomeFirstRun();
  const running = useRunningTasks();
  const attention = useAttentionItems();

  const mode = $derived(firstRun.mode());
  // Running now is a card only while a run is going.
  const runningNow = $derived(running.data ?? []);
  // While the checklist shows, its first step says there is no provider, so only the other
  // problems are worth a card of their own.
  const otherProblems = $derived(
    (attention.data ?? []).some((item) => item.kind !== 'no-provider'),
  );
</script>

<VisuallyHidden as="h1">{HOME_COPY.heading}</VisuallyHidden>

{#if mode !== 'pending'}
  <div class="ib-home" data-page="home" data-mode={mode}>
    <p class="ib-home__date" data-testid="home-date">
      {#if mode === 'checklist'}
        {HOME_COPY.firstRun.lead(firstRun.left())}
      {:else}
        {dateLine(clock())} · {timesShowIn(clock())}
      {/if}
    </p>
    {#if mode === 'overview'}
      <HomeCounts />
    {/if}
    <div class="ib-home__columns">
      <div class="ib-home__main">
        <div class="ib-home__needs-you">
          {#if mode === 'checklist'}
            <HomeFirstRun
              steps={firstRun.steps()}
              assistant={firstRun.assistant()}
              onUseAssistant={firstRun.useAssistant}
            />
          {:else}
            <HomeNeedsYou />
          {/if}
        </div>
        {#if mode === 'overview' && runningNow.length > 0}
          <div class="ib-home__running"><HomeRunningNow tasks={runningNow} /></div>
        {/if}
        <!-- While the checklist shows, the box that starts a chat sits under it, in the same column. -->
        {#if mode === 'checklist' && firstRun.providerConnected()}
          <div class="ib-home__start-chat"><HomeStartChat /></div>
        {/if}
        {#if mode === 'overview' || otherProblems}
          <div class="ib-home__needs-attention">
            <HomeNeedsAttention omitProviderNotice={mode === 'checklist'} />
          </div>
        {/if}
      </div>
      {#if mode === 'overview'}
        <div class="ib-home__start-chat"><HomeStartChat /></div>
      {/if}
    </div>
    <HomeRecentChats />
  </div>
{/if}

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

  /* On a phone every card is a row of one column, in the order the page lists them: what needs you,
   * what is running, the box that starts a chat, then what needs attention. The left column's cards
   * share a parent only for the wide layout, so on a phone that parent drops out of the box tree and
   * the cards are ordered as the parent's own children. */
  .ib-home__columns {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-inline-size: 0;
  }

  .ib-home__main {
    display: contents;
  }

  .ib-home__needs-you {
    order: 1;
  }

  .ib-home__running {
    order: 2;
  }

  .ib-home__start-chat {
    order: 3;
  }

  .ib-home__needs-attention {
    order: 4;
  }

  /* Two columns on a tablet or desktop: what needs you, what is running and what needs attention in
   * the wide one, the box that starts a chat in the narrow one beside them. */
  @media (min-width: 64rem) {
    .ib-home__columns {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 23.75rem;
      align-items: start;
    }

    .ib-home__main {
      display: flex;
      flex-direction: column;
      gap: var(--cinder-space-4);
      min-inline-size: 0;
    }

    /* The overview's box that starts a chat is the right column; under the checklist it is the
     * left column's own card, so only a direct child of the columns is placed. */
    .ib-home__columns > .ib-home__start-chat {
      grid-column: 2;
      grid-row: 1;
    }
  }
</style>
