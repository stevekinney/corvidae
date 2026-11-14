<script lang="ts">
  /**
   * The layout Home's sections sit in, shared by the page and by its loading placeholders so the
   * two are the same layout and nothing moves when data arrives: the date line, the Spotlight with
   * the one count under it, then two columns (what needs you, what is running and what needs
   * attention at the left, the box that starts a chat at the right) and the chats you were last in
   * across the full width below. On a phone every section is a row of one column, in the order the
   * Spotlight, Needs you, Running now, the box that starts a chat, Needs attention, Recent chats.
   * While the first-run
   * checklist shows the box that starts a chat sits under it, in the left column.
   *
   * The sections draw no box (Cinder's `Section`), so space alone separates them: the gap between
   * two sections is Cinder's own space between sections (`--cinder-space-8`).
   */
  import type { Snippet } from 'svelte';

  interface HomeLayoutProps {
    /** `data-mode` on the page: `overview`, `checklist` or `loading`. */
    mode: string;
    /** Marks the page region busy, while placeholders stand in for the cards. */
    busy?: boolean;
    /** The line that leads the page. */
    date: Snippet;
    /** The Spotlight and the one count under it; the checklist has neither. */
    focus?: Snippet | undefined;
    /** What needs you, or the checklist. */
    primary?: Snippet | undefined;
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
  }

  let {
    mode,
    busy = false,
    date,
    focus,
    primary,
    running,
    startChatBelow,
    attention,
    startChatAside,
    recent,
  }: HomeLayoutProps = $props();
</script>

<div class="ib-home" data-page="home" data-mode={mode} aria-busy={busy ? 'true' : undefined}>
  <p class="ib-home__date" data-testid="home-date">{@render date()}</p>
  {#if focus}<div class="ib-home__focus">{@render focus()}</div>{/if}
  <div class="ib-home__columns">
    <div class="ib-home__main">
      {#if primary}<div class="ib-home__needs-you">{@render primary()}</div>{/if}
      {#if running}<div class="ib-home__running">{@render running()}</div>{/if}
      <!-- While the checklist shows, the box that starts a chat sits under it, in the same column. -->
      {#if startChatBelow}<div class="ib-home__start-chat">{@render startChatBelow()}</div>{/if}
      {#if attention}<div class="ib-home__needs-attention">{@render attention()}</div>{/if}
    </div>
    {#if startChatAside}<div class="ib-home__start-chat">{@render startChatAside()}</div>{/if}
  </div>
  {@render recent()}
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
