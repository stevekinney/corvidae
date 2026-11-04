<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type { ApprovalResolution, ApprovalState, ApprovalTool } from './approval-card.types.ts';

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
    /** Who asked. */
    source: string | undefined;
    /** When it was asked, already written as relative time. */
    requestedText: string | undefined;
    /** The ISO form of the time it was asked, for the `datetime` attribute. */
    requestedIso: string | undefined;
    /** What approving does. */
    consequence: string | undefined;
    /** The checkbox's scope, or `undefined` when the tool never offers it. */
    rememberScope: string | undefined;
    /** What was decided, such as "Denied by you". */
    outcomeText: string | undefined;
    /** When it was decided, such as "10:40 AM". */
    outcomeTime: string | undefined;
    /** Why Deny and Approve are off while the approval is pending. */
    disabledReason: string | undefined;
    /** Why an unavailable approval cannot be answered now. */
    unavailableReason: string | undefined;
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
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';
  import { untrack } from 'svelte';

  import Button from '../button/button.svelte';
  import Checkbox from '../checkbox/checkbox.svelte';
  import Textarea from '../textarea/textarea.svelte';
  import { RISK_LABELS, RISK_WORDS, STATE_LABELS } from './approval-card-state.ts';
  import type { InputSummaryPair } from './approval-card-state.ts';

  let {
    rootId,
    titleTag,
    titleId,
    tool,
    approvalState,
    question,
    source,
    requestedText,
    requestedIso,
    consequence,
    rememberScope,
    outcomeText,
    outcomeTime,
    disabledReason,
    unavailableReason,
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
  const canAnswer = $derived(isPending && resolve !== undefined);
  const riskLabel = $derived(RISK_LABELS[tool.risk]);
  const riskWord = $derived(RISK_WORDS[tool.risk]);
  const sourceText = $derived(source === undefined ? undefined : `Approval from ${source}`);
  const hasSourceLine = $derived(sourceText !== undefined || requestedText !== undefined);
  const hasInput = $derived(inputBody !== undefined);
  const rememberLabel = $derived(
    rememberScope === undefined ? '' : `Allow ${tool.label ?? tool.name} for ${rememberScope}`,
  );

  function decide(decision: 'approve' | 'deny'): void {
    if (!canAnswer || disabledReason !== undefined) return;
    const trimmedNote = note.trim();
    const resolution: ApprovalResolution = { decision, remember };
    if (trimmedNote) resolution.reason = trimmedNote;
    resolve?.(resolution);
  }
</script>

<div class="cinder-approval-card__row">
  <span
    class="cinder-approval-card__risk-icon"
    role="img"
    aria-label={riskLabel}
    data-cinder-risk={tool.risk}
  >
    <ShieldAlert size={16} strokeWidth={2} aria-hidden="true" />
  </span>
  <div class="cinder-approval-card__row-main">
    <svelte:element this={titleTag} id={titleId} class="cinder-approval-card__row-question">
      {question}
    </svelte:element>
    <p class="cinder-approval-card__line">
      <span class="cinder-approval-card__line-tool">
        {#if tool.label !== undefined}<span class="cinder-approval-card__tool-label"
            >{tool.label}</span
          >{' '}{/if}<code class="cinder-approval-card__tool-identifier">{tool.name}</code>
        <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
        <span class="cinder-approval-card__risk-word">{riskWord}</span>
        {#if tool.irreversible}
          <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
          <span class="cinder-approval-card__undone">Can't be undone</span>
        {/if}
      </span>
      {#if hasSourceLine}
        <span class="cinder-approval-card__line-source">
          <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
          {#if sourceText !== undefined}<span>{sourceText}</span>{/if}
          {#if sourceText !== undefined && requestedText !== undefined}
            <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
          {/if}
          {#if requestedText !== undefined}
            <time datetime={requestedIso}>{requestedText}</time>
          {/if}
        </span>
      {/if}
    </p>
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
  {#if outcomeText !== undefined}
    <p class="cinder-approval-card__outcome">
      <span class="cinder-approval-card__outcome-word">
        <span class="cinder-approval-card__outcome-dot" aria-hidden="true"></span>
        {outcomeText}
      </span>
      {#if outcomeTime !== undefined}
        <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
        <span class="cinder-approval-card__outcome-time">{outcomeTime}</span>
      {/if}
    </p>
  {/if}
{:else}
  <div class="cinder-approval-card__row-body">
    {#if isUnavailable}
      {#if inputPairs.length > 0}
        <p class="cinder-approval-card__input-summary" data-cinder-static>
          {#each inputPairs as pair, index (pair.label)}
            {#if index > 0}<span class="cinder-approval-card__separator" aria-hidden="true">·</span
              >{' '}{/if}<span class="cinder-approval-card__pair-label">{pair.label}</span
            >{' '}<span
              class="cinder-approval-card__pair-value"
              data-cinder-muted={pair.muted || undefined}>{pair.text}</span
            >{' '}
          {/each}
        </p>
      {/if}
      {#if unavailableReason !== undefined}
        <p class="cinder-approval-card__reason">{unavailableReason}</p>
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
            <span class="cinder-approval-card__input-word">Input</span>
            <span class="cinder-approval-card__input-pairs">
              {#each inputPairs as pair, index (pair.label)}
                {#if index > 0}<span class="cinder-approval-card__separator" aria-hidden="true"
                    >·</span
                  >{' '}{/if}<span class="cinder-approval-card__pair-label">{pair.label}</span
                >{' '}<span
                  class="cinder-approval-card__pair-value"
                  data-cinder-muted={pair.muted || undefined}>{pair.text}</span
                >{' '}
              {/each}
            </span>
          </button>
          <div id={inputId} class="cinder-approval-card__row-input" hidden={!inputOpen}>
            {@render inputBody?.()}
          </div>
        </div>
      {/if}

      {#if disabledReason !== undefined}
        <p id={disabledReasonId} class="cinder-approval-card__reason">{disabledReason}</p>
      {/if}

      {#if canAnswer && rememberScope !== undefined}
        <div class="cinder-approval-card__remember">
          <Checkbox bind:checked={remember} label={rememberLabel} mutating />
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
            disabled={disabledReason !== undefined}
            aria-describedby={disabledReason === undefined ? undefined : disabledReasonId}
            onclick={() => decide('deny')}
          >
            Deny
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            mutating
            disabled={disabledReason !== undefined}
            aria-describedby={disabledReason === undefined ? undefined : disabledReasonId}
            onclick={() => decide('approve')}
          >
            Approve
          </Button>
        </div>
      {/if}
    {/if}
  </div>
{/if}
