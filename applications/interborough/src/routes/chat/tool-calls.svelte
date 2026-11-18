<script lang="ts">
  /**
   * One turn's tool calls on Cinder's rail: a row per call (its name for a person, the key input,
   * what came back), with the middle of a long turn folded. A call that needs a decision, failed,
   * was refused or was interrupted is never inside the fold; a call that needs a decision has its
   * decision directly under its row, and any call opens its arguments and result when its row is
   * chosen: in the page's side panel when the page hands `onSelect` (the chat page's), otherwise
   * under the row. A call whose approval was refused, or was decided on another page while this one was
   * open, keeps the decision under its row as what became of it. A turn that ends on a tool call
   * closes with the run's end state.
   */
  import type { Snippet } from 'svelte';

  import { ToolCallRail } from '@lostgradient/cinder';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
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
    /** How long the turn spent on its tools, formatted ("18s"), at the end of the summary line; left out when no call recorded its times. */
    duration?: string | undefined;
    /** An inline plugin panel for a completed tool call. */
    mcpApp?: Snippet<[ToolCallEntry]>;
    /** Whether a completed call has an inline plugin panel, which keeps its row open on the rail. */
    opensPanel?: (entry: ToolCallEntry) => boolean;
    /**
     * Fired with a call's id when its row is chosen, which opens the call in the page's side panel.
     * Without it a chosen row opens the call's arguments and result under it.
     */
    onSelect?: ((callId: string) => void) | undefined;
    /** The call whose panel is open: its row is tinted. Only with `onSelect`. */
    selectedId?: string | undefined;
    /**
     * Runs the step again: fired with a failed call's id when the person chooses Retry this step
     * under it. The link shows only when this is set, so the page sets it where a retry can run.
     */
    onRetryStep?: ((callId: string) => void) | undefined;
  }

  let {
    id,
    entries,
    decision,
    decided = {},
    endLabel,
    duration,
    mcpApp,
    opensPanel,
    onSelect,
    selectedId,
    onRetryStep,
  }: ToolCallsProps = $props();

  /** A failed step's Copy error puts what went wrong and its diagnostic on the clipboard. */
  async function copyError(_id: string, text: string): Promise<void> {
    await navigator.clipboard.writeText(text);
  }
  const railLabels = {
    retry: CHAT_COPY.tools.retryStep,
    copyError: CHAT_COPY.tools.copyError,
    copied: CHAT_COPY.tools.copied,
  };

  let openDetails = $state<ReadonlySet<string>>(new Set());
  const inline = $derived(onSelect === undefined);

  const byId = $derived(
    new Map(
      entries.flatMap((entry) => [
        [entry.callId, entry] as const,
        ...(entry.railId === undefined ? [] : [[entry.railId, entry] as const]),
      ]),
    ),
  );
  /** A finished call whose agent tool a plugin panel is placed on keeps that panel on the rail, whatever the fold. */
  const showsPanel = (entry: ToolCallEntry): boolean =>
    mcpApp !== undefined && entry.state === 'done' && opensPanel?.(entry) === true;
  /** Whether the call has a decision under its row: it waits on one, or the decision it got is kept. */
  const showsDecision = (entry: ToolCallEntry): boolean =>
    decision !== undefined &&
    (entry.state === 'needs-you' ||
      entry.state === 'expired' ||
      (entry.decision !== undefined &&
        (entry.decision.outcome === 'denied' ||
          decided.elsewhere?.has(entry.callId) === true ||
          // A decision the Bureau records as made in Reviews keeps its receipt after a reload,
          // with the place a link to it (COR-2292 A5), as it does while the page watches.
          entry.decision.decisionSurface === 'reviews' ||
          // A call whose row carries a link keeps its approval under it, since the row's
          // words are the answer.
          (entry.resultHref !== undefined && entry.decision.outcome === 'approved'))));
  const calls = $derived(
    entries.map((entry) => ({
      ...railCall(
        entry,
        showsDecision(entry) || (inline && openDetails.has(entry.callId)) || showsPanel(entry),
        decided,
        // A decided call whose receipt card is drawn under its row: the card says the decision.
        showsDecision(entry) && entry.decision !== undefined,
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
    {duration}
    {endLabel}
    label={CHAT_COPY.tools.railLabel}
    labels={railLabels}
    {selectedId}
    onSelect={onSelect ?? toggleDetails}
    onCopyError={copyError}
    onRetry={onRetryStep === undefined
      ? undefined
      : (id) => onRetryStep(byId.get(id)?.callId ?? id)}
  >
    {#snippet children(call)}
      {@const entry = byId.get(call.id)}
      {#if entry !== undefined}
        {#if inline && openDetails.has(entry.callId)}
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
