<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type {
    ApprovalFact,
    ApprovalFailure,
    ApprovalResolution,
    ApprovalResolving,
    ApprovalState,
    ApprovalTool,
  } from './approval-card.types.ts';

  /** Props of the internal decision surface. Not part of the public API. */
  export type ApprovalCardDecisionProps = {
    /** Id of the root article; the surface derives the ids of its parts from it. */
    rootId: string;
    /** Tag of the action title. */
    titleTag: string;
    /** Id of the action title, which names the article. */
    titleId: string;
    /** The tool asking. */
    tool: ApprovalTool;
    /** The state the approver sees, after expiry is applied. */
    approvalState: ApprovalState;
    /** The action the approval asks about, such as "Refund order 4471 for $42.00?". */
    question: string;
    /** One sentence about the pause. */
    pauseSentence: string | undefined;
    /** Host facts written after the tool, such as Target and Amount. */
    facts: ApprovalFact[];
    /** The command to run, always visible and monospaced, or `undefined` when the operation has none. */
    command: string | undefined;
    /** Why the agent wants to do this, offered as a disclosure. */
    why: string | undefined;
    /** The live countdown, such as "Expires in 4m 10s". */
    countdown: string | undefined;
    /** The checkbox's scope, or `undefined` when the tool never offers it. */
    rememberScope: string | undefined;
    /** The primary action's own words. */
    approveLabel: string | undefined;
    /** Why Deny and the primary action are off while the approval is pending. */
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
    /** The word for what was decided, such as "Approved". */
    outcomeWord: string | undefined;
    /** Green for an approval, neutral for everything else. */
    outcomeTone: 'success' | 'neutral';
    /** Who decided, such as "Priya Raman". */
    decidedBy: string | undefined;
    /** Where it was decided when that was not here, such as "Reviews". */
    decidedIn: string | undefined;
    /** Where `decidedIn` leads. */
    decidedInHref: string | undefined;
    /** When it was decided, such as "10:46 AM". */
    outcomeTime: string | undefined;
    /** The note the approver left with the decision. */
    decisionNote: string | undefined;
    /** A line of context written above the action. */
    context: Snippet | undefined;
    /** Identity of the request; the note, the checkbox and an armed press reset when it changes. */
    requestKey: string;
    /** What the Input disclosure opens onto, or `undefined` when the operation carries nothing more. */
    inputBody: Snippet | undefined;
    /** The pairs of the one-line summary of the input. */
    inputPairs: InputSummaryPair[];
    /** What the input is called. */
    inputLabel: string;
    /** Resolution sink; undefined when the host is not wired to answer, or the approval is not actionable. */
    resolve: ((resolution: ApprovalResolution) => void) | undefined;
  };
</script>

<script lang="ts">
  import Ban from '@lucide/svelte/icons/ban';
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { onDestroy, untrack } from 'svelte';

  import { pushEscapeHandler } from '../../_internal/overlay.ts';
  import Badge from '../badge/badge.svelte';
  import Button from '../button/button.svelte';
  import Checkbox from '../checkbox/checkbox.svelte';
  import CodeBlock from '../code-block/code-block.svelte';
  import Link from '../link/link.svelte';
  import Textarea from '../textarea/textarea.svelte';
  import ApprovalCardFailure from './approval-card-failure.svelte';
  import { describeDecidedAction, STATE_LABELS, UNDECIDED_PREFIX } from './approval-card-state.ts';
  import type { InputSummaryPair } from './approval-card-state.ts';

  let {
    rootId,
    titleTag,
    titleId,
    tool,
    approvalState,
    question,
    pauseSentence,
    facts,
    command,
    why,
    countdown,
    rememberScope,
    approveLabel,
    disabledReason,
    unavailableReason,
    resolving,
    failure,
    notice,
    result,
    footnote,
    outcomeWord,
    outcomeTone,
    decidedBy,
    decidedIn,
    decidedInHref,
    outcomeTime,
    decisionNote,
    context,
    requestKey,
    inputBody,
    inputPairs,
    inputLabel,
    resolve,
  }: ApprovalCardDecisionProps = $props();

  const inputId = $derived(`${rootId}-input`);
  const noteId = $derived(`${rootId}-note`);
  const whyId = $derived(`${rootId}-why`);
  const detailsId = $derived(`${rootId}-receipt-details`);
  const hintId = $derived(`${rootId}-arm-hint`);
  const disabledReasonId = $derived(`${rootId}-disabled-reason`);

  /** How long an armed irreversible action waits for its second press before it reverts. */
  const ARM_MILLISECONDS = 3_000;

  let inputOpen = $state(false);
  let whyOpen = $state(false);
  let detailsOpen = $state(false);
  let noteOpen = $state(false);
  let note = $state('');
  let remember = $state(false);
  let armed = $state(false);

  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let releaseEscape: (() => void) | undefined;

  function disarm(): void {
    if (armTimer !== undefined) {
      clearTimeout(armTimer);
      armTimer = undefined;
    }
    releaseEscape?.();
    releaseEscape = undefined;
    armed = false;
  }

  // The note, the checkbox and an armed press belong to one request. A different request must
  // never inherit what the approver typed or armed for the last one, so the reset compares the
  // previous key by hand: a `$derived` would also re-run on unrelated host updates.
  let previousRequestKey = untrack(() => requestKey);
  $effect(() => {
    if (requestKey === previousRequestKey) return;
    previousRequestKey = requestKey;
    note = '';
    remember = false;
    noteOpen = false;
    disarm();
  });

  onDestroy(disarm);

  const isPending = $derived(approvalState === 'pending');
  const isUnavailable = $derived(approvalState === 'unavailable');
  const isReceipt = $derived(
    approvalState === 'approved' ||
      approvalState === 'approved_with_edits' ||
      approvalState === 'denied',
  );
  const canAnswer = $derived(isPending && resolve !== undefined);
  const isBusy = $derived(resolving !== undefined);
  const actionsOff = $derived(disabledReason !== undefined || isBusy);
  const irreversible = $derived(tool.irreversible === true);
  const primaryLabel = $derived(approveLabel ?? 'Approve');
  const armedLabel = $derived(
    `Press again to ${primaryLabel.charAt(0).toLowerCase()}${primaryLabel.slice(1)}`,
  );

  // A reason that appears while the press is armed drops the arm, so the second press never
  // commits past it; the reason holding the answer back is the one thing to read.
  $effect(() => {
    if (armed && (actionsOff || !canAnswer)) disarm();
  });

  const toolFactValue = $derived(tool.label ?? tool.name);
  const factRows = $derived.by(() => {
    const rows: ApprovalFact[] = [
      tool.label === undefined
        ? { label: 'Tool', value: tool.name, monospace: true }
        : { label: 'Tool', value: toolFactValue },
      ...facts,
    ];
    if (tool.irreversible === false) rows.push({ label: 'Reversible', value: 'Yes' });
    return rows;
  });

  // A decided card says what was decided, in the action's own words, instead of repeating the
  // question it asked: "Refund $42.00, order 4471" beside the Approved badge.
  const decidedAction = $derived(describeDecidedAction(approveLabel, tool, facts, question));
  const undecidedPrefix = $derived(UNDECIDED_PREFIX[approvalState]);

  const hasWho = $derived(decidedBy !== undefined || decidedIn !== undefined);
  // The receipt reads "by Priya Raman in Reviews, 10:46 AM": the place is the only link, and the
  // comma stays with the time. A middle dot never separates them.
  const byText = $derived(decidedBy === undefined ? '' : `by ${decidedBy}`);
  const inText = $derived(decidedIn === undefined ? '' : decidedBy === undefined ? 'in ' : ' in ');
  const timeText = $derived(
    outcomeTime === undefined ? '' : hasWho ? `, ${outcomeTime}` : outcomeTime,
  );
  const hasReceiptDetails = $derived(
    (outcomeTone === 'success' && decisionNote !== undefined && decisionNote !== '') ||
      result !== undefined ||
      command !== undefined,
  );

  function decide(decision: 'approve' | 'deny'): void {
    if (!canAnswer || actionsOff) return;
    const trimmedNote = note.trim();
    const resolution: ApprovalResolution = { decision, remember };
    if (trimmedNote) resolution.reason = trimmedNote;
    resolve?.(resolution);
  }

  function arm(): void {
    armed = true;
    armTimer = setTimeout(disarm, ARM_MILLISECONDS);
    // Escape cancels the press and nothing else: the handler owns the keystroke, so a host that
    // also listens for Escape on the card sees it as handled.
    releaseEscape = pushEscapeHandler((event) => {
      event.preventDefault();
      disarm();
    });
  }

  function pressPrimary(): void {
    if (!canAnswer || actionsOff) return;
    if (irreversible && !armed) {
      arm();
      return;
    }
    disarm();
    decide('approve');
  }

  function pressDeny(): void {
    disarm();
    decide('deny');
  }
</script>

{#if context !== undefined}
  <div class="cinder-approval-card__context">{@render context()}</div>
{/if}

{#if isReceipt}
  <div class="cinder-approval-card__receipt" data-cinder-tone={outcomeTone}>
    <div class="cinder-approval-card__receipt-head">
      <!-- The title says the outcome to assistive technology, so the badge is the visual mark. -->
      <Badge
        variant={outcomeTone === 'success' ? 'success' : 'neutral'}
        size="sm"
        aria-hidden="true"
      >
        {#if outcomeTone === 'success'}
          <Check size={12} strokeWidth={2} aria-hidden="true" />
        {:else}
          <Ban size={12} strokeWidth={2} aria-hidden="true" />
        {/if}
        {outcomeWord ?? STATE_LABELS[approvalState]}
      </Badge>
      <svelte:element
        this={titleTag}
        id={titleId}
        class="cinder-approval-card__decision-title"
        dir="auto"
      >
        <span class="cinder-sr-only">{`${outcomeWord ?? STATE_LABELS[approvalState]}: `}</span
        >{decidedAction}
      </svelte:element>
    </div>
    {#if hasWho || outcomeTime !== undefined}
      <p class="cinder-approval-card__receipt-by">
        {byText}{inText}{#if decidedIn !== undefined}{#if decidedInHref !== undefined}<Link
              href={decidedInHref}>{decidedIn}</Link
            >{:else}{decidedIn}{/if}{/if}{timeText}
      </p>
    {/if}
    {#if approvalState === 'denied' && decisionNote !== undefined && decisionNote !== ''}
      <p class="cinder-approval-card__receipt-quote" dir="auto">
        <span class="cinder-approval-card__receipt-quote-text">&ldquo;{decisionNote}&rdquo;</span>
      </p>
    {/if}
    {#if hasReceiptDetails}
      <div class="cinder-approval-card__input">
        <button
          type="button"
          class="cinder-approval-card__input-toggle"
          aria-expanded={detailsOpen}
          aria-controls={detailsId}
          onclick={() => (detailsOpen = !detailsOpen)}
        >
          <ChevronRight
            class="cinder-approval-card__input-chevron"
            size={12}
            strokeWidth={2}
            aria-hidden="true"
            data-cinder-open={detailsOpen || undefined}
          />
          <span class="cinder-approval-card__input-word">Details</span>
        </button>
        <div id={detailsId} class="cinder-approval-card__receipt-details" hidden={!detailsOpen}>
          {#if outcomeTone === 'success' && decisionNote !== undefined && decisionNote !== ''}
            <p class="cinder-approval-card__decision-note">
              <span class="cinder-approval-card__decision-note-label">Your note</span>
              <span class="cinder-approval-card__decision-note-text" dir="auto">{decisionNote}</span
              >
            </p>
          {/if}
          {#if result !== undefined}
            <p class="cinder-approval-card__result">
              <span class="cinder-approval-card__result-label">Result:</span>
              {result}
            </p>
          {/if}
          {#if command !== undefined}
            <div class="cinder-approval-card__command">
              <CodeBlock
                code={command}
                language="shell"
                languageLabelVisible={false}
                copyable={false}
                wrap
              />
            </div>
          {/if}
        </div>
      </div>
    {/if}
    {#if notice !== undefined}
      <p
        class="cinder-approval-card__readonly-summary"
        data-cinder-state={approvalState}
        dir="auto"
      >
        {notice}
      </p>
    {/if}
  </div>
{:else}
  <div class="cinder-approval-card__decision-head">
    <svelte:element
      this={titleTag}
      id={titleId}
      class="cinder-approval-card__decision-title"
      dir="auto"
    >
      {#if undecidedPrefix !== undefined}{undecidedPrefix}: {decidedAction}{:else}{question}{/if}
    </svelte:element>
    {#if irreversible && undecidedPrefix === undefined}
      <Badge variant="danger" size="sm" class="cinder-approval-card__irreversible"
        >Irreversible</Badge
      >
    {/if}
    {#if !isPending && undecidedPrefix === undefined}
      <span class="cinder-approval-card__state-word" data-cinder-state-word>
        {STATE_LABELS[approvalState]}
      </span>
    {/if}
  </div>
  {#if pauseSentence !== undefined && isPending}
    <p class="cinder-approval-card__pause" dir="auto">{pauseSentence}</p>
  {/if}
  <dl class="cinder-approval-card__facts">
    {#each factRows as fact, index (index)}
      <div class="cinder-approval-card__fact">
        <dt>{fact.label}</dt>
        <dd data-cinder-monospace={fact.monospace || undefined} dir="auto">{fact.value}</dd>
      </div>
    {/each}
    {#if command !== undefined}
      <div class="cinder-approval-card__fact cinder-approval-card__fact--command">
        <dt>Command</dt>
        <dd>
          <div class="cinder-approval-card__command">
            <CodeBlock
              code={command}
              language="shell"
              languageLabelVisible={false}
              copyable={false}
              wrap
            />
          </div>
        </dd>
      </div>
    {/if}
  </dl>
  {#if isPending}
    {#if why !== undefined}
      <div class="cinder-approval-card__input cinder-approval-card__why">
        <button
          type="button"
          class="cinder-approval-card__input-toggle"
          aria-expanded={whyOpen}
          aria-controls={whyId}
          onclick={() => (whyOpen = !whyOpen)}
        >
          <ChevronRight
            class="cinder-approval-card__input-chevron"
            size={12}
            strokeWidth={2}
            aria-hidden="true"
            data-cinder-open={whyOpen || undefined}
          />
          <span class="cinder-approval-card__input-word">Why the agent wants to do this</span>
        </button>
        <p id={whyId} class="cinder-approval-card__why-body" hidden={!whyOpen} dir="auto">{why}</p>
      </div>
    {/if}
    {#if inputBody !== undefined}
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
          {@render inputBody()}
        </div>
      </div>
    {/if}
    {#if countdown !== undefined}
      <p class="cinder-approval-card__countdown" data-cinder-countdown>{countdown}</p>
    {/if}
    {#if canAnswer && failure !== undefined}
      <ApprovalCardFailure {failure} />
    {/if}
    {#if disabledReason !== undefined}
      <p id={disabledReasonId} class="cinder-approval-card__reason" dir="auto">{disabledReason}</p>
    {/if}
    {#if canAnswer && rememberScope !== undefined}
      <div class="cinder-approval-card__remember">
        <Checkbox
          bind:checked={remember}
          label={`Allow ${tool.label ?? tool.name} for ${rememberScope}`}
          disabled={isBusy}
          mutating
        />
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
          onclick={pressDeny}
        >
          {resolving === 'deny' ? 'Denying…' : 'Deny'}
        </Button>
        <Button
          type="button"
          variant={armed ? 'danger' : 'primary'}
          size="sm"
          mutating
          disabled={isBusy && resolving !== 'approve'}
          aria-disabled={disabledReason === undefined ? undefined : 'true'}
          loading={resolving === 'approve'}
          loadingStatus="Approving…"
          aria-describedby={disabledReason !== undefined
            ? disabledReasonId
            : armed
              ? hintId
              : undefined}
          onclick={pressPrimary}
        >
          {resolving === 'approve' ? 'Approving…' : armed ? armedLabel : primaryLabel}
        </Button>
      </div>
      {#if armed}
        <p id={hintId} class="cinder-approval-card__arm-hint" role="status" dir="auto">
          Reverts in 3 seconds. Escape cancels.
        </p>
      {/if}
      {#if footnote !== undefined}
        <p class="cinder-approval-card__footnote" dir="auto">{footnote}</p>
      {/if}
    {/if}
  {:else if isUnavailable && unavailableReason !== undefined}
    <p class="cinder-approval-card__reason" dir="auto">{unavailableReason}</p>
  {/if}
  {#if !isPending && notice !== undefined}
    <p class="cinder-approval-card__readonly-summary" data-cinder-state={approvalState} dir="auto">
      {notice}
    </p>
  {/if}
{/if}
