<script lang="ts">
  /**
   * `/workflows/:workflow/runs`: the runs list of `/runs`, narrowed to one workflow type. Each row
   * links to its run, whose page links back to the type. The view frame has already settled that
   * the type exists and has runs, so the page is the list.
   */
  import { untrack } from 'svelte';

  import { router } from '../../lib/router.svelte.ts';
  import WorkflowList from '../workflows/list/workflow-list.svelte';

  // One page belongs to one type: the outlet mounts a new page when the path changes.
  const type = untrack(() => router.current.params['workflow'] ?? '');
</script>

<WorkflowList scopedType={type} />
