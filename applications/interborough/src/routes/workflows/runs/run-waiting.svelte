<script lang="ts">
  /**
   * What the run is waiting on a person to answer, at the top of the page: each open question the
   * agent asked, with the control that answers it in place (`run-wait.svelte`). A tool approval is
   * not here: it is decided under the tool call it gates, in the Activity section, as the chat shows
   * it. The section is absent when the run asks nothing.
   */
  import { TASK_COPY } from '../../../app/copy.ts';
  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import RunWait from './run-wait.svelte';

  interface RunWaitingProps {
    task: TaskView;
  }

  let { task }: RunWaitingProps = $props();

  const questions = $derived(task.openWaits.filter((wait) => wait.kind === 'human-wait'));
</script>

{#if questions.length > 0}
  <section
    class="ib-run__section ib-run__waiting"
    aria-labelledby="ib-run-waiting"
    data-section="waiting"
  >
    <h2 id="ib-run-waiting" class="ib-run__heading-2">{TASK_COPY.waitsHeading}</h2>
    {#each questions as wait (wait.reviewId)}
      <RunWait taskId={task.id} {wait} />
    {/each}
  </section>
{/if}
