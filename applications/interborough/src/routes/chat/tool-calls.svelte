<script lang="ts">
  /**
   * One turn's tool calls on Cinder's rail: a row per call (its name for a person, the key input,
   * what came back), with the middle of a long turn folded. A call that needs a decision, failed,
   * was refused or was interrupted is never inside the fold; a call that needs a decision has its
   * decision directly under its row, and any call opens its arguments and result when its row is
   * chosen. A call whose approval was refused, or was decided on another page while this one was
   * open, keeps the decision under its row as what became of it. A turn that ends on a tool call
   * closes with the run's end state.
   */
  import type { Snippet } from 'svelte';

  import { ToolCallRail } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy.ts';
  import type { DecisionContext } from './approval-decision-words.ts';
  import { argumentEntries, displayValue } from '../../lib/tool-text.ts';
  import { railCall, type ToolCallEntry } from './tool-activity.ts';

  interface ToolCallsProps {
    id: string;
    entries: readonly ToolCallEntry[];
    /** The decision a call that needs one, or whose decision is kept, is shown with, directly under its row. */
    decision?: Snippet<[ToolCallEntry]>;
    /** Who the person is to this chat and which decisions were made on another page, for the words of a decided call. */
    decided?: DecisionContext;
    /** The run's end state, on its own line after the last row, for a turn that ends on a tool call. */
    endLabel?: string | undefined;
    /** An inline plugin panel for a completed tool call. */
    mcpApp?: Snippet<[ToolCallEntry]>;
  }

  let { id, entries, decision, decided = {}, endLabel, mcpApp }: ToolCallsProps = $props();

  let openDetails = $state<ReadonlySet<string>>(new Set());

  const byId = $derived(new Map(entries.map((entry) => [entry.callId, entry] as const)));
  /** A finished revision proposal keeps its inline panel on the rail, whatever the fold. */
  const showsPanel = (entry: ToolCallEntry): boolean =>
    mcpApp !== undefined &&
    entry.state === 'done' &&
    entry.name === 'bureau__workflows-propose-update';
  /** Whether the call has a decision under its row: it waits on one, or the decision it got is kept. */
  const showsDecision = (entry: ToolCallEntry): boolean =>
    decision !== undefined &&
    (entry.state === 'needs-you' ||
      (entry.decision !== undefined &&
        (entry.decision.outcome === 'denied' || decided.elsewhere?.has(entry.callId) === true)));
  const calls = $derived(
    entries.map((entry) => ({
      ...railCall(
        entry,
        showsDecision(entry) || openDetails.has(entry.callId) || showsPanel(entry),
        decided,
      ),
      ...(showsPanel(entry) ? { pinned: true } : {}),
    })),
  );
  const running = $derived(entries.some((entry) => entry.state === 'running'));

  function toggleDetails(callId: string): void {
    const next = new Set(openDetails);
    if (next.has(callId)) next.delete(callId);
    else next.add(callId);
    openDetails = next;
  }

  const resultEntries = (entry: ToolCallEntry) =>
    entry.result === undefined || entry.result === null
      ? []
      : typeof entry.result === 'object' && !Array.isArray(entry.result)
        ? argumentEntries(entry.result)
        : [['result', displayValue(entry.result)] as const];
</script>

<div class="ib-tools" data-tool-group={id}>
  <ToolCallRail
    {calls}
    {running}
    {endLabel}
    label={CHAT_COPY.tools.railLabel}
    selectedId={undefined}
    onSelect={toggleDetails}
  >
    {#snippet children(call)}
      {@const entry = byId.get(call.id)}
      {#if entry !== undefined}
        {#if openDetails.has(entry.callId)}
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
        {#if decision !== undefined && showsDecision(entry)}
          {@render decision(entry)}
        {/if}
        {#if mcpApp !== undefined}
          {@render mcpApp(entry)}
        {/if}
      {/if}
    {/snippet}
  </ToolCallRail>
</div>
