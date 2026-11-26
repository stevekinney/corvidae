<script lang="ts">
  /**
   * The pending-review page (COR-910, COR-2218): the model drawn with Cinder through the panel kit.
   * Text goes in as text, never as markup. The page is a `main` landmark with one labelled section
   * per review, a polite live region for outcomes, and buttons whose group names which review they
   * decide. The page redraws in place, so focus and a half-typed reason survive every poll.
   */
  import { Button, EmptyState, Section, Text, Textarea } from '@lostgradient/cinder';
  import {
    ReviewApprovalButtons,
    type ToolApprovalActions,
  } from '@lostgradient/bureau-client/reviews/ui';
  import type { ActionableReview } from './model.ts';

  import { IDLE_ROW, type ReviewsView } from './view.svelte.ts';

  /** What the page asks of its script: each decision, and the steps of writing a rejection. */
  type Handlers = {
    readonly onOpenReject: (id: string) => void;
    readonly onCancelReject: (id: string) => void;
    readonly onDraft: (id: string, text: string) => void;
  };

  let {
    view,
    handlers,
    actionsFor,
  }: {
    view: ReviewsView;
    handlers: Handlers;
    actionsFor(review: ActionableReview): ToolApprovalActions;
  } = $props();
</script>

<p role="status" aria-live="polite" id="reviews-status" class="panel-status">
  {view.announcement}
</p>

<main aria-labelledby="reviews-title" class="panel-page">
  <Text as="h1" variant="h3" id="reviews-title">Pending reviews ({view.views.length})</Text>
  {#if view.notice !== null}
    <p>{view.notice}</p>
  {/if}
  {#if view.views.length === 0}
    <EmptyState kind="done" headingLevel={2} title="Nothing is waiting for a decision." />
  {/if}

  {#each view.views as item (item.id)}
    {@const row = view.rows.get(item.id) ?? IDLE_ROW}
    {@const actions =
      item.actionableReview === undefined ? undefined : actionsFor(item.actionableReview)}
    {@const locked = !item.decidable || actions === undefined || actions.disabled}
    <Section title={item.title}>
      <ul aria-label={`Details of ${item.title}`} class="panel-list">
        {#each item.detail as line, index (index)}
          <li>{line}</li>
        {/each}
      </ul>
      {#if row.outcome !== null}
        <p class="panel-outcome">{row.outcome}</p>
      {/if}
      {#if actions}
        <ReviewApprovalButtons {actions} label={`Decide ${item.title}`} class="panel-actions">
          <Button
            id={`open-${item.id}`}
            variant="secondary"
            label="Reject with feedback"
            disabled={locked}
            onclick={() => handlers.onOpenReject(item.id)}
          />
        </ReviewApprovalButtons>
      {:else}
        <div role="group" aria-label={`Decide ${item.title}`} class="panel-actions">
          <Button id={`approve-${item.id}`} variant="primary" label="Approve" disabled />
          <Button id={`deny-${item.id}`} variant="secondary" label="Deny" disabled />
          <Button
            id={`open-${item.id}`}
            variant="secondary"
            label="Reject with feedback"
            disabled
          />
        </div>
      {/if}
      {#if row.rejecting && item.decidable}
        <div class="panel-reject">
          <Textarea
            id={`reason-${item.id}`}
            label="Feedback for the agent"
            rows={3}
            value={row.draft}
            oninput={(event: Event) =>
              handlers.onDraft(item.id, (event.currentTarget as HTMLTextAreaElement).value)}
          />
          <div class="panel-actions">
            <Button
              id={`send-${item.id}`}
              variant="primary"
              label="Send rejection"
              disabled={locked || row.draft.trim() === ''}
              onclick={() => actions?.reject(row.draft)}
            />
            <Button
              id={`cancel-${item.id}`}
              variant="secondary"
              label="Cancel"
              disabled={locked}
              onclick={() => handlers.onCancelReject(item.id)}
            />
          </div>
        </div>
      {/if}
    </Section>
  {/each}
</main>
