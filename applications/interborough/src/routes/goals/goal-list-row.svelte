<script lang="ts">
  /**
   * One goal as a row of the Goals list, Cinder's status-first row: the status dot and word, the
   * goal's name in bold and the time it began on line one, and line two agent first, then the
   * attempts bar with its count ("2 of 5"), then the check ("Check: Summary lists every refund
   * waiting for approval"). The bar is neutral in every state, because the word carries the outcome.
   * The whole row is the link to the goal's page, so the row carries no actions. On a phone the
   * status moves to line two before the agent, and the check moves to a muted third line that ends
   * in an ellipsis instead of wrapping.
   */
  import { AttemptsIndicator, StackedListItem, StatusDot } from '@lostgradient/cinder';

  import { GOALS_COPY } from '../../app/copy/goals.ts';
  import { clockTime } from '../../lib/format/clock.ts';
  import { goalPath } from '../../lib/identifier-paths.ts';
  import { router } from '../../lib/router.svelte.ts';
  import type { GoalRow } from './goal-rows.ts';

  interface Props {
    row: GoalRow;
    /** The name the agent goes by on screen. */
    agent: string;
    /** The zone the time is read in. */
    zone: string;
    /** The viewport is a phone: the check moves to a third line. */
    phone: boolean;
  }

  let { row, agent, zone, phone }: Props = $props();

  const count = $derived(GOALS_COPY.attempts(row.made, row.allowed));
  const check = $derived(GOALS_COPY.checkLine(row.check));
  // Line two as plain text, for the tooltip that carries it whole when it is cut.
  const lineTwoText = $derived(phone ? `${agent}. ${count}` : `${agent}. ${count}. ${check}`);
</script>

{#snippet attempts()}
  <span class="ib-goal-row__attempts"
    ><AttemptsIndicator made={row.made} allowed={row.allowed} />{count}</span
  >
{/snippet}
{#snippet phoneCheck()}
  <span class="ib-goal-row__check" data-testid="goal-check">{check}</span>
{/snippet}

<StackedListItem
  href={router.href(goalPath(row.id))}
  tooltip={row.title}
  metaTooltip={lineTwoText}
  {...phone ? { detail: phoneCheck } : {}}
  data-goal={row.id}
  data-status={row.status}
  data-status-word={row.statusWord}
>
  {#snippet status()}<StatusDot word={row.statusWord} size="sm" />{/snippet}
  {#snippet title()}{row.title}{/snippet}
  {#snippet time()}
    {#if row.startedAt !== null}
      <time datetime={new Date(row.startedAt).toISOString()}>{clockTime(row.startedAt, zone)}</time>
    {/if}
  {/snippet}
  {#snippet meta()}
    <span class="ib-goal-row__line"
      ><span>{agent}</span>{@render attempts()}{#if !phone}<span data-testid="goal-check"
          >{check}</span
        >{/if}</span
    >
  {/snippet}
</StackedListItem>

<style>
  /* The pieces of line two are separate elements with a gap between them, not a punctuated string. */
  .ib-goal-row__line {
    display: inline-flex;
    align-items: center;
    flex-wrap: wrap;
    column-gap: var(--cinder-space-3);
  }

  .ib-goal-row__attempts {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-2);
    vertical-align: middle;
  }

  /* The phone's third line ends in an ellipsis, so a long check never grows the row. */
  .ib-goal-row__check {
    display: block;
    max-inline-size: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
