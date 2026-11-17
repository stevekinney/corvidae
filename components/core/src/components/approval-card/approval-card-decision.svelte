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
    /** Host facts written after the tool, such as Target and Amount. */
    facts: ApprovalFact[];
    /** The command to run, always visible and monospaced, or `undefined` when the operation has none. */
    command: string | undefined;
    /** Why the agent wants to do this, offered as a disclosure. */
    why: string | undefined;
    /** The live countdown, such as "Expires in 4m 10s". */
    countdown: string | undefined;
    /** The countdown as a narrow card writes it, such as "Expires Nov 17". */
    countdownShort: string | undefined;
    /** What approving does; the warning glyph's tooltip says it when the action cannot be undone. */
    consequence: string | undefined;
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
    /** Requests a fresh approval after expiration. */
    onAskAgain: (() => void) | undefined;
    /** The note the approver left with the decision. */
    decisionNote: string | undefined;
    /** A line of context written above the action. */
    context: Snippet | undefined;
    /** Identity of the request; the note, the checkbox and an armed press reset when it changes. */
    requestKey: string;
    /** The patch and the touched files, shown in the open, or `undefined` when the operation carries neither. */
    operationBody: Snippet | undefined;
    /** The rows of the input, shown in the open while the approval waits. */
    inputRows: InputRow[];
    /** What the input is called. */
    inputLabel: string;
    /** Resolution sink; undefined when the host is not wired to answer, or the approval is not actionable. */
    resolve: ((resolution: ApprovalResolution) => void) | undefined;
  };
</script>

<script lang="ts">
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import { untrack } from 'svelte';

  import Button from '../button/button.svelte';
  import Checkbox from '../checkbox/checkbox.svelte';
  import CodeBlock from '../code-block/code-block.svelte';
  import Link from '@lostgradient/link/components/link/link.svelte';
  import InlineConfirm from '../inline-confirm/inline-confirm.svelte';
  import Textarea from '../textarea/textarea.svelte';
  import ApprovalCardSettled from './approval-card-settled.svelte';
  import ApprovalCardFactsLine from './approval-card-facts-line.svelte';
  import { fitNoteLabel } from './approval-card-note-fit.ts';
  import ApprovalCardNoteToggle from './approval-card-note-toggle.svelte';
  import ApprovalCardFailure from './approval-card-failure.svelte';
  import { describeDecidedAction, STATE_LABELS, UNDECIDED_PREFIX } from './approval-card-state.ts';
  import ApprovalCardInputRows from './approval-card-input-rows.svelte';
  import type { InputRow } from './approval-card-state.ts';

  let {
    rootId,
    titleTag,
    titleId,
    tool,
    approvalState,
    question,
    facts,
    command,
    why,
    countdown,
    countdownShort,
    consequence,
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
    onAskAgain,
    decisionNote,
    context,
    requestKey,
    operationBody,
    inputRows,
    inputLabel,
    resolve,
  }: ApprovalCardDecisionProps = $props();

  const inputId = $derived(`${rootId}-input`);
  const noteId = $derived(`${rootId}-note`);
  const whyId = $derived(`${rootId}-why`);
  const detailsId = $derived(`${rootId}-receipt-details`);
  const hintId = $derived(`${rootId}-arm-hint`);
  const disabledReasonId = $derived(`${rootId}-disabled-reason`);

  let whyOpen = $state(false);
  let detailsOpen = $state(false);
  let noteOpen = $state(false);
  let note = $state('');
  let remember = $state(false);
  let armed = $state(false);

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
  });

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
  const factRows = $derived.by(() => {
    const rows: ApprovalFact[] = [...facts];
    // The irreversible fact states reversibility once; a second "Reversible" row never joins it.
    if (tool.irreversible === false && !irreversible)
      rows.push({ label: 'Reversible', value: 'Yes' });
    return rows;
  });

  // A decided card says what was decided, in the action's own words, instead of repeating the
  // question it asked: "Refund $42.00, order 4471" beside the Approved badge.
  const decidedAction = $derived(describeDecidedAction(approveLabel, tool, facts, question));
  const undecidedPrefix = $derived(UNDECIDED_PREFIX[approvalState]);

  const hasWho = $derived(decidedBy !== undefined || decidedIn !== undefined);
  // The status line reads "Approved by Priya Raman in Reviews": the place is the only link. When it
  // was decided is the host's to say under the card, as it says an expired card's.
  const byText = $derived(decidedBy === undefined ? '' : `by ${decidedBy}`);
  const inText = $derived(decidedIn === undefined ? '' : decidedBy === undefined ? 'in ' : ' in ');
  // The note, the result and the command are what a receipt has beyond its one line, in one
  // disclosure.
  const hasNote = $derived(decisionNote !== undefined && decisionNote !== '');
  const hasReceiptDetails = $derived(hasNote || result !== undefined || command !== undefined);

  function decide(decision: 'approve' | 'deny'): void {
    if (!canAnswer || actionsOff) return;
    const trimmedNote = note.trim();
    const resolution: ApprovalResolution = { decision, remember };
    if (trimmedNote) resolution.reason = trimmedNote;
    resolve?.(resolution);
  }

  function pressDeny(): void {
    armed = false;
    decide('deny');
  }
</script>

{#if context !== undefined}
  <div class="cinder-approval-card__context">{@render context()}</div>
{/if}

{#if approvalState === 'expired'}
  <ApprovalCardSettled
    {titleTag}
    {titleId}
    title={question}
    stateName="Expired before a decision"
    {onAskAgain}
    titleClass="cinder-approval-card__decision-title"
  >
    {#snippet status()}Expired before a decision{/snippet}
  </ApprovalCardSettled>
{:else if isReceipt}
  <div class="cinder-approval-card__receipt" data-cinder-tone={outcomeTone}>
    <!-- The same pattern as an expired card: the decided action as the title, one status line, and
         the time under the card, which the host writes as it writes a message's. -->
    <ApprovalCardSettled
      {titleTag}
      {titleId}
      title={decidedAction}
      stateName={outcomeWord ?? STATE_LABELS[approvalState]}
      tone={outcomeTone}
      titleClass="cinder-approval-card__decision-title"
    >
      {#snippet status()}
        {outcomeWord ??
          STATE_LABELS[
            approvalState
          ]}{#if hasWho}{' '}{byText}{inText}{#if decidedIn !== undefined}{#if decidedInHref !== undefined}<Link
                href={decidedInHref}>{decidedIn}</Link
              >{:else}{decidedIn}{/if}{/if}{/if}
      {/snippet}
    </ApprovalCardSettled>
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
          {#if hasNote}
            <p class="cinder-approval-card__decision-note">
              <span class="cinder-approval-card__decision-note-label">Your note:</span>
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
    {#if undecidedPrefix === undefined}
      <ApprovalCardFactsLine
        countdown={isPending ? countdown : undefined}
        countdownShort={isPending ? countdownShort : undefined}
        {irreversible}
        undoneExplanation={consequence ?? "Can't be undone"}
      />
    {/if}
    {#if !isPending && undecidedPrefix === undefined}
      <span class="cinder-approval-card__state-word" data-cinder-state-word>
        {STATE_LABELS[approvalState]}
      </span>
    {/if}
  </div>
  <!-- Drawn only with something in it: an empty list would stand a second stack gap under the title. -->
  {#if factRows.length > 0 || command !== undefined}
    <dl class="cinder-approval-card__facts">
      {#each factRows as fact, index (index)}
        <div class="cinder-approval-card__fact">
          <dt dir="auto">{fact.label}</dt>
          <dd data-cinder-monospace={fact.monospace || undefined} dir="auto">{fact.value}</dd>
        </div>
      {/each}
      {#if command !== undefined}
        <div class="cinder-approval-card__fact cinder-approval-card__fact--command">
          <dt class="cinder-sr-only">Command</dt>
          <dd class="cinder-approval-card__command-value" dir="auto">
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
  {/if}
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
    {@render operationBody?.()}
    {#if inputRows.length > 0}
      <ApprovalCardInputRows id={inputId} label={inputLabel} rows={inputRows} />
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
          label="Note"
          description="Saved with your decision. If you deny, the agent reads it as the reason."
          placeholder="Add a note for the agent or the record"
          rows={2}
          size="sm"
          disabled={isBusy}
        />
      </div>
    {/if}
    {#if canAnswer}
      <div
        class="cinder-approval-card__row-actions"
        role="group"
        aria-label="Approval actions"
        {@attach fitNoteLabel}
      >
        {#if !noteOpen}
          <ApprovalCardNoteToggle
            disabled={isBusy}
            fieldId={noteId}
            onOpen={() => (noteOpen = true)}
          />
        {/if}
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
        <InlineConfirm
          presentation="two-press"
          bind:armed
          confirmLabel={primaryLabel}
          {armedLabel}
          armedHint="Reverts in 3 seconds."
          armedEscapeHint="Escape cancels."
          {requestKey}
          requiresSecondPress={irreversible}
          mutating
          disabled={isBusy}
          blocked={disabledReason !== undefined}
          ariaDisabled={disabledReason !== undefined}
          loading={resolving === 'approve'}
          loadingLabel="Approving…"
          ariaDescribedBy={disabledReason === undefined ? hintId : disabledReasonId}
          hintClass="cinder-approval-card__arm-hint"
          {hintId}
          onConfirm={() => decide('approve')}
        />
      </div>
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
