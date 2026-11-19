<script lang="ts">
  /**
   * The layout Home's overview sits in, shared by the page and by its loading placeholders so the
   * two are the same layout and nothing moves when data arrives: the date line, the Spotlight, then
   * two columns. The wide one holds what needs you with the one count after it, what is running,
   * what needs attention and the two activity bands; the narrow one holds the chat sections, the
   * box that starts a chat over the chats you were last in (owner, 2026-11-19: with Recent chats
   * across the full width under both columns, the shorter column left a dead band above it). No
   * section spans both columns, so nothing waits under the shorter one. On a phone every section is
   * a row of one column, in the order the Spotlight, Needs you, the count, Running now, the box that
   * starts a chat, Needs attention, Recent chats, Workflow activity, Agent activity.
   *
   * The sections draw no box (Cinder's `Section`), so space alone separates them, and the space
   * between any two is one value, Cinder's own space between sections (`--cinder-space-8`). A
   * section with nothing to say draws nothing, and its place takes no gap.
   *
   * The first-run checklist is not drawn here: it is the whole page (`home-first-run.svelte`).
   */
  import type { Snippet } from 'svelte';

  import { ActivityRegion, provideActivityRegion } from './home-activity-feed.svelte.ts';

  interface HomeLayoutProps {
    /** `data-mode` on the page: `overview` or `loading`. */
    mode: string;
    /** Marks the page region busy, while placeholders stand in for the cards. */
    busy?: boolean;
    /** The line that leads the page. */
    date: Snippet;
    /** The Spotlight, or the one quiet line when nothing needs you. */
    focus?: Snippet | undefined;
    /** What needs you. */
    primary?: Snippet | undefined;
    /** The one count, after the list the Spotlight titles. */
    counts?: Snippet | undefined;
    /** The Running now card, while a run is going. */
    running?: Snippet | undefined;
    /** What needs attention. */
    attention?: Snippet | undefined;
    /** The box that starts a chat, at the head of the narrow column. */
    startChatAside?: Snippet | undefined;
    /** The chats last in, under the box that starts a chat. */
    recent: Snippet;
    /** Workflow activity, the first of the two activity bands, last in the wide column. */
    workflowActivity?: Snippet | undefined;
    /** Agent activity, the second activity band, under Workflow activity. */
    agentActivity?: Snippet | undefined;
  }

  let {
    mode,
    busy = false,
    date,
    focus,
    primary,
    counts,
    running,
    attention,
    startChatAside,
    recent,
    workflowActivity,
    agentActivity,
  }: HomeLayoutProps = $props();

  // The bands read from the region whether they are stacked, where the hold of either holds both.
  const activityRegion = new ActivityRegion();
  provideActivityRegion(activityRegion);
</script>

<div class="ib-home" data-page="home" data-mode={mode} aria-busy={busy ? 'true' : undefined}>
  <p class="ib-home__date" data-testid="home-date">{@render date()}</p>
  {#if focus}<div class="ib-home__focus">{@render focus()}</div>{/if}
  <div class="ib-home__columns">
    <div class="ib-home__main">
      {#if primary}<div class="ib-home__needs-you">{@render primary()}</div>{/if}
      <!-- The count follows the list the Spotlight titles, never between the two (owner decision
           2026-11-16). -->
      {#if counts}<div class="ib-home__counts">{@render counts()}</div>{/if}
      {#if running}<div class="ib-home__running">{@render running()}</div>{/if}
      {#if attention}<div class="ib-home__needs-attention">{@render attention()}</div>{/if}
      {#if workflowActivity || agentActivity}
        <!-- Each band sits in its own wrapper, as every other region does: two adjacent Cinder
             Sections take Cinder's space between sections as a margin, which this region's gap
             already gives them. -->
        <div class="ib-home__activity" data-testid="home-activity">
          <div class="ib-home__activity-bands" {@attach activityRegion.attach}>
            {#if workflowActivity}
              <div class="ib-home__activity-band">{@render workflowActivity()}</div>
            {/if}
            {#if agentActivity}
              <div class="ib-home__activity-band">{@render agentActivity()}</div>
            {/if}
          </div>
        </div>
      {/if}
    </div>
    <div class="ib-home__aside">
      {#if startChatAside}<div class="ib-home__start-chat">{@render startChatAside()}</div>{/if}
      <div class="ib-home__recent">{@render recent()}</div>
    </div>
  </div>
</div>

<style>
  /* One value for the space between any two sections (owner, 2026-11-19). */
  .ib-home {
    --ib-home-gap: var(--cinder-space-8);

    display: flex;
    flex-direction: column;
    gap: var(--ib-home-gap);
    min-inline-size: 0;
  }

  .ib-home__date {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-base);
  }

  /* A section with nothing to say draws nothing, and its place takes no gap. */
  .ib-home > .ib-home__focus:not(:has(*)),
  .ib-home__main > :not(:has(*)),
  .ib-home__aside > :not(:has(*)) {
    display: none;
  }

  /* On a phone every section is a row of one column, in the order the page lists them. The two
   * columns' sections share a parent only for the wide layout, so on a phone those parents drop out
   * of the box tree and the sections are ordered as the columns' own children. */
  .ib-home__columns {
    display: flex;
    flex-direction: column;
    gap: var(--ib-home-gap);
    min-inline-size: 0;
  }

  .ib-home__main,
  .ib-home__aside {
    display: contents;
  }

  .ib-home__needs-you {
    order: 1;
  }

  /* The count keeps the list's place in the order, after it in the markup, so it follows the list
   * on a phone as it does in the wide column. */
  .ib-home__counts {
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

  .ib-home__recent {
    order: 5;
  }

  /* The activity bands (COR-2227), the page's last region: stacked, Workflow activity over Agent
   * activity, until the region itself is wide enough for two rows in their wide shape (two 26rem
   * rows and the gap), then side by side in two equal columns, each band at its own height. The
   * switch follows the region's width, never the viewport's, so the sidebar opening or closing
   * never leaves two bands side by side in their narrow row shape. */
  .ib-home__activity {
    order: 6;
    container: ib-home-activity / inline-size;
    min-inline-size: 0;
  }

  .ib-home__activity-bands {
    display: flex;
    flex-direction: column;
    gap: var(--ib-home-gap);
    min-inline-size: 0;
  }

  .ib-home__activity-band {
    min-inline-size: 0;
  }

  @container ib-home-activity (width >= 54rem) {
    .ib-home__activity-bands {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      column-gap: var(--ib-home-gap);
      align-items: start;
    }
  }

  /* Two columns on a tablet or desktop: what needs you, what is running, what needs attention and
   * the activity in the wide one, the chat sections in the narrow one beside them. */
  @media (min-width: 64rem) {
    .ib-home__columns {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 23.75rem;
      column-gap: var(--ib-home-gap);
      align-items: start;
    }

    /* The Spotlight is the title of the Needs you list in the wide column, so its line, and the
     * link to Reviews at the end of it, is that column's width: the link ends where the list does. */
    .ib-home__focus {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 23.75rem;
      column-gap: var(--ib-home-gap);
    }

    .ib-home__main,
    .ib-home__aside {
      display: flex;
      flex-direction: column;
      gap: var(--ib-home-gap);
      min-inline-size: 0;
    }
  }
</style>
