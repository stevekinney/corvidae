<script lang="ts">
  /**
   * What the goal was asked (COR-2425, rows 67j, 67o and 67t): its prompt under the heading "Asked",
   * held to three lines with Cinder's own "Show all" under it while the prompt runs longer. Only the
   * goal's owner reads the prompt (`bureau.goals.get`), so the page draws this for a goal that
   * carries one and says nothing for one that does not. A flat block: a heading and its text, no
   * box around either.
   */
  import { Text } from '@lostgradient/cinder';

  import { GOALS_COPY } from '../../app/copy/goals.ts';

  interface Props {
    /** The goal's prompt, as its owner last set it. */
    prompt: string;
  }

  let { prompt }: Props = $props();

  const copy = GOALS_COPY.detail;
  const uid = $props.id();
  const headingId = `${uid}-asked`;
  /** How many lines of the prompt show before Show all. */
  const CLAMPED_LINES = 3;
</script>

<section class="ib-goal-asked" aria-labelledby={headingId} data-testid="goal-asked">
  <h2 class="ib-goal-asked__heading" id={headingId}>{copy.askedHeading}</h2>
  <div class="ib-goal-asked__text">
    <Text clamp={CLAMPED_LINES}>{prompt}</Text>
  </div>
</section>

<style>
  .ib-goal-asked {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    min-inline-size: 0;
    margin-block-end: var(--cinder-space-4);
  }

  .ib-goal-asked__heading {
    margin: 0;
    font-size: var(--cinder-text-sm);
    font-weight: var(--cinder-font-semibold);
    color: var(--cinder-text-muted);
  }

  /* The prompt keeps the line breaks its owner wrote. */
  .ib-goal-asked__text {
    min-inline-size: 0;
    white-space: pre-line;
    overflow-wrap: anywhere;
  }
</style>
