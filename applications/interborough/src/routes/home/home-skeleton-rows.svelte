<script lang="ts">
  /**
   * The placeholder for a Home card's rows, in the real rows' shape: two bars of text at the start
   * and, for a row that has a button, a block where the button goes. It reserves the height the
   * rows take, so nothing moves when they arrive. Cinder's `skeleton` draws every block, so it
   * shimmers (and is still under `prefers-reduced-motion`) as every placeholder does.
   */
  import { Skeleton } from '@lostgradient/cinder';

  interface HomeSkeletonRowsProps {
    /** How many rows to draw. */
    rows: number;
    /** Whether each row has a button at its end (Needs you and Needs attention do). */
    action?: boolean;
  }

  let { rows, action = false }: HomeSkeletonRowsProps = $props();
</script>

<div
  class="ib-home-skeleton-rows"
  class:ib-home-skeleton-rows--chats={!action}
  data-testid="home-skeleton-rows"
>
  {#each { length: rows } as _, index (index)}
    <div class="ib-home-skeleton-rows__row">
      <div class="ib-home-skeleton-rows__text">
        <Skeleton width="min(18rem, 60%)" height="0.625rem" />
        <Skeleton width="min(12rem, 40%)" height="0.5rem" />
      </div>
      {#if action}
        <Skeleton width="5.25rem" height="1.75rem" radius="var(--cinder-radius-md)" />
      {/if}
    </div>
  {/each}
</div>

<style>
  /* The rows a chat list draws are a little taller: a status word leads each one. */
  .ib-home-skeleton-rows--chats {
    --_ib-home-skeleton-row-height: 4rem;
  }

  .ib-home-skeleton-rows__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-4);
    min-block-size: var(--_ib-home-skeleton-row-height, 3.75rem);
    padding: var(--cinder-space-3) var(--cinder-space-4);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  .ib-home-skeleton-rows__row:last-child {
    border-block-end: 0;
  }

  .ib-home-skeleton-rows__text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
  }
</style>
