<script lang="ts" module>
  /**
   * @cinder
   * @category domain
   * @status alpha
   * @purpose Durable human-in-the-loop approval surface for reviewing risky tool operations before they execute.
   * @tag approval
   * @tag human-in-the-loop
   * @tag tool
   * @useWhen A tool call, command, file write, or patch needs explicit human approval before execution.
   * @useWhen Showing policy, sandbox, idempotency, environment-name, and argument context for an approval request.
   * @avoidWhen The action has already completed and only needs historical display — use feed or run-step-timeline instead.
   * @avoidWhen Collecting arbitrary form input for a workflow — compose form controls directly instead.
   * @related card, badge, status-dot, payload-inspector, code-block, collapsible
   * @a11yNote Renders as an article with native button controls so approval actions are discoverable without polluting the landmark list.
   * @a11yNote Expiration changes update the visible state but do not fire approval callbacks automatically.
   */
  export type {
    ApprovalCardCallbacks,
    ApprovalCardHeadingLevel,
    ApprovalCardLayout,
    ApprovalCardProps,
    ApprovalCardSchemaProps,
    ApprovalFailure,
    ApprovalOperation,
    ApprovalOperationKind,
    ApprovalResolution,
    ApprovalResolutionDecision,
    ApprovalResolving,
    ApprovalSandbox,
    ApprovalState,
    ApprovalTool,
    ApprovalToolRisk,
  } from './approval-card.types.ts';
</script>

<script lang="ts">
  import Check from '@lucide/svelte/icons/check';
  import ChevronRight from '@lucide/svelte/icons/chevron-right';
  import ShieldAlert from '@lucide/svelte/icons/shield-alert';

  import { classNames } from '../../utilities/class-names.ts';
  import { formatRelativeTime, formatTimeOfDay } from '../../utilities/format-date.ts';
  import Badge from '../badge/badge.svelte';
  import Card from '../card/card.svelte';
  import CodeBlock from '../code-block/code-block.svelte';
  import Collapsible from '../collapsible/collapsible.svelte';
  import CopyButton from '../copy-button/copy-button.svelte';
  import Link from '../link/link.svelte';
  import PayloadInspector from '../payload-inspector/payload-inspector.svelte';
  import StatusDot from '../status-dot/status-dot.svelte';
  import Tooltip from '../tooltip/tooltip.svelte';
  import ApprovalCardActions from './approval-card-actions.svelte';
  import ApprovalCardFailure from './approval-card-failure.svelte';
  import ApprovalCardOutcome from './approval-card-outcome.svelte';
  import ApprovalCardRow from './approval-card-row.svelte';
  import {
    RISK_LABELS,
    RISK_WORDS,
    STATE_DOT_STATUS,
    STATE_LABELS,
    dedupeFilePaths,
    describeDecisionTime,
    describeExpiry,
    formatRemainingTime,
    isApprovalActionable,
    normalizeArgumentsPreviewValue,
    parseExpirationTimestamp,
    prepareArgumentsPreview,
    resolveEffectiveApprovalState,
    sanitizeEnvironmentNames,
    summarizeInput,
  } from './approval-card-state.ts';
  import type {
    ApprovalCardProps,
    ApprovalResolution,
    ApprovalState,
  } from './approval-card.types.ts';

  const generatedId = $props.id();

  let {
    tool,
    sandbox,
    operation,
    env = [],
    snapshotId,
    policyVersion,
    idempotencyKey,
    expiresAt,
    state: approvalState,
    editableArgs = false,
    headingLevel = 3,
    layout = 'card',
    question,
    source,
    sourcePrefix,
    sourceHref,
    sourceIn,
    sourceInHref,
    said,
    eyebrow,
    toolPrefix,
    requestedAt,
    consequence,
    rememberScope,
    decidedBy,
    decidedAt,
    decisionNote,
    disabledReason,
    unavailableReason,
    resolving,
    failure,
    notice,
    result,
    decidedIn,
    outcomeLabel,
    footnote,
    inputLabel,
    context,
    view = $bindable('fields'),
    now,
    onResolve,
    id,
    class: customClassName,
    ...rest
  }: ApprovalCardProps = $props();

  const rootId = $derived(id ?? generatedId);
  const rowQuestion = $derived(question ?? `Run ${tool.name}?`);
  const titleId = $derived(`${rootId}-title`);
  const saidId = $derived(`${rootId}-said`);
  let saidOpen = $state(false);

  // Coerce + clamp like Card: schema-driven callers can pass out-of-range or
  // non-numeric levels, and `h${level}` must never emit invalid markup.
  const resolvedHeadingLevel = $derived(
    Number.isFinite(Math.trunc(Number(headingLevel)))
      ? Math.min(6, Math.max(2, Math.trunc(Number(headingLevel))))
      : 3,
  );
  const titleTag = $derived(`h${resolvedHeadingLevel}`);
  const sectionTag = $derived(`h${Math.min(6, resolvedHeadingLevel + 1)}`);

  let currentTime = $state<number | undefined>();
  let expirationTimer: ReturnType<typeof setTimeout> | undefined;

  const expirationTimestamp = $derived(parseExpirationTimestamp(expiresAt));
  const effectiveState = $derived<ApprovalState>(
    resolveEffectiveApprovalState(approvalState, expirationTimestamp, currentTime),
  );
  const isActionable = $derived(
    isApprovalActionable(approvalState, expirationTimestamp, currentTime),
  );
  // Guards against a non-function truthy value reaching a JS (non-typechecked)
  // or schema-driven caller — `onResolve?.()` alone would still throw on a
  // truthy non-function.
  const hasResolutionCallback = $derived(typeof onResolve === 'function');

  const riskLabel = $derived(RISK_LABELS[tool.risk]);
  const riskWord = $derived(RISK_WORDS[tool.risk]);
  const isDetail = $derived(layout === 'detail');
  const sourceText = $derived(
    source === undefined
      ? undefined
      : `${sourcePrefix ?? (isDetail ? 'Asked by' : 'Approval from')} ${source}`,
  );
  const hasSourcePlace = $derived(source !== undefined && sourceIn !== undefined);
  // How long ago the request was made only matters while someone can still answer it.
  const requestedDate = $derived(requestedAt === undefined ? undefined : new Date(requestedAt));
  const requestedValid = $derived(
    requestedDate !== undefined && !Number.isNaN(requestedDate.getTime()),
  );
  const requestedText = $derived.by(() => {
    if (
      !requestedValid ||
      requestedDate === undefined ||
      (effectiveState !== 'pending' && effectiveState !== 'unavailable')
    ) {
      return undefined;
    }
    const relative = formatRelativeTime(requestedDate, { now });
    // The detail page counts how long the question has waited: "waiting 4 min", not "4 min ago".
    return isDetail && relative !== 'just now'
      ? `waiting ${relative.replace(/\s+ago$/, '')}`
      : relative;
  });
  const requestedIso = $derived(
    requestedValid && requestedDate !== undefined ? requestedDate.toISOString() : undefined,
  );
  const decidedDate = $derived(decidedAt === undefined ? undefined : new Date(decidedAt));
  const outcomeTime = $derived(
    decidedDate !== undefined && !Number.isNaN(decidedDate.getTime())
      ? formatTimeOfDay(decidedDate)
      : undefined,
  );
  // "Approved by you in Reviews at 10:44 AM" when a card was decided somewhere else, otherwise
  // "Denied by you" with the time after a middot, as the row writes it too: "Approved by you in
  // Reviews · 10:46 AM".
  const outcomeBase = $derived(
    effectiveState === 'pending' || effectiveState === 'unavailable'
      ? undefined
      : `${outcomeLabel ?? STATE_LABELS[effectiveState]}${decidedBy === undefined ? '' : ` by ${decidedBy}`}${decidedIn === undefined ? '' : ` in ${decidedIn}`}`,
  );
  const outcomeText = $derived(
    outcomeBase !== undefined &&
      decidedIn !== undefined &&
      outcomeTime !== undefined &&
      layout !== 'row'
      ? `${outcomeBase} at ${outcomeTime}`
      : outcomeBase,
  );
  // The Done detail writes the day after the time ("10:33 AM today"); the other layouts keep the clock alone.
  const outcomeClock = $derived(
    decidedIn !== undefined && layout !== 'row'
      ? undefined
      : isDetail && decidedDate !== undefined && outcomeTime !== undefined
        ? describeDecisionTime(decidedDate, now)
        : outcomeTime,
  );
  // An approval is green, and every other decision is neutral text: a denial is not an error.
  const outcomeTone = $derived<'success' | 'neutral'>(
    effectiveState === 'approved' || effectiveState === 'approved_with_edits'
      ? 'success'
      : 'neutral',
  );
  const decisionNoteCaption = $derived(
    decisionNote === undefined
      ? undefined
      : effectiveState === 'denied'
        ? 'Sent to the agent as the reason.'
        : 'Saved with your decision.',
  );
  const isDecidedState = $derived(
    effectiveState === 'approved' ||
      effectiveState === 'approved_with_edits' ||
      effectiveState === 'denied',
  );
  const stateText = $derived(STATE_LABELS[effectiveState]);
  // An approval answered somewhere else replaces the card with what happened and who did it, so
  // nobody answers twice: "Approved by you in Reviews at 10:44 AM", then one sentence about it.
  const answeredElsewhere = $derived(
    layout === 'card' && decidedIn !== undefined && isDecidedState && outcomeText !== undefined,
  );
  // A question answered elsewhere has no tool to name, so its sentence is the question itself.
  const elsewhereSentence = $derived(
    [
      outcomeLabel === undefined
        ? `${rowQuestion.replace(/\?$/, '')} · ${tool.label ?? tool.name}.`
        : rowQuestion,
      notice,
    ]
      .filter((part) => part !== undefined && part !== '')
      .join(' '),
  );
  // An approval that passed the time its request set says when, unless the host wrote its own.
  const resolvedNotice = $derived(
    notice ??
      (effectiveState === 'expired' && expirationTimestamp !== undefined
        ? describeExpiry(expirationTimestamp)
        : undefined),
  );
  // The card says who decided and when only once someone did.
  const showCardOutcome = $derived(
    outcomeText !== undefined &&
      (decidedBy !== undefined || decidedAt !== undefined || decidedIn !== undefined),
  );
  // The Done detail is the record of a decision: eyebrow, question, who decided and when, the input
  // and the result. What the tool is and what approving would do are asked only while it is open.
  const detailDone = $derived(layout === 'detail' && isDecidedState && showCardOutcome);
  // A read-only approval says why only when there is something to say: the outcome line already
  // names a decision, so a sentence repeating the state would just be noise.
  const readonlySummary = $derived(
    resolvedNotice ??
      (effectiveState === 'unavailable' && unavailableReason !== undefined
        ? unavailableReason
        : showCardOutcome
          ? undefined
          : `No approval actions are available because this request is ${stateText.toLowerCase()}.`),
  );
  // Only a live countdown is shown. Once the state itself reads "Expired" (via
  // StatusDot's label), a second "Expired" badge would just repeat the same word.
  const expirationText = $derived.by(() => {
    if (
      approvalState !== 'pending' ||
      effectiveState !== 'pending' ||
      expirationTimestamp === undefined ||
      currentTime === undefined
    ) {
      return undefined;
    }
    return `Expires in ${formatRemainingTime(expirationTimestamp - currentTime)}`;
  });

  const payloadLabel = $derived(
    inputLabel ?? (layout === 'card' ? `${tool.name} arguments` : 'Input'),
  );
  const hasArgumentsPreview = $derived(operation.argsPreview !== undefined);
  const editableArgumentsValue = $derived(normalizeArgumentsPreviewValue(operation.argsPreview));
  const argumentsPreview = $derived(prepareArgumentsPreview(editableArgumentsValue));
  const inputPairs = $derived(hasArgumentsPreview ? summarizeInput(operation.argsPreview) : []);
  const canEditArguments = $derived(editableArgs && hasArgumentsPreview);
  const filesTouched = $derived(dedupeFilePaths(operation.filesTouched ?? []));
  const filesTouchedLabel = $derived(
    `${filesTouched.length} file${filesTouched.length === 1 ? '' : 's'}`,
  );
  const environmentNames = $derived(sanitizeEnvironmentNames(env));
  // The row's Input discloses only what the operation carries.
  // Details holds what the host adds about where the request runs. Without any of it there is nothing to disclose.
  const hasDetails = $derived(
    sandbox !== undefined || environmentNames.length > 0 || snapshotId !== undefined,
  );
  const hasRowInput = $derived(
    (operation.kind === 'command' && Boolean(operation.command)) ||
      (operation.kind === 'patch' && Boolean(operation.diff)) ||
      filesTouched.length > 0 ||
      hasArgumentsPreview,
  );

  $effect(() => {
    clearExpirationTimer();

    if (approvalState === 'pending' && expirationTimestamp !== undefined) {
      const updateCurrentTime = () => {
        const nextCurrentTime = Date.now();
        currentTime = nextCurrentTime;
        if (nextCurrentTime >= expirationTimestamp) {
          clearExpirationTimer();
          return;
        }

        const nextDelay = Math.min(1_000, expirationTimestamp - nextCurrentTime);
        expirationTimer = setTimeout(updateCurrentTime, nextDelay);
      };

      updateCurrentTime();
    }

    return clearExpirationTimer;
  });

  function clearExpirationTimer(): void {
    if (expirationTimer !== undefined) {
      clearTimeout(expirationTimer);
      expirationTimer = undefined;
    }
  }

  function resolveIfActionable(resolution: ApprovalResolution): void {
    // Re-check against the wall clock: the countdown timer only ticks once per
    // second, so a click can land after the deadline but before the next tick.
    const comparisonTime = expirationTimestamp === undefined ? currentTime : Date.now();
    // An answer already on its way is the only one: a second press would answer twice.
    if (resolving !== undefined) return;
    if (!isApprovalActionable(approvalState, expirationTimestamp, comparisonTime)) {
      if (approvalState === 'pending' && expirationTimestamp !== undefined) {
        currentTime = comparisonTime;
      }
      return;
    }
    if (typeof onResolve === 'function') onResolve(resolution);
  }
</script>

{#snippet sourceName()}
  {#if sourceHref !== undefined}<Link href={sourceHref}>{source}</Link>{:else}{source}{/if}
{/snippet}

{#snippet sourcePlace()}
  {#if sourceInHref !== undefined}<Link href={sourceInHref}>{sourceIn}</Link>{:else}{sourceIn}{/if}
{/snippet}

<!-- "Tool runner in Please refund order 4471", the name and the place each a link when it has one. -->
{#snippet askedFrom()}
  {@render sourceName()}{#if hasSourcePlace}{' in '}{@render sourcePlace()}{/if}
{/snippet}

{#snippet operationPreview()}
  {#if operation.kind === 'command' && operation.command}
    <div class="cinder-approval-card__section">
      <CodeBlock code={operation.command} language="shell" languageLabelVisible={false} />
    </div>
  {:else if operation.kind === 'patch' && operation.diff}
    <div class="cinder-approval-card__section">
      <CodeBlock code={operation.diff} language="diff" languageLabelVisible={false} />
    </div>
  {/if}
{/snippet}

{#snippet filesTouchedSection()}
  {#if filesTouched.length > 0}
    <div class="cinder-approval-card__section">
      <div class="cinder-approval-card__section-heading">
        <svelte:element this={sectionTag} class="cinder-approval-card__section-title">
          Files touched
        </svelte:element>
        <Badge size="sm">{filesTouchedLabel}</Badge>
      </div>
      <ul class="cinder-approval-card__file-list">
        {#each filesTouched as file (file)}
          <li class="cinder-approval-card__file">
            <span class="cinder-approval-card__file-path">{file}</span>
            <CopyButton
              value={file}
              label={`Copy path ${file}`}
              copiedLabel="Path copied"
              class="cinder-approval-card__file-copy"
              iconOnly
            />
          </li>
        {/each}
      </ul>
    </div>
  {/if}
{/snippet}

{#snippet argumentsPreviewSection()}
  {#if hasArgumentsPreview}
    <div class="cinder-approval-card__section">
      <PayloadInspector
        value={argumentsPreview.value}
        truncated={argumentsPreview.truncated}
        label={payloadLabel}
        bind:view
      />
    </div>
  {/if}
{/snippet}

{#snippet rowInputBody()}
  {@render operationPreview()}
  {@render filesTouchedSection()}
  {#if hasArgumentsPreview}
    <div class="cinder-approval-card__section">
      <PayloadInspector
        value={argumentsPreview.value}
        truncated={argumentsPreview.truncated}
        label={payloadLabel}
        bind:view
      />
    </div>
  {/if}
{/snippet}

{#if answeredElsewhere}
  <article
    {...rest}
    id={rootId}
    class={classNames('cinder-approval-card', 'cinder-approval-card--elsewhere', customClassName)}
    aria-labelledby={titleId}
    data-cinder-state={effectiveState}
    data-cinder-risk={tool.risk}
    data-cinder-layout="card"
  >
    <Check
      class="cinder-approval-card__elsewhere-glyph"
      size={16}
      strokeWidth={2}
      aria-hidden="true"
    />
    <div class="cinder-approval-card__elsewhere-text">
      <svelte:element this={titleTag} id={titleId} class="cinder-approval-card__elsewhere-title">
        {outcomeText}
      </svelte:element>
      <p class="cinder-approval-card__elsewhere-body">{elsewhereSentence}</p>
    </div>
  </article>
{:else if layout === 'row'}
  <article
    {...rest}
    id={rootId}
    class={classNames('cinder-approval-card', 'cinder-approval-card--row', customClassName)}
    aria-labelledby={titleId}
    data-cinder-state={effectiveState}
    data-cinder-risk={tool.risk}
    data-cinder-layout="row"
  >
    <ApprovalCardRow
      {rootId}
      {titleTag}
      {titleId}
      {tool}
      approvalState={effectiveState}
      question={rowQuestion}
      {sourceText}
      {requestedText}
      {requestedIso}
      {consequence}
      {rememberScope}
      {outcomeText}
      outcomeTime={outcomeClock}
      {outcomeTone}
      {decisionNote}
      {decisionNoteCaption}
      {disabledReason}
      {unavailableReason}
      {resolving}
      {failure}
      notice={resolvedNotice}
      {result}
      {footnote}
      inputLabel={payloadLabel}
      {context}
      requestKey={idempotencyKey}
      {inputPairs}
      inputBody={hasRowInput ? rowInputBody : undefined}
      resolve={isActionable && hasResolutionCallback ? resolveIfActionable : undefined}
    />
  </article>
{:else if layout === 'detail'}
  <article
    {...rest}
    id={rootId}
    class={classNames('cinder-approval-card', 'cinder-approval-card--detail', customClassName)}
    aria-labelledby={titleId}
    data-cinder-state={effectiveState}
    data-cinder-risk={tool.risk}
    data-cinder-layout="detail"
  >
    <header class="cinder-approval-card__detail-header">
      <p class="cinder-approval-card__detail-eyebrow">
        <span
          class="cinder-approval-card__risk-icon"
          role="img"
          aria-label={riskLabel}
          data-cinder-risk={tool.risk}
        >
          <ShieldAlert size={16} strokeWidth={2} aria-hidden="true" />
        </span>
        <span>{eyebrow ?? 'Tool approval'}</span>
      </p>
      <svelte:element this={titleTag} id={titleId} class="cinder-approval-card__title">
        {rowQuestion}
      </svelte:element>
      {#if showCardOutcome && isDecidedState && outcomeText !== undefined}
        <ApprovalCardOutcome
          {outcomeText}
          outcomeTime={outcomeClock}
          tone={outcomeTone}
          inlineTime
          trailing={source === undefined ? undefined : askedFrom}
          {decisionNote}
          {decisionNoteCaption}
        />
      {:else if source !== undefined || requestedText !== undefined || !isActionable || !hasResolutionCallback}
        <p class="cinder-approval-card__detail-ask">
          {#if source !== undefined}<span
              >{sourcePrefix ?? 'Asked by'}{' '}{@render askedFrom()}</span
            >{#if requestedText !== undefined}{'\u00a0'}<span
                class="cinder-approval-card__separator cinder-approval-card__time-separator"
                aria-hidden="true">·</span
              >{/if}{/if}
          {#if requestedText !== undefined}<time datetime={requestedIso}>{requestedText}</time>{/if}
          {#if effectiveState !== 'pending' || !isActionable || !hasResolutionCallback}
            {#if source !== undefined || requestedText !== undefined}
              <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
            {/if}
            <StatusDot status={STATE_DOT_STATUS[effectiveState]} label={stateText} size="sm" />
          {/if}
        </p>
      {/if}
      {#if said !== undefined && said !== ''}
        <div class="cinder-approval-card__said">
          <button
            type="button"
            class="cinder-approval-card__said-toggle"
            aria-expanded={saidOpen}
            aria-controls={saidId}
            onclick={() => (saidOpen = !saidOpen)}
          >
            <ChevronRight
              class="cinder-approval-card__said-chevron"
              size={12}
              strokeWidth={2}
              aria-hidden="true"
              data-cinder-open={saidOpen || undefined}
            />
            <span class="cinder-approval-card__said-label">{source ?? 'It'} said</span>
            <span
              id={saidId}
              class="cinder-approval-card__said-text"
              data-cinder-open={saidOpen || undefined}>{said}</span
            >
          </button>
        </div>
      {/if}
      {#if context !== undefined}
        <div class="cinder-approval-card__context">{@render context()}</div>
      {/if}
      {#if !detailDone}
        <p class="cinder-approval-card__detail-tool">
          {toolPrefix ?? 'It wants to run'}{' '}{#if tool.label !== undefined}<span
              class="cinder-approval-card__tool-label">{tool.label}</span
            >{' '}{/if}<code class="cinder-approval-card__tool-identifier">{tool.name}</code
          >{'\u00a0'}<span class="cinder-approval-card__separator" aria-hidden="true">·</span>
          <span class="cinder-approval-card__risk-word">{riskWord}</span>
        </p>
      {/if}
    </header>

    <div class="cinder-approval-card__detail-body">
      {@render operationPreview()}
      {@render filesTouchedSection()}
      {@render argumentsPreviewSection()}

      {#if !detailDone && (tool.irreversible || consequence !== undefined)}
        <p class="cinder-approval-card__detail-risk">
          <ShieldAlert size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            {#if tool.irreversible}<span class="cinder-approval-card__undone">Can't be undone.</span
              >{' '}{/if}{#if consequence !== undefined}<span
                class="cinder-approval-card__consequence">{consequence}</span
              >{/if}
          </span>
        </p>
      {/if}

      {#if isActionable && hasResolutionCallback}
        {#if failure !== undefined}
          <ApprovalCardFailure {failure} />
        {/if}
        <ApprovalCardActions
          idBase={rootId}
          requestKey={idempotencyKey}
          toolName={tool.label ?? tool.name}
          {rememberScope}
          {disabledReason}
          {resolving}
          {canEditArguments}
          argumentsValue={editableArgumentsValue}
          resolve={resolveIfActionable}
        />
        {#if footnote !== undefined}
          <p class="cinder-approval-card__footnote">{footnote}</p>
        {/if}
      {:else}
        {#if resolvedNotice !== undefined || (effectiveState === 'unavailable' && unavailableReason !== undefined)}
          <p class="cinder-approval-card__readonly-summary" data-cinder-state={effectiveState}>
            {resolvedNotice ?? unavailableReason}
          </p>
        {/if}
        {#if result !== undefined}
          <p class="cinder-approval-card__result">
            <span class="cinder-approval-card__result-label">Result:</span>
            {result}
          </p>
        {/if}
      {/if}
    </div>
  </article>
{:else}
  <article
    {...rest}
    id={rootId}
    class={classNames('cinder-approval-card', customClassName)}
    aria-labelledby={titleId}
    data-cinder-state={effectiveState}
    data-cinder-risk={tool.risk}
  >
    <Card padding="none" class="cinder-approval-card__surface">
      {#snippet header()}
        <div class="cinder-approval-card__header">
          <Tooltip text={riskLabel} describe={false}>
            <!-- svelte-ignore a11y_no_noninteractive_tabindex (Keyboard focus exposes the risk tooltip without inventing a button action.) -->
            <span
              class="cinder-approval-card__risk-icon"
              role="img"
              tabindex="0"
              aria-label={riskLabel}
              data-cinder-risk={tool.risk}
            >
              <ShieldAlert size={16} strokeWidth={2} aria-hidden="true" />
            </span>
          </Tooltip>
          <div class="cinder-approval-card__title-group">
            {#if context !== undefined}
              <div class="cinder-approval-card__context">{@render context()}</div>
            {/if}
            {#if sourceText !== undefined || requestedText !== undefined}
              <p class="cinder-approval-card__eyebrow">
                {#if sourceText !== undefined}<span>{sourceText}</span
                  >{#if requestedText !== undefined}{'\u00a0'}<span
                      class="cinder-approval-card__separator cinder-approval-card__time-separator"
                      aria-hidden="true">·</span
                    >{/if}{/if}
                {#if requestedText !== undefined}<time datetime={requestedIso}>{requestedText}</time
                  >{/if}
              </p>
            {/if}
            <svelte:element this={titleTag} id={titleId} class="cinder-approval-card__title">
              {#if question !== undefined}
                {question}
              {:else}
                Approval required for
                <span class="cinder-approval-card__title-tool">{tool.name}</span>
              {/if}
            </svelte:element>
            {#if question !== undefined}
              <p class="cinder-approval-card__tool-line">
                {#if tool.label !== undefined}<span class="cinder-approval-card__tool-label"
                    >{tool.label}</span
                  >{' '}{/if}<code class="cinder-approval-card__tool-identifier">{tool.name}</code>
              </p>
            {/if}
            <p class="cinder-approval-card__risk-line">
              <span class="cinder-approval-card__risk-word">{riskWord}</span>
              {#if tool.irreversible}
                <span class="cinder-approval-card__separator" aria-hidden="true">·</span>
                <span class="cinder-approval-card__undone">Can't be undone</span>
              {/if}
            </p>
            {#if consequence !== undefined}
              <p class="cinder-approval-card__consequence">{consequence}</p>
            {/if}
          </div>
          <div class="cinder-approval-card__badges" role="group" aria-label="Approval status">
            {#if effectiveState !== 'pending' || !isActionable || !hasResolutionCallback}
              <StatusDot status={STATE_DOT_STATUS[effectiveState]} label={stateText} size="sm" />
            {/if}
            {#if expirationText}
              <Badge variant="warning" size="sm">
                {expirationText}
              </Badge>
            {/if}
          </div>
        </div>
      {/snippet}

      <div class="cinder-approval-card__body">
        {@render operationPreview()}

        {@render filesTouchedSection()}

        {@render argumentsPreviewSection()}

        {#if hasDetails}
          <Collapsible trigger="Details" class="cinder-approval-card__details">
            <div class="cinder-approval-card__details-content">
              {#if sandbox}
                <div class="cinder-approval-card__details-group">
                  <p class="cinder-approval-card__details-label">Sandbox</p>
                  <dl
                    class="cinder-approval-card__metadata cinder-approval-card__metadata--compact"
                  >
                    <div class="cinder-approval-card__metadata-item">
                      <dt>Provider</dt>
                      <dd>{sandbox.provider}</dd>
                    </div>
                    <div class="cinder-approval-card__metadata-item">
                      <dt>Profile</dt>
                      <dd>{sandbox.name}</dd>
                    </div>
                    <div class="cinder-approval-card__metadata-item">
                      <dt>Working directory</dt>
                      <dd>{sandbox.workingDir}</dd>
                    </div>
                  </dl>
                </div>
              {/if}

              {#if environmentNames.length > 0}
                <div class="cinder-approval-card__details-group">
                  <p class="cinder-approval-card__details-label">Environment</p>
                  <ul
                    class="cinder-approval-card__environment-list"
                    aria-label="Environment variable names only; values are never shown"
                  >
                    {#each environmentNames as environmentName (environmentName)}
                      <li>
                        <Badge size="sm" monospace>{environmentName}</Badge>
                      </li>
                    {/each}
                  </ul>
                </div>
              {/if}

              <dl class="cinder-approval-card__metadata">
                <div class="cinder-approval-card__metadata-item">
                  <dt>Policy version</dt>
                  <dd>
                    {policyVersion}
                    <span class="cinder-approval-card__metadata-help">
                      Approval policy that produced this request.
                    </span>
                  </dd>
                </div>
                <div class="cinder-approval-card__metadata-item">
                  <dt>Idempotency key</dt>
                  <dd>
                    {idempotencyKey}
                    <span class="cinder-approval-card__metadata-help">
                      Keeps this decision durable if it is submitted more than once.
                    </span>
                  </dd>
                </div>
                {#if snapshotId}
                  <div class="cinder-approval-card__metadata-item">
                    <dt>Snapshot</dt>
                    <dd>
                      {snapshotId}
                      <span class="cinder-approval-card__metadata-help">
                        Workspace snapshot this request was captured against.
                      </span>
                    </dd>
                  </div>
                {/if}
              </dl>
            </div>
          </Collapsible>
        {/if}

        {#if isActionable && hasResolutionCallback}
          {#if failure !== undefined}
            <ApprovalCardFailure {failure} />
          {/if}
          <ApprovalCardActions
            idBase={rootId}
            requestKey={idempotencyKey}
            toolName={tool.label ?? tool.name}
            {rememberScope}
            {disabledReason}
            {resolving}
            {canEditArguments}
            argumentsValue={editableArgumentsValue}
            resolve={resolveIfActionable}
          />
          {#if footnote !== undefined}
            <p class="cinder-approval-card__footnote">{footnote}</p>
          {/if}
        {/if}
        {#if !isActionable}
          {#if showCardOutcome && outcomeText !== undefined}
            <ApprovalCardOutcome
              {outcomeText}
              outcomeTime={outcomeClock}
              tone={outcomeTone}
              {decisionNote}
              {decisionNoteCaption}
            />
          {/if}
          {#if readonlySummary !== undefined}
            <p class="cinder-approval-card__readonly-summary" data-cinder-state={effectiveState}>
              {readonlySummary}
            </p>
          {/if}
          {#if result !== undefined}
            <p class="cinder-approval-card__result">
              <span class="cinder-approval-card__result-label">Result:</span>
              {result}
            </p>
          {/if}
        {/if}
      </div>
    </Card>
  </article>
{/if}
