<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type {
    ApprovalFailure,
    ApprovalResolution,
    ApprovalResolving,
    ApprovalState,
    ApprovalTool,
  } from './approval-card.types.ts';

  /** Props of the internal approval row. Not part of the public API. */
  export type ApprovalCardRowProps = {
    /** Id of the root article; the row derives the ids of its parts from it. */
    rootId: string;
    /** Tag of the question heading. */
    titleTag: string;
    /** Id of the question heading, which names the article. */
    titleId: string;
    /** The tool asking. */
    tool: ApprovalTool;
    /** The state the approver sees, after expiry is applied. */
    approvalState: ApprovalState;
    /** The question the approval asks. */
    question: string;
    /** Who asked, already written with its prefix: "Approval from Tool runner". */
    sourceText: string | undefined;
    /** When it was asked, already written as relative time. */
    requestedText: string | undefined;
    /** The ISO form of the time it was asked, for the `datetime` attribute. */
    requestedIso: string | undefined;
    /** What approving does. */
    consequence: string | undefined;
    /** The checkbox's scope, or `undefined` when the tool never offers it. */
    rememberScope: string | undefined;
    /**
     * Whether it was decided on another page while this one showed it waiting: the decided row then
     * collapses to a glyph, the question and the decision, with no tool line and no Input.
     */
    decidedElsewhere: boolean;
    /** What was decided, such as "Denied by you". */
    outcomeText: string | undefined;
    /** When it was decided, such as "10:40 AM". */
    outcomeTime: string | undefined;
    /** Green for an approval, neutral for everything else. */
    outcomeTone: 'success' | 'neutral';
    /** The note the approver left with the decision. */
    decisionNote: string | undefined;
    /** Where the note went, such as "Sent to the agent as the reason.". */
    decisionNoteCaption: string | undefined;
    /** Why Deny and Approve are off while the approval is pending. */
    disabledReason: string | undefined;
    /** Why an unavailable approval cannot be answered now. */
    unavailableReason: string | undefined;
    /** The answer on its way, or `undefined` when none is. */
    resolving: ApprovalResolving | undefined;
    /** Why the last answer did not go through. */
    failure: ApprovalFailure | undefined;
    /** A notice written beneath a read-only approval. */
    notice: string | undefined;
    /** What the approval led to. */
    result: string | undefined;
    /** A line written under the buttons while the approval is pending. */
    footnote: string | undefined;
    /** What the payload is called in the Input block. */
    inputLabel: string;
    /** A line of context written above the question. */
    context: Snippet | undefined;
    /** Identity of the request; the note and the checkbox reset when it changes. */
    requestKey: string;
    /** The pairs of the one-line summary of the input. */
    inputPairs: InputSummaryPair[];
    /** What the Input disclosure opens onto, or `undefined` when the operation carries nothing. */
    inputBody: Snippet | undefined;
    /** Resolution sink; undefined when the host is not wired to answer, or the approval is not actionable. */
    resolve: ((resolution: ApprovalResolution) => void) | undefined;
  };
</script>

<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import { untrack } from 'svelte';

  import Button from '../button/button.svelte';
  import Checkbox from '../checkbox/checkbox.svelte';
  import Textarea from '../textarea/textarea.svelte';
  import ApprovalCardFailure from './approval-card-failure.svelte';
  import ApprovalCardOutcome from './approval-card-outcome.svelte';
  import { RISK_LABELS, RISK_WORDS, STATE_LABELS } from './approval-card-state.ts';
  import type { InputSummaryPair } from './approval-card-state.ts';

  let {
    rootId,
    titleTag,
    titleId,
    tool,
    approvalState,
    question,
    sourceText,
    requestedText,
    requestedIso,
    consequence,
    rememberScope,
    decidedElsewhere,
    outcomeText,
    outcomeTime,
    outcomeTone,
    decisionNote,
    decisionNoteCaption,
    disabledReason,
    unavailableReason,
    resolving,
    failure,
    notice,
    result,
    footnote,
    inputLabel,
    context,
    requestKey,
    inputPairs,
    inputBody,
    resolve,
  }: ApprovalCardRowProps = $props();

  const inputId = $derived(`${rootId}-input`);
  const noteId = $derived(`${rootId}-note`);
  const disabledReasonId = $derived(`${rootId}-disabled-reason`);

  let inputOpen = $state(false);
  let noteOpen = $state(false);
  let note = $state('');
  let remember = $state(false);

  // The note and the checkbox belong to one request. A different request must never inherit
  // what the approver typed for the last one, so the reset compares the previous key by hand:
  // a `$derived` would also re-run on unrelated host updates and wipe in-progress text.
  let previousRequestKey = untrack(() => requestKey);
  $effect(() => {
    if (requestKey === previousRequestKey) return;
    previousRequestKey = requestKey;
    note = '';
    remember = false;
    noteOpen = false;
  });

  const isPending = $derived(approvalState === 'pending');
  const isUnavailable = $derived(approvalState === 'unavailable');
  const isDecided = $derived(!isPending && !isUnavailable);
  // Decided on another page, the row is what became of it and nothing else (Chat frame r).
  const collapsed = $derived(isDecided && decidedElsewhere);
  const canAnswer = $derived(isPending && resolve !== undefined);
  // While an answer is on its way nothing else can be answered, and the note and checkbox stay
  // as they were sent.
  const isBusy = $derived(resolving !== undefined);
  const actionsOff = $derived(disabledReason !== undefined || isBusy);
  const riskLabel = $derived(RISK_LABELS[tool.risk]);
  const riskWord = $derived(RISK_WORDS[tool.risk]);
  const hasSourceLine = $derived(sourceText !== undefined || requestedText !== undefined);
  const hasInput = $derived(inputBody !== undefined);
  const rememberLabel = $derived(
    rememberScope === undefined ? '' : `Allow ${tool.label ?? tool.name} for ${rememberScope}`,
  );

  function decide(decision: 'approve' | 'deny'): void {
    if (!canAnswer || actionsOff) return;
    const trimmedNote = note.trim();
    const resolution: ApprovalResolution = { decision, remember };
    if (trimmedNote) resolution.reason = trimmedNote;
    resolve?.(resolution);
  }
</script>

{#if context !== undefined}
  <div class="cinder-approval-card__context">{@render context()}</div>
{/if}

<div class="cinder-approval-card__row" data-cinder-collapsed={collapsed || undefined}>
  {#if collapsed}
    <span class="cinder-approval-card__decided-glyph" data-cinder-tone={outcomeTone}>
      {#if outcomeTone === 'success'}
        <Check size={16} strokeWidth={2} aria-hidden="true" />
      {:else}
        <Ban size={16} strokeWidth={2} aria-hidden="true" />
      {/if}
    </span>
  {:else}
    <span
      class="cinder-approval-card__risk-icon"
      role="img"
      aria-label={riskLabel}
      data-cinder-risk={tool.risk}
    >
      <ShieldAlert size={16} strokeWidth={2} aria-hidden="true" />
    </span>
  {/if}
  <div class="cinder-approval-card__row-main">
    <svelte:element this={titleTag} id={titleId} class="cinder-approval-card__row-question">
      {question}
    </svelte:element>
    {#if !collapsed}
      <p class="cinder-approval-card__line">
        <span class="cinder-approval-card__line-tool">
          {#if tool.label !== undefined}<span class="cinder-approval-card__tool-label"
              >{tool.label}</span
            >{' '}{/if}<span class="cinder-approval-card__line-facts"
            ><span class="cinder-approval-card__keep"
              ><code class="cinder-approval-card__tool-identifier">{tool.name}</code><span
                class="cinder-approval-card__separator"
                aria-hidden="true">,</span
              ></span
            >{' '}<span class="cinder-approval-card__keep"
              ><span class="cinder-approval-card__risk-word">{riskWord}</span
              >{#if tool.irreversible}<span
                  class="cinder-approval-card__separator"
                  aria-hidden="true">,</span
                >{/if}</span
            >{#if tool.irreversible}{' '}<span class="cinder-approval-card__undone"
                >Can't be undone</span
              >{/if}</span
          >{#if hasSourceLine}<span
              class="cinder-approval-card__separator cinder-approval-card__source-separator"
              aria-hidden="true">,</span
            >{/if}
        </span>
        {#if hasSourceLine}
          <span class="cinder-approval-card__line-source">
            {#if sourceText !== undefined}<span>{sourceText}</span
              >{#if requestedText !== undefined}<span
                  class="cinder-approval-card__separator cinder-approval-card__time-separator"
                  aria-hidden="true">,</span
                >{/if}{/if}
            {#if requestedText !== undefined}
              <time datetime={requestedIso}>{requestedText}</time>
            {/if}
          </span>
        {/if}
      </p>
    {/if}
    {#if consequence !== undefined && !isDecided}
      <p class="cinder-approval-card__consequence">{consequence}</p>
    {/if}
  </div>
  {#if isUnavailable || (isPending && !canAnswer)}
    <span class="cinder-approval-card__state-word" data-cinder-state-word>
      {STATE_LABELS[approvalState]}
    </span>
  {/if}
</div>

{#if isDecided}
  {#if inputPairs.length > 0 && !collapsed}
    <p class="cinder-approval-card__input-summary cinder-approval-card__decided-input">
      <span class="cinder-approval-card__input-word">{inputLabel}</span>
      {#each inputPairs as pair, index (pair.key)}
        {#if index > 0}<span class="cinder-approval-card__separator" aria-hidden="true">,</span
          >{' '}{/if}<span class="cinder-approval-card__pair-label">{pair.label}</span>{' '}<span
          class="cinder-approval-card__pair-value"
          data-cinder-muted={pair.muted || undefined}>{pair.text}</span
        >
      {/each}
    </p>
  {/if}
  {#if outcomeText !== undefined}
    <ApprovalCardOutcome
      {outcomeText}
      {outcomeTime}
      tone={outcomeTone}
      dot={!collapsed}
      {decisionNote}
      {decisionNoteCaption}
    />
  {/if}
  {#if result !== undefined}
    <p class="cinder-approval-card__result">
      <span class="cinder-approval-card__result-label">Result:</span>
      {result}
    </p>
  {/if}
  {#if notice !== undefined}
    <p class="cinder-approval-card__readonly-summary" data-cinder-state={approvalState}>
      {notice}
    </p>
  {/if}
{:else}
  <div class="cinder-approval-card__row-body">
    {#if isUnavailable}
      {#if inputPairs.length > 0}
        <p class="cinder-approval-card__input-summary" data-cinder-static>
          {#each inputPairs as pair, index (pair.key)}
            {#if index > 0}<span class="cinder-approval-card__separator" aria-hidden="true">,</span
              >{' '}{/if}<span class="cinder-approval-card__pair-label">{pair.label}</span
            >{' '}<span
              class="cinder-approval-card__pair-value"
              data-cinder-muted={pair.muted || undefined}>{pair.text}</span
            >
          {/each}
        </p>
      {/if}
      {#if unavailableReason !== undefined}
        <p class="cinder-approval-card__reason">{unavailableReason}</p>
      {/if}
      {#if notice !== undefined}
        <p class="cinder-approval-card__readonly-summary" data-cinder-state={approvalState}>
          {notice}
        </p>
      {/if}
    {:else}
      {#if hasInput}
        <div class="cinder-approval-card__input">
          <button
            type="button"
            class="cinder-approval-card__input-toggle"
            aria-expanded={inputOpen}
            aria-controls={inputId}
            onclick={() => (inputOpen = !inputOpen)}
          >
            <ChevronRight
              class="cinder-approval-card__input-chevron"
              size={12}
              strokeWidth={2}
              aria-hidden="true"
              data-cinder-open={inputOpen || undefined}
            />
            <span class="cinder-approval-card__input-word">{inputLabel}</span>
            <span class="cinder-approval-card__input-pairs">
              {#each inputPairs as pair, index (pair.key)}
                {#if index > 0}<span class="cinder-approval-card__separator" aria-hidden="true"
                    >,</span
                  >{' '}{/if}<span class="cinder-approval-card__pair-label">{pair.label}</span
                >{' '}<span
                  class="cinder-approval-card__pair-value"
                  data-cinder-muted={pair.muted || undefined}>{pair.text}</span
                >
              {/each}
            </span>
          </button>
          <div id={inputId} class="cinder-approval-card__row-input" hidden={!inputOpen}>
            {@render inputBody?.()}
          </div>
        </div>
      {/if}

      {#if canAnswer && failure !== undefined}
        <ApprovalCardFailure {failure} />
      {/if}

      {#if disabledReason !== undefined}
        <p id={disabledReasonId} class="cinder-approval-card__reason">{disabledReason}</p>
      {/if}

      {#if canAnswer && rememberScope !== undefined}
        <div class="cinder-approval-card__remember">
          <Checkbox bind:checked={remember} label={rememberLabel} disabled={isBusy} mutating />
        </div>
      {/if}

      {#if canAnswer && noteOpen}
        <div class="cinder-approval-card__note">
          <Textarea
            id={noteId}
            bind:value={note}
            label="Note (optional)"
            description="Saved with your decision. If you deny, the agent reads it as the reason."
            placeholder="Add a note for the agent or the record"
            rows={2}
            size="sm"
            disabled={isBusy}
          />
        </div>
      {/if}

      {#if canAnswer}
        <div class="cinder-approval-card__row-actions" role="group" aria-label="Approval actions">
          {#if !noteOpen}
            <button
              type="button"
              class="cinder-approval-card__note-toggle"
              aria-expanded={noteOpen}
              disabled={isBusy}
              onclick={() => (noteOpen = true)}
            >
              Add a note
            </button>
          {/if}
          <span class="cinder-approval-card__row-spacer"></span>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            mutating
            disabled={isBusy && resolving !== 'deny'}
            aria-disabled={disabledReason === undefined ? undefined : 'true'}
            loading={resolving === 'deny'}
            loadingStatus="Denying…"
            aria-describedby={disabledReason === undefined ? undefined : disabledReasonId}
            onclick={() => decide('deny')}
          >
            {resolving === 'deny' ? 'Denying…' : 'Deny'}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            mutating
            disabled={isBusy && resolving !== 'approve'}
            aria-disabled={disabledReason === undefined ? undefined : 'true'}
            loading={resolving === 'approve'}
            loadingStatus="Approving…"
            aria-describedby={disabledReason === undefined ? undefined : disabledReasonId}
            onclick={() => decide('approve')}
          >
            {resolving === 'approve' ? 'Approving…' : 'Approve'}
          </Button>
        </div>
        {#if footnote !== undefined}
          <p class="cinder-approval-card__footnote">{footnote}</p>
        {/if}
      {/if}
    {/if}
  </div>
{/if}
