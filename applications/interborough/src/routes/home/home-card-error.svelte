<script lang="ts">
  /**
   * What a Home card says when its own read failed: one row inside the card, in place of its rows,
   * saying what could not be loaded and that the rest of Home is live, with a "Try again" that asks
   * that card's read again. Cinder's `error-state` in its row layout, so the failure reads as the
   * line of a list, in the card's own place.
   */
  import { ErrorState } from '@lostgradient/cinder';

  import { HOME_COPY } from '../../app/copy.ts';

  interface HomeCardErrorProps {
    /** What could not be loaded, as a sentence: "Couldn’t load system problems." */
    title: string;
    /** Asks the card's read again. */
    onRetry: () => void;
  }

  let { title, onRetry }: HomeCardErrorProps = $props();
</script>

<ErrorState
  variant="row"
  headingLevel={3}
  {title}
  description={HOME_COPY.states.restIsLive}
  {onRetry}
  data-testid="home-card-error"
/>
