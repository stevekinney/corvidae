<script lang="ts">
  /**
   * The Run page's note for a run that needs a look (COR-2528): under the header, one warning
   * callout for each state the Bureau lists on the task (stalled, looping, over the spend
   * threshold), saying the condition in a sentence. A stalled run says when it was seen to stall,
   * which is as near as the Bureau comes to when it last made progress. It is a static note, not a
   * live region: the person finds it when they open the page, and no control is here, because
   * stopping a run is the header's Cancel run. Absent for a run with none.
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
