<script lang="ts">
  /**
   * One run on `/runs`, as the status-first two-line row every list shares (Cinder's
   * `StackedListItem`): the status word leads in its fixed column, then the title (two lines at
   * most, the whole title as its tooltip) and the time the run started on line one, and line two
   * says what kind of run it is, which agent ran it and how it went (`runLineTwo`). The whole row is
   * one link to the run's page; the list around it follows the link in place (`followLinks`). A
   * running row keeps its place: its duration follows `now`, and its word changes where it stands.
   */
  import { StackedListItem, StatusDot } from '@lostgradient/cinder';

  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { clockTime } from '../../../lib/format/clock.ts';
  import { router, workflowDetailPath } from '../../../lib/router.svelte.ts';
  import { runLineTwo, runStatusWord, type RunRow } from './run-rows.ts';

  interface Props {
    /** The run. */
    row: RunRow;
    /** The clock a wait and a running duration are counted to, in epoch milliseconds. */
    now: number;
    /** The IANA zone the times are written in: the viewer's. */
    zone: string;
    /** The name an agent goes by, from its identifier. */
    agentLabel: (agentName: string) => string;
    /** The title of a plugin, for a run its trigger started; the identifier is said without one. */
    pluginTitle?: ((plugin: string) => string | undefined) | undefined;
    /**
     * Where the row leads, when not to the run's own page: a workflow's Runs tab opens each run
     * under the workflow it belongs to.
     */
    href?: string | undefined;
    /**
     * Whether the row opens. A run only the workflow engine holds is the engine's page, which a
     * caller who may not read the engine would find missing; its row then does not open, and says why.
     */
    readable?: boolean;
  }

  let {
    row,
    now,
    zone,
    agentLabel,
    pluginTitle = undefined,
    href = undefined,
    readable = true,
  }: Props = $props();

  const word = $derived(runStatusWord(row, now));
  const baseLineTwo = $derived(
    runLineTwo(row, {
      now,
      zone,
      agentLabel,
      ...(pluginTitle === undefined ? {} : { pluginTitle }),
    }),
  );
  // Line two keeps what the run was; why the row does not open is the row's own description, so a
  // line cut short never drops it first.
  const lineTwo = $derived(baseLineTwo);
</script>

{#snippet lockedNote()}{TASK_COPY.list.engineRunLocked}{/snippet}

<StackedListItem
  data-run={row.id}
  data-status={word}
  {...readable ? {} : { description: lockedNote }}
  {...readable ? { href: router.href(href ?? workflowDetailPath(row.id)) } : {}}
  tooltip={row.title}
  metaTooltip={lineTwo}
>
  {#snippet status()}<StatusDot {word} />{/snippet}
  {#snippet title()}{row.title}{/snippet}
  {#snippet time()}
    <time datetime={new Date(row.startedAt).toISOString()}>{clockTime(row.startedAt, zone)}</time>
  {/snippet}
  {#snippet meta()}{lineTwo}{/snippet}
</StackedListItem>
