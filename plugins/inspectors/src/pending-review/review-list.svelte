<script lang="ts">
  /**
   * The pending-review page (COR-910, COR-2218): the model drawn with Cinder through the panel kit.
   * Text goes in as text, never as markup. The page is a `main` landmark with one labelled section
   * per review, a polite live region for outcomes, and buttons whose group names which review they
   * decide. The page redraws in place, so focus and a half-typed reason survive every poll.
   */
  import { Button, Section, Text, Textarea } from '@lostgradient/cinder';

  import { IDLE_ROW, type ReviewsView } from './view.svelte.ts';

  /** What the page asks of its script: each decision, and the steps of writing a rejection. */
  type Handlers = {
    readonly onDecide: (id: string, decision: 'approve' | 'deny') => void;
    readonly onOpenReject: (id: string) => void;
    readonly onCancelReject: (id: string) => void;
    readonly onDraft: (id: string, text: string) => void;
    readonly onReject: (id: string) => void;
  };

  let { view, handlers }: { view: ReviewsView; handlers: Handlers } = $props();
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
    <p>Nothing is waiting for a decision.</p>
  {/if}

  {#each view.views as item (item.id)}
    {@const row = view.rows.get(item.id) ?? IDLE_ROW}
    {@const locked = !item.decidable || row.busy}
    <Section title={item.title}>
      <ul aria-label={`Details of ${item.title}`} class="panel-list">
        {#each item.detail as line, index (index)}
          <li>{line}</li>
        {/each}
      </ul>
      {#if row.outcome !== null}
        <p class="panel-outcome">{row.outcome}</p>
      {/if}
      <div role="group" aria-label={`Decide ${item.title}`} class="panel-actions">
        <Button
          id={`approve-${item.id}`}
          variant="primary"
          label="Approve"
          disabled={locked}
          onclick={() => handlers.onDecide(item.id, 'approve')}
        />
        <Button
          id={`deny-${item.id}`}
          variant="secondary"
          label="Deny"
          disabled={locked}
          onclick={() => handlers.onDecide(item.id, 'deny')}
        />
        <Button
          id={`open-${item.id}`}
          variant="secondary"
          label="Reject with feedback"
          disabled={locked}
          onclick={() => handlers.onOpenReject(item.id)}
        />
      </div>
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
              disabled={row.busy || row.draft.trim() === ''}
              onclick={() => handlers.onReject(item.id)}
            />
            <Button
              id={`cancel-${item.id}`}
              variant="secondary"
              label="Cancel"
              disabled={row.busy}
              onclick={() => handlers.onCancelReject(item.id)}
            />
          </div>
        </div>
      {/if}
    </Section>
  {/each}
</main>
