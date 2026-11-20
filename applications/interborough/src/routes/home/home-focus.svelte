<script lang="ts">
  /**
   * What leads Home: a Spotlight that says how many reviews wait on you ("2 need you", "Nothing
   * needs you"). Running now has its own list, the reviews waiting are the Spotlight and the list
   * under it, and a schedule that missed runs is a row under Needs attention. The one count Home
   * lists nowhere else, Failed in 24 hours, sits after the list the Spotlight titles, never between
   * the two (`home-counts.svelte`, owner decision 2026-11-16).
   *
   * The Spotlight is the title of the Needs you list under it, so "Open Reviews ›" (Cinder's `Link`
   * in its `more` form) sits beside it as that section's action, and the list draws no heading of
   * its own: the page says "needs you" once. With nothing waiting there is no Spotlight, only one
   * quiet line, "Nothing needs you." (`lib/quiet-line.svelte`, owner 2026-11-19). It reads the same list as Needs you (`waitingReviewsQuery`), so the two cannot
   * disagree. While that read has not answered a placeholder holds the Spotlight's place; when it
   * fails the Spotlight is left out, and the Needs you section takes its heading back and says it
   * could not load.
   */
  import { Link, Skeleton, Spotlight } from '@lostgradient/cinder';

  import { HOME_COPY } from '../../app/copy/home.ts';
  import QuietLine from '../../lib/quiet-line.svelte';
  import { router } from '../../lib/router.svelte.ts';
  import { waitingReviewsQuery } from '../reviews/reviews-data.ts';
  import { openInApplication } from './home-navigation.ts';
  import { needsYouRows } from './home-rows.ts';

  const reviews = waitingReviewsQuery();

  const waiting = $derived(
    reviews.data === undefined
      ? undefined
      : needsYouRows(reviews.data, { agents: undefined, tools: undefined }).length,
  );
</script>

<!-- When the read fails nothing is drawn here, so the page's layout gives the place no gap. -->
{#if waiting !== undefined || !reviews.isError}
  <div data-testid="home-focus">
    {@render spotlight()}
  </div>
{/if}

{#snippet spotlight()}
  {#if waiting === 0}
    <!-- Nothing waits: no Spotlight and no card says nothing, only one quiet line (owner,
         2026-11-19), and the space goes to what has content. -->
    <QuietLine text={HOME_COPY.needsYou.nothing} data-testid="home-nothing-needs-you" />
  {:else if waiting !== undefined}
    <!-- The Spotlight is the title of the reviews under it, so the way out to Reviews is its
         action, at the end of its line as a section's action sits beside its heading. -->
    <Spotlight value={HOME_COPY.needsYou.spotlight(waiting)} data-testid="home-spotlight">
      {#snippet action()}
        <Link
          variant="more"
          href={router.href('/reviews')}
          onclick={(event: MouseEvent) => openInApplication(event, '/reviews')}
          >{HOME_COPY.needsYou.link}</Link
        >
      {/snippet}
    </Spotlight>
  {:else if !reviews.isError}
    <!-- One line of the Spotlight (32px type at its 1.1 leading), so nothing moves when it arrives. -->
    <Skeleton width="11rem" height="2.2rem" radius="var(--cinder-radius-md)" />
  {/if}
{/snippet}
