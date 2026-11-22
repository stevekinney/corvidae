<script lang="ts">
  /**
   * One run on `/runs`, as the status-first two-line row every list shares (Cinder's
   * `StackedListItem`): the status word leads in its fixed column, then the title (two lines at
   * most, the whole title as its tooltip) and the time the run started on line one, and line two
   * says what kind of run it is, which agent ran it and how it went (`runLineTwo`). The whole row is
   * one link to the run's page; the list around it follows the link in place (`followLinks`). A
   * running row keeps its place: its duration follows `now`, and its word changes where it stands.
   */
  import { StackedListItem, StatusDot, type StackedListItemPhoneWidth } from '@lostgradient/cinder';

  import { COST_COPY } from '../../../app/copy/cost.ts';
  import { TASK_COPY } from '../../../app/copy/tasks.ts';
  import { clockTime } from '../../../lib/format/clock.ts';
  import { formatAttemptsCost } from '../../../lib/format/cost.ts';
  import { phoneViewport } from '../../../lib/phone-viewport.svelte.ts';
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
    /** When a schedule runs, by its identifier, which a schedule's chat run says (row 53l). */
    scheduleCadence?: ((scheduleId: string) => string | undefined) | undefined;
    /**
     * Which width decides the row's phone form (Cinder's `phoneWidth`): the Runs list, which fills
     * the page's content column, follows the window, so on a tablet beside the navigation rail the
     * status still leads in its column (05x). Default `row`, the row's own width.
     */
    phoneWidth?: StackedListItemPhoneWidth;
    /** What holds a schedule from starting its due run, which that run's row says (row 10h). */
    scheduleHolds?:
      ((scheduleId: string, agentName: string | null) => readonly string[]) | undefined;
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
    scheduleCadence = undefined,
    scheduleHolds = undefined,
    phoneWidth = 'row',
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
      ...(scheduleCadence === undefined ? {} : { scheduleCadence }),
      ...(scheduleHolds === undefined ? {} : { scheduleHolds }),
    }),
  );
  // Line two keeps what the run was; why the row does not open is the row's own description, so a
  // line cut short never drops it first.
  const lineTwo = $derived(baseLineTwo);
  // The Cost column (COR-2525): what the run cost, or nothing at all for a run with no cost, so a
  // run the Bureau priced no request of never shows "$0.00" or a dash. An instance of a workflow
  // file says the sum of its steps that have a cost, as "At least" when a step has none.
  const cost = $derived(formatAttemptsCost(row.cost ?? null));
  // A phone's row has no room for a column beside its time at large text, so the cost takes the
  // line under line two, as a goal's check does, and the row never grows wider than the screen.
  const phone = $derived(phoneViewport.current);
</script>

{#snippet lockedNote()}{TASK_COPY.list.engineRunLocked}{/snippet}
{#snippet costCell()}
  <span
    class="ib-run-list-cost"
    class:ib-run-list-cost--line={phone}
    data-testid="run-cost"
    title={row.cost?.partial === true ? COST_COPY.partialNote : COST_COPY.column}
    aria-label={cost === undefined ? undefined : COST_COPY.rowLabel(cost)}>{cost}</span
  >
{/snippet}

<StackedListItem
  data-run={row.id}
  data-status={word}
  {phoneWidth}
  {...readable ? {} : { description: lockedNote }}
  {...readable ? { href: router.href(href ?? workflowDetailPath(row.id)) } : {}}
  tooltip={row.title}
  metaTooltip={lineTwo}
  {...cost === undefined ? {} : phone ? { detail: costCell } : { trailing: costCell }}
>
  {#snippet status()}<StatusDot {word} />{/snippet}
  {#snippet title()}{row.title}{/snippet}
  {#snippet time()}
    <time datetime={new Date(row.startedAt).toISOString()}>{clockTime(row.startedAt, zone)}</time>
  {/snippet}
  {#snippet meta()}{lineTwo}{/snippet}
</StackedListItem>

<style>
  /* The Cost column: figures right-aligned in the row's last column. On a phone it is the row's
     last line and reads from the start, like the line above it. */
  .ib-run-list-cost {
    display: inline-block;
    max-inline-size: 100%;
    min-inline-size: 0;
    text-align: end;
    font-variant-numeric: tabular-nums;
    /* The cost wraps inside the row, so large text or a long sum never widens the page. */
    white-space: normal;
    overflow-wrap: anywhere;
    color: var(--cinder-text-muted);
  }

  .ib-run-list-cost--line {
    text-align: start;
  }
</style>
