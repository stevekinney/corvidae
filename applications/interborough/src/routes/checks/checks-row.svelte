<script lang="ts">
  /**
   * One result on `/checks`, as the status-first two-line row every list shares (Cinder's
   * `StackedListItem`): the outcome's status word leads in its fixed column, then the check in words
   * (two lines at most, the whole name as its tooltip) and the time it was decided on line one, and
   * line two says what kind of result it is, which agent it judged, a scorer's score and the check's
   * version (`checkLineTwo`). The whole row is one link, to the goal when it has one and to the run
   * otherwise; the list around it follows the link in place (`followLinks`). The outcome is said once,
   * by the `StatusDot` alone; no badge, tint or second word repeats it, and no raw id is shown.
   */
  import { StackedListItem, StatusDot } from '@lostgradient/cinder';

  import type { CheckRow } from '../../lib/bureau-checks.ts';
  import { clockTime } from '../../lib/format/clock.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { checkLineTwo, checkPath, checkTitle, checkWord } from './checks-rows.ts';

  interface Props {
    /** The result. */
    row: CheckRow;
    /** The IANA zone the times are written in: the viewer's. */
    zone: string;
    /** The name an agent goes by, from its identifier. */
    agentLabel: (agentName: string) => string;
  }

  let { row, zone, agentLabel }: Props = $props();

  const word = $derived(checkWord(row));
  const name = $derived(checkTitle(row));
  const lineTwo = $derived(checkLineTwo(row, agentLabel));
  const at = $derived(Date.parse(row.timestamp));
</script>

<StackedListItem
  data-check-kind={row.kind}
  data-status={word}
  href={router.href(checkPath(row))}
  tooltip={name}
  metaTooltip={lineTwo}
>
  {#snippet status()}<StatusDot {word} />{/snippet}
  {#snippet title()}{name}{/snippet}
  {#snippet time()}
    <time datetime={row.timestamp}>{clockTime(at, zone)}</time>
  {/snippet}
  {#snippet meta()}{lineTwo}{/snippet}
</StackedListItem>
