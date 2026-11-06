<script lang="ts">
  /**
   * Draws the count a clear holds out of a queue, as the Workers page derives its tabs and its
   * Retry all and Clear all from it, so a test can see whether the count follows the controller.
   */
  import type { TaskClearController } from './queue-task-clear.svelte.ts';

  interface Props {
    /** The controller whose held clears are counted. */
    controller: TaskClearController;
    /** The queue counted. */
    queue: string;
  }

  const { controller, queue }: Props = $props();
</script>

<output data-testid="held">{controller.hiddenCount(queue)}</output>
