<script lang="ts">
  /**
   * Why a schedule will not start, as a card of reasons under the sentence that says what it runs
   * (COR-2018, `ScheduleDetail`, "Never run, and why it won't start"): the workflow comes first
   * because a schedule whose workflow can't load can't run whatever the provider, then the missing
   * provider. A reason that has somewhere to be fixed carries its link at the right. Run now's
   * description is this list, so a person who finds the button off hears the same reasons.
   */
  import { Link } from '@lostgradient/cinder';
  import { TriangleAlert } from '@lucide/svelte';

  import { SCHEDULE_COPY } from '../../app/copy/schedules.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { workflowEditPath } from '../../lib/workflow-type-paths.ts';
  import type { RowBlocker } from './schedule-row-model.ts';

  interface Props {
    /** Every reason, in the order they are said. */
    blockers: readonly RowBlocker[];
    /** Where a workflow's problem is, by the workflow's type: "order-refund.json line 12". */
    problems: ReadonlyMap<string, string>;
    /** The element id Run now names as its description. */
    id: string;
  }

  let { blockers, problems, id }: Props = $props();

  const copy = SCHEDULE_COPY.detail.runs.blockers;
</script>

<ul {id} class="ib-schedule__blockers" aria-label={copy.label} data-testid="schedule-blockers">
  {#each blockers as blocker (blocker.kind)}
    <li class="ib-schedule__blocker" data-kind={blocker.kind}>
      <span
        class="ib-schedule__blocker-glyph"
        data-tone={blocker.kind === 'provider' ? 'warning' : 'danger'}
        aria-hidden="true"><TriangleAlert size={16} /></span
      >
      <span class="ib-schedule__blocker-text">
        {#if blocker.kind === 'provider'}
          {copy.provider}
        {:else}
          <strong class="ib-schedule__blocker-title" data-tone="danger"
            >{blocker.kind === 'cannot-load'
              ? copy.cannotLoad(blocker.label)
              : copy.deleted(blocker.workflowType)}</strong
          >
          {#if blocker.kind === 'cannot-load'}
            <code class="ib-identifier"
              >{problems.get(blocker.workflowType) ?? blocker.workflowType}</code
            >
          {/if}
        {/if}
      </span>
      {#if blocker.kind === 'cannot-load'}
        <Link href={router.href(workflowEditPath(blocker.workflowType))}>{copy.openWorkflow}</Link>
      {:else if blocker.kind === 'provider'}
        <Link href={router.href(copy.providersPath)}>{copy.connectProvider}</Link>
      {/if}
    </li>
  {/each}
</ul>
