<script lang="ts">
  /**
   * The Run page's note for a run that needs a look (COR-2528): under the header, one warning
   * callout for each state the Bureau lists on the task (stalled, looping, over the spend
   * threshold), saying the condition in a sentence, stacked 8px apart as one group. A stalled run
   * says when it was seen to stall, which is as near as the Bureau comes to when it last made
   * progress. The last note of a run that is still going says once that it keeps running. It is a
   * static note, not a live region: the person finds it when they open the page, and no control is
   * here, because stopping a run is the header's Cancel run. Absent for a run with none.
   */
  import { Callout } from '@lostgradient/cinder';

  import type { TaskView } from '../../../lib/bureau-tasks.ts';
  import { viewerTimeZone } from '../../../lib/format/clock.ts';
  import { runAttentionNotes } from './run-attention-note.ts';

  interface RunAttentionNoteProps {
    /** The Bureau's task for the run. */
    task: TaskView;
  }

  let { task }: RunAttentionNoteProps = $props();

  const zone = viewerTimeZone();
  const notes = $derived(runAttentionNotes(task, Date.now(), zone));
</script>

{#if notes.length > 0}
  <!-- One element in the page's column, so the notes sit 8px apart and not a section's gap apart. -->
  <div class="ib-run-attention">
    {#each notes as note (note.state)}
      <Callout
        variant="warning"
        semantic="note"
        title={note.title}
        data-testid="run-attention-note"
        data-attention={note.state}
      >
        {note.line}
      </Callout>
    {/each}
  </div>
{/if}

<style>
  .ib-run-attention {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
  }
</style>
