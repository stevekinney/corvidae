<script lang="ts">
  /**
   * The chip under the sentence of a schedule that is the trigger in a workflow's file (COR-2018,
   * `ScheduleDetail`, "A file-defined schedule"): a lock, "Defined in", and the file's path relative
   * to the Interborough home in monospace, with the full path on hover once the host has said where
   * the home is. It is a line, not a callout: the file is where the schedule is changed, which Open
   * file says.
   */
  import { Lock } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
  import { getHostPaths, workflowFilePath, workflowRelativePath } from '../../lib/host-paths.ts';
  import { queryKeys } from '../../lib/query.ts';

  interface Props {
    /** The workflow file's identifier: its name without `.json`. */
    id: string;
  }

  let { id }: Props = $props();

  const hostPaths = createQuery(() => ({
    queryKey: queryKeys.hostPaths(),
    queryFn: ({ signal }) => getHostPaths({ signal }),
    // A host that does not say where the home is is not asked again: the relative path stands alone.
    retry: false,
  }));
  const fullPath = $derived(
    hostPaths.data === undefined
      ? undefined
      : workflowFilePath(hostPaths.data.workflowDirectory, id),
  );
</script>

<p class="ib-schedule__file" data-testid="schedule-file">
  <Lock aria-hidden="true" size={14} />
  <span>{SCHEDULE_COPY.detail.definedIn}</span>
  <code class="ib-identifier" title={fullPath} data-testid="schedule-file-path"
    >{workflowRelativePath(id)}</code
  >
</p>
