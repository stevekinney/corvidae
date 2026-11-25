<script lang="ts">
  /**
   * One tool approval under its call in the transcript (COR-2016): Cinder's shared approval row.
   * Waiting, it asks the question with the tool, where it came from and the input, takes a note and
   * Allow for the rest of this chat, and offers Deny and Approve; while Interborough cannot be
   * reached both are off, with the reason written above them. Decided, it collapses to what was
   * asked and what became of it: "Approved by you 10:33 AM", or "Approved by you in Reviews
   * 10:46 AM" when the decision was made on another page while this one was open, with the note a
   * refusal carried. The row is a group named by its question and focusable by script alone, so the
   * page can bring the person to it on opening without answering it. A held approval of an agent
   * whose plugin is disabled reads Unavailable with its reason and no buttons; while no provider is
   * connected a waiting one stays answerable, and a muted line under it says the run continues once
   * a provider is connected.
   */
  import {
    ApprovalCard,
    Button,
    DecisionDeck,
    formatTimeOfDay,
    Modal,
    PayloadInspector,
    Text,
    Tooltip,
    type ApprovalFailure,
    type ApprovalOperation,
    type ApprovalResolution,
    type DecisionDeckOutcome,
  } from '@lostgradient/cinder';
  import { Layers } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  import { CHAT_COPY } from '../../app/copy/chat.ts';
  import { approvalQuestion, declaredSummary } from '../../lib/tool-text.ts';
  import { decidedByLabel, decidedPlace, type DecisionContext } from './approval-decision-words.ts';
  import type { ToolCallEntry } from './tool-activity.ts';

  interface ChatApprovalProps {
    'data-changes'?: boolean;
    /** A name that is unique on the page. */
    id: string;
    /** The call the approval is for. Its `decision` says it was decided, and how. */
    entry: ToolCallEntry;
    /** What a waiting approval asks, ending in a question mark. A decided one reads its own. */
    question: string;
    /** Who asked: the agent's name as a person reads it. */
    source: string;
    /** When the approval was asked, in epoch milliseconds, when the Bureau has said. */
    requestedAt?: number | undefined;
    /** Who the person is to this chat and where decisions were made, for a decided approval. */
    context: DecisionContext;
    operation?: ApprovalOperation | undefined;
    irreversible?: boolean | undefined;
    consequence?: string | undefined;
    why?: string | undefined;
    decidedInHref?: string | undefined;
    policyVersion?: string | undefined;
    idempotencyKey?: string | undefined;
    expiresAt?: string | undefined;
    actionLabel?: string | undefined;
    failure?: ApprovalFailure | undefined;
    /** Whether Interborough cannot be reached, which turns Deny and Approve off with the reason. */
    unreachable: boolean;
    disabledReason?: string | undefined;
    /**
     * Why nobody can answer it now, when the agent that asked is held back by a disabled plugin:
     * the approval reads Unavailable with this under it and offers no decision.
     */
    unavailableReason?: string | undefined;
    /** Said under a waiting approval while no provider is connected, such as "Tool runner continues once a provider is connected.". */
    providerNote?: string | undefined;
    /**
     * Whether the tool is set to Always, which asks on every call: "Allow for the rest of this chat"
     * is then not offered, because the grant would change nothing (decision 86).
     */
    alwaysAsks?: boolean | undefined;
    /** The answer on its way, which holds both buttons until it lands. */
    resolving?: 'approve' | 'deny' | undefined;
    onAskAgain?: (() => void) | undefined;
    /** Sends the person's decision, the note and the grant for the rest of the chat included. */
    onResolve: (resolution: ApprovalResolution) => void;
  }

  let {
    'data-changes': dataChanges = false,
    id,
    entry,
    question,
    source,
    requestedAt,
    context,
    operation,
    irreversible,
    consequence,
    why,
    decidedInHref,
    policyVersion,
    idempotencyKey,
    expiresAt,
    actionLabel,
    failure,
    unreachable,
    disabledReason,
    unavailableReason,
    providerNote,
    alwaysAsks,
    resolving,
    onAskAgain,
    onResolve,
  }: ChatApprovalProps = $props();

  const decision = $derived(entry.decision);
  const risk = $derived(
    entry.tier === 'read-only' ? 'low' : entry.tier === 'dangerous' ? 'high' : 'medium',
  );
  const place = $derived(decidedPlace(entry, context));
  const decidedQuestion = $derived(
    approvalQuestion({
      toolName: entry.title ?? entry.name,
      arguments: entry.arguments,
      // The sentence the decision recorded, unless it was only the policy's reason (COR-2438).
      summary: declaredSummary(decision?.asked),
    }),
  );
  const expired = $derived(
    entry.state === 'expired' ||
      (entry.approvalExpiresAt !== undefined && Date.now() >= entry.approvalExpiresAt) ||
      (expiresAt !== undefined &&
        Number.isFinite(Date.parse(expiresAt)) &&
        Date.parse(expiresAt) <= Date.now()),
  );
  // The moment the approval lapsed, as the host knows it: the action's own deadline, else the
  // entry's.
  const lapsedAt = $derived(
    expiresAt !== undefined && Number.isFinite(Date.parse(expiresAt))
      ? expiresAt
      : entry.approvalExpiresAt === undefined
        ? undefined
        : new Date(entry.approvalExpiresAt).toISOString(),
  );
  const copy = CHAT_COPY.approval;
  const requestKey = $derived(idempotencyKey ?? entry.callId);
  // Keep the review deck on the exact operation payload the live ApprovalCard receives. The
  // inspector preserves empty, text and unsupported values instead of serializing them here.
  const reviewedOperation = $derived(
    operation ?? { kind: 'other' as const, argsPreview: entry.arguments },
  );
  let deckFor = $state<string | undefined>();
  let selectedDecision = $state<'approve' | 'deny' | undefined>();

  function closeDeck(): void {
    deckFor = undefined;
    selectedDecision = undefined;
  }

  function reviewOutcome(outcome: DecisionDeckOutcome): void {
    if (outcome === 'later') closeDeck();
    else selectedDecision = outcome === 'accept' ? 'approve' : 'deny';
  }
</script>

{#snippet decisionReview(commit: (decision: 'approve' | 'deny') => void, disabled: boolean)}
  <Tooltip text={copy.reviewDeck} describe={false}>
    <Button
      type="button"
      variant="secondary"
      size="sm"
      iconOnly
      label={copy.reviewDeck}
      {disabled}
      onclick={() => {
        selectedDecision = undefined;
        deckFor = requestKey;
      }}
    >
      {#snippet leadingIcon()}<Layers aria-hidden="true" />{/snippet}
    </Button>
  </Tooltip>
  {#if deckFor === requestKey && !disabled}
    <DecisionDeck
      items={[{ id: requestKey, title: entry.name, eyebrow: source }]}
      label={copy.deckTitle}
      acceptLabel="Approve"
      rejectLabel="Deny"
      emptyTitle={copy.selectedDecision}
      emptyDescription=""
      onDecision={({ outcome }) => reviewOutcome(outcome)}
      onUndo={() => (selectedDecision = undefined)}
      card={reviewCard}
    >
      {#snippet layout(content: Snippet, actions: Snippet)}
        <Modal open title={copy.deckTitle} onDismiss={closeDeck}>
          <div class="weft-chat-approval__deck-content">
            {@render content()}
            {#if selectedDecision !== undefined}
              <section aria-label={copy.selectedDecision}>
                <Text variant="code">{entry.name}</Text>
                {@render reviewArguments()}
              </section>
            {/if}
          </div>
          {#snippet footer()}
            <div class="weft-chat-approval__deck-footer">
              {#if irreversible ?? entry.tier === 'dangerous'}
                <Text variant="caption">{copy.irreversible}</Text>
              {/if}
              {@render actions()}
              <div class="weft-chat-approval__deck-exits">
                <Button type="button" variant="secondary" onclick={closeDeck}>
                  {copy.returnToApproval}
                </Button>
                {#if selectedDecision !== undefined}
                  <Button
                    type="button"
                    variant="primary"
                    mutating
                    onclick={() => {
                      const decision = selectedDecision;
                      if (decision === undefined || deckFor !== requestKey || disabled) return;
                      closeDeck();
                      commit(decision);
                    }}
                  >
                    {selectedDecision === 'approve' ? copy.confirmApproval : copy.confirmDenial}
                  </Button>
                {/if}
              </div>
            </div>
          {/snippet}
        </Modal>
      {/snippet}
    </DecisionDeck>
  {/if}
{/snippet}

{#snippet reviewCard()}
  <Text variant="caption">{question}</Text>
  <Text variant="h4"><Text variant="code">{entry.name}</Text></Text>
  {@render reviewArguments()}
{/snippet}

{#snippet reviewArguments()}
  <PayloadInspector value={reviewedOperation.argsPreview} label="Arguments" bare />
{/snippet}

<ApprovalCard
  {...dataChanges ? { 'data-changes': true } : {}}
  {id}
  layout="decision"
  headingLevel={4}
  question={decision === undefined ? question : decidedQuestion}
  tool={{
    name: entry.name,
    ...(entry.title === undefined ? {} : { label: entry.title }),
    risk,
    ...(irreversible === undefined
      ? { irreversible: entry.tier === 'dangerous' }
      : { irreversible }),
  }}
  {source}
  {...requestedAt === undefined ? {} : { requestedAt }}
  operation={operation ?? { kind: 'other', argsPreview: entry.arguments }}
  policyVersion={policyVersion ?? id}
  idempotencyKey={requestKey}
  {decisionReview}
  {...consequence === undefined ? {} : { consequence }}
  {...why === undefined ? {} : { why }}
  {...expiresAt === undefined ? {} : { expiresAt }}
  {...actionLabel === undefined ? {} : { actionLabel }}
  {...failure === undefined ? {} : { failure }}
  {...onAskAgain === undefined ? {} : { onAskAgain }}
  state={decision === undefined
    ? unavailableReason === undefined
      ? expired
        ? 'expired'
        : 'pending'
      : 'unavailable'
    : decision.outcome === 'approved'
      ? 'approved'
      : 'denied'}
  {...decision === undefined
    ? unavailableReason === undefined
      ? {
          ...(alwaysAsks === true ? {} : { rememberScope: CHAT_COPY.approval.rememberScope }),
          ...(disabledReason === undefined
            ? unreachable
              ? { disabledReason: CHAT_COPY.approval.unreachable }
              : {}
            : { disabledReason }),
          ...(resolving === undefined ? {} : { resolving }),
          onResolve,
        }
      : { unavailableReason }
    : {
        decidedBy: decidedByLabel(decision, context.owner),
        decidedAt: decision.decidedAt,
        ...(place === undefined
          ? {}
          : { decidedIn: place, ...(decidedInHref === undefined ? {} : { decidedInHref }) }),
        ...(decision.reason === undefined ? {} : { decisionNote: decision.reason }),
      }}
  {...decision === undefined
    ? {
        'data-approval-decision': true,
        'data-cinder-tool-approval': true,
        'data-cinder-tool-approval-call-id': entry.railId ?? entry.callId,
        tabindex: -1,
      }
    : {}}
/>
{#if decision === undefined && unavailableReason === undefined && expired && lapsedAt !== undefined}
  <!-- When it lapsed is a line under the card in a message's time style. -->
  <div class="chat-approval-time">
    <time datetime={lapsedAt}><bdi>{formatTimeOfDay(lapsedAt)}</bdi></time>
  </div>
{/if}
{#if decision === undefined && unavailableReason === undefined && providerNote !== undefined}
  <p class="weft-chat-approval__provider-note">{providerNote}</p>
{/if}

<style>
  .weft-chat-approval__deck-content,
  .weft-chat-approval__deck-footer {
    display: grid;
    gap: var(--cinder-space-4);
    max-inline-size: 26rem;
    margin-inline: auto;
  }

  .weft-chat-approval__deck-footer {
    inline-size: 100%;
  }

  .weft-chat-approval__deck-exits {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .weft-chat-approval__deck-exits > :global(button) {
    flex: 1 1 auto;
  }
</style>
