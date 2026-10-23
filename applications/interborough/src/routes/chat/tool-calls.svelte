<script lang="ts">
  /**
   * One turn's tool calls: a row per call (glyph, tool, one line about the answer, and a Details
   * disclosure for its arguments and result). Several calls fold into one line, "Used N tools",
   * with a Show toggle, but a call that needs a decision is never inside the fold: its row stays,
   * and its approval is the flat decision row directly under it.
   */
  import type { Snippet } from 'svelte';

  import { Button } from '@lostgradient/cinder';
  import { Check, CircleAlert, Hourglass, X } from '@lucide/svelte';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { argumentEntries, displayValue } from '../../lib/tool-text.ts';
  import { groupSummary, type ToolCallEntry } from './tool-activity.ts';

  interface ToolCallsProps {
    id: string;
    entries: readonly ToolCallEntry[];
    /** The decision a call that needs one is shown with, directly under its row. */
    decision?: Snippet<[ToolCallEntry]>;
  }

  let { id, entries, decision }: ToolCallsProps = $props();

  let open = $state(false);
  const folded = $derived(entries.length > 1 && !open);
  const visible = $derived(folded ? entries.filter((entry) => entry.state === 'needs-you') : entries);
  let detailsOpen = $state<Readonly<Record<string, boolean>>>({});

  const STATE_LABEL = {
    running: 'Running',
    'needs-you': 'Needs you',
    done: 'Done',
    failed: 'Failed',
  } as const;

  const resultEntries = (entry: ToolCallEntry) =>
    entry.result === undefined || entry.result === null
      ? []
      : typeof entry.result === 'object' && !Array.isArray(entry.result)
        ? argumentEntries(entry.result)
        : [['result', displayValue(entry.result)] as const];
</script>

<div class="ib-tools" data-tool-group={id}>
  {#if entries.length > 1}
    <div class="ib-tools__fold">
      <span>{groupSummary(entries)}</span>
      <Button
        variant="ghost"
        size="lg"
        label={open ? CHAT_COPY.tools.hide : CHAT_COPY.tools.show}
        aria-expanded={open}
        onclick={() => (open = !open)}
      />
    </div>
  {/if}
  {#each visible as entry (entry.callId)}
    <div class="ib-tool" data-tool-call-row={entry.callId} data-state={entry.state}>
      <div class="ib-tool__line">
        <span class="ib-tool__glyph" data-state={entry.state} role="img" aria-label={STATE_LABEL[entry.state]}>
          {#if entry.state === 'done'}
            <Check aria-hidden="true" size={16} />
          {:else if entry.state === 'failed'}
            <X aria-hidden="true" size={16} />
          {:else if entry.state === 'needs-you'}
            <CircleAlert aria-hidden="true" size={16} />
          {:else}
            <Hourglass aria-hidden="true" size={16} />
          {/if}
        </span>
        <span class="ib-tool__name">{entry.name}</span>
        <span class="ib-tool__summary">
          {entry.state === 'needs-you'
            ? CHAT_COPY.tools.waitingForApproval
            : entry.state === 'running'
              ? CHAT_COPY.tools.running
              : entry.summary}
        </span>
        <Button
          variant="ghost"
          size="lg"
          label={CHAT_COPY.tools.details}
          aria-expanded={detailsOpen[entry.callId] === true}
          aria-controls={`${id}-${entry.callId}-details`}
          onclick={() => (detailsOpen = { ...detailsOpen, [entry.callId]: detailsOpen[entry.callId] !== true })}
        />
      </div>
      {#if detailsOpen[entry.callId] === true}
        <dl class="ib-tool__details" id={`${id}-${entry.callId}-details`}>
          {#each argumentEntries(entry.arguments) as [key, value] (`argument-${key}`)}
            <dt>{key}</dt>
            <dd>{value}</dd>
          {/each}
          {#each resultEntries(entry) as [key, value] (`result-${key}`)}
            <dt>{CHAT_COPY.tools.resultPrefix} {key}</dt>
            <dd>{value}</dd>
          {/each}
        </dl>
      {/if}
      {#if entry.state === 'needs-you' && decision !== undefined}
        {@render decision(entry)}
      {/if}
    </div>
  {/each}
</div>
