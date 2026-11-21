<script lang="ts">
  /**
   * A goal's attempts, under the heading "Attempts" with the count beside it ("Attempts 2 of 5"),
   * newest first, as Cinder's status-first rows: the attempt's status dot and word, "Attempt N" and
   * the time it began on line one, and line two agent first, then how long it took, how it was
   * canceled, or what it waits on (`goal-page-rows.ts`). Each row is the link to the attempt's run.
   * A goal that has made none says so. Each row also has a Verdict button, which opens what the check
   * decided about that attempt (`goal-verdict-panel.svelte`).
   */
  import { DataList, EmptyState, StackedListItem, StatusDot } from '@lostgradient/cinder';
  import { Target } from '@lucide/svelte';

  import { GOALS_COPY } from '../../app/copy/goals.ts';
  import { followLinks } from '../../lib/follow-links.ts';
  import { clockTime } from '../../lib/format/clock.ts';
  import { router, workflowDetailPath } from '../../lib/router.svelte.ts';
  import type { AttemptRow } from './goal-page-rows.ts';

  interface Props {
    /** The attempts, newest first. */
    rows: readonly AttemptRow[];
    /** Attempts made. */
    made: number;
    /** Attempts the goal may make. */
    allowed: number;
    /** The zone the times are read in. */
    zone: string;
    /** Opens the verdict of one attempt, by its `attemptIndex` (COR-2124). */
    onOpenVerdict: (attemptIndex: number) => void;
  }

  let { rows, made, allowed, zone, onOpenVerdict }: Props = $props();

  const copy = GOALS_COPY.detail;
  const uid = $props.id();
  const headingId = `${uid}-attempts`;
  const count = $derived(GOALS_COPY.attempts(made, allowed));

  function rowKey(row: AttemptRow): string {
    return row.id;
  }
</script>

<section
  class="ib-goal-attempts"
  aria-labelledby={rows.length === 0 ? undefined : headingId}
  aria-label={rows.length === 0 ? copy.attemptsHeading : undefined}
>
  {#if rows.length === 0}
    <!-- The state alone: no "Attempts" heading above it saying the same thing (owner report,
    2026-11-19). -->
    <EmptyState
      kind="first-use"
      title={copy.noAttempts.title}
      description={copy.noAttempts.description}
      headingLevel={2}
      data-testid="goal-attempts-empty"
    >
      {#snippet icon()}<Target aria-hidden="true" />{/snippet}
    </EmptyState>
  {:else}
    <h2 class="ib-goal-attempts__heading" id={headingId} data-testid="goal-attempts-heading">
      {copy.attemptsHeading}
      <span class="ib-goal-attempts__count">{count}</span>
    </h2>
    <div {@attach followLinks}>
      <DataList items={[...rows]} key={rowKey} aria-label={copy.attemptsLabel}>
        {#snippet children(row: AttemptRow)}
          <StackedListItem
            href={router.href(workflowDetailPath(row.runId))}
            tooltip={row.title}
            metaTooltip={row.lineTwo}
            wrapMeta
            data-attempt={row.id}
            data-run={row.runId}
            data-status-word={row.word}
            actions={[
              {
                label: copy.verdict.action,
                // The row's own link is the run; the verdict is a separate button beside it.
                onclick: () => onOpenVerdict(row.attemptIndex),
              },
            ]}
            actionsLabel={copy.verdict.actionLabel(row.number)}
          >
            {#snippet status()}<StatusDot word={row.word} size="sm" />{/snippet}
            {#snippet title()}{row.title}{/snippet}
            {#snippet time()}
              {#if row.startedAt !== null}
                <time datetime={new Date(row.startedAt).toISOString()}
                  >{clockTime(row.startedAt, zone)}</time
                >
              {/if}
            {/snippet}
            {#snippet meta()}{row.lineTwo}{/snippet}
          </StackedListItem>
        {/snippet}
      </DataList>
    </div>
  {/if}
</section>

<style>
  .ib-goal-attempts {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-inline-size: 0;
  }

  .ib-goal-attempts__heading {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-3);
    margin: 0;
    font-size: var(--cinder-text-base);
    font-weight: var(--cinder-font-semibold);
  }

  .ib-goal-attempts__count {
    font-weight: var(--cinder-font-normal);
    color: var(--cinder-text-muted);
  }
</style>
