<script lang="ts">
  /**
   * The layout Home's sections sit in, shared by the page and by its loading placeholders so the
   * two are the same layout and nothing moves when data arrives: the date line, the Spotlight, then
   * two columns (what needs you with the one count after it, what is running and what needs
   * attention at the left, the box that starts a chat at the right) and the chats you were last in
   * across the full width below, then the two activity bands, the last region. On a phone every
   * section is a row of one column, in the order the Spotlight, Needs you, the count, Running now,
   * the box that starts a chat, Needs attention, Recent chats, Workflow activity, Agent activity.
   * While the first-run
   * checklist shows the box that starts a chat sits under it, in the left column.
   *
   * The sections draw no box (Cinder's `Section`), so space alone separates them: the gap between
   * two sections is Cinder's own space between sections (`--cinder-space-8`).
   */
  import type { Snippet } from 'svelte';

  import { ActivityRegion, provideActivityRegion } from './home-activity-feed.svelte.ts';

  interface HomeLayoutProps {
    /** `data-mode` on the page: `overview`, `checklist` or `loading`. */
    mode: string;
    /** Marks the page region busy, while placeholders stand in for the cards. */
    busy?: boolean;
    /** The line that leads the page. */
    date: Snippet;
    /** The Spotlight; the checklist has none. */
    focus?: Snippet | undefined;
    /** What needs you, or the checklist. */
    primary?: Snippet | undefined;
    /** The one count, after the list the Spotlight titles; the checklist has none. */
    counts?: Snippet | undefined;
    /** The Running now card, while a run is going. */
    running?: Snippet | undefined;
    /** The box that starts a chat under the checklist, in the left column. */
    startChatBelow?: Snippet | undefined;
    /** What needs attention. */
    attention?: Snippet | undefined;
    /** The box that starts a chat in the right column. */
    startChatAside?: Snippet | undefined;
    /** The chats last in. */
    recent: Snippet;
    /**
     * Workflow activity, the first of the two activity bands in the page's last region; the
     * checklist has neither band.
     */
    workflowActivity?: Snippet | undefined;
    /** Agent activity, the second activity band, beside or under Workflow activity. */
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
    startChatBelow,
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
      <!-- While the checklist shows, the box that starts a chat sits under it, in the same column. -->
      {#if startChatBelow}<div class="ib-home__start-chat">{@render startChatBelow()}</div>{/if}
      {#if attention}<div class="ib-home__needs-attention">{@render attention()}</div>{/if}
    </div>
    {#if startChatAside}<div class="ib-home__start-chat">{@render startChatAside()}</div>{/if}
  </div>
  {@render recent()}
  {#if workflowActivity || agentActivity}
    <!-- Each band sits in its own wrapper, as every other region does: two adjacent Cinder
         Sections take Cinder's space between sections as a margin, which this region's gap
         already gives them, so side by side the second band started 32px lower and stacked the
         bands were 64px apart. -->
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

<style>
  .ib-home {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-inline-size: 0;
  }

  .ib-home__date {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-base);
  }

  /* A Spotlight that could not be read is left out, and its place takes no gap. */
  .ib-home > .ib-home__focus:not(:has(*)) {
    display: none;
  }

  /* On a phone every section is a row of one column, in the order the page lists them: what needs
   * you, what is running, the box that starts a chat, then what needs attention. The left column's
   * sections share a parent only for the wide layout, so on a phone that parent drops out of the box
   * tree and the sections are ordered as the parent's own children. */
  .ib-home__columns {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-8);
    min-inline-size: 0;
  }

  .ib-home__main {
    display: contents;
  }

  .ib-home__needs-you {
    order: 1;
  }

  /* With nothing waiting the Spotlight says so alone and the list draws nothing, so its place takes
   * no gap either. */
  .ib-home__needs-you:not(:has(*)) {
    display: none;
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

  /* The activity bands (COR-2227), the page's last region: stacked, Workflow activity over Agent
   * activity, until the region itself is wide enough for two rows in their wide shape (two 26rem
   * rows and the gap), then side by side in two equal columns, each band at its own height. The
   * switch follows the region's width, never the viewport's, so the sidebar opening or closing
   * never leaves two bands side by side in their narrow row shape. */
  .ib-home__activity {
    container: ib-home-activity / inline-size;
    min-inline-size: 0;
  }

  .ib-home__activity-bands {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-8);
    min-inline-size: 0;
  }

  .ib-home__activity-band {
    min-inline-size: 0;
  }

  @container ib-home-activity (width >= 54rem) {
    .ib-home__activity-bands {
      display: grid;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
      column-gap: var(--cinder-space-8);
      align-items: start;
    }
  }

  /* Two columns on a tablet or desktop: what needs you, what is running and what needs attention in
   * the wide one, the box that starts a chat in the narrow one beside them. */
  @media (min-width: 64rem) {
    .ib-home__columns {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 23.75rem;
      align-items: start;
    }

    /* The Spotlight is the title of the Needs you list in the wide column, so its line, and the
     * link to Reviews at the end of it, is that column's width: the link ends where the list does. */
    .ib-home__focus {
      display: grid;
      grid-template-columns: minmax(0, 1fr) 23.75rem;
      column-gap: var(--cinder-space-8);
    }

    .ib-home__main {
      display: flex;
      flex-direction: column;
      gap: var(--cinder-space-8);
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
