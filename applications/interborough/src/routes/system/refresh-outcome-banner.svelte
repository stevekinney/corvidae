<script lang="ts">
  /**
   * Renders one {@link RefreshOutcome}, the result of a
   * `weft.workflows.refresh` check, as an explicit outcome banner that never
   * relies on color alone: every variant has its own badge word and sentence.
   * Owns no state; every prop is already resolved by the caller.
   */
  import { Badge, Button } from '@lostgradient/cinder';
  import { Ban, CircleAlert, CircleCheck, CircleMinus, RefreshCw } from '@lucide/svelte';

  import {
    notActivatedMessage,
    refusalReasonLines,
    type RefreshOutcome,
  } from './refresh-outcome.ts';

  interface Props {
    outcome: RefreshOutcome;
    onRefresh: () => void;
  }

  let { outcome, onRefresh }: Props = $props();
</script>

{#if outcome.kind === 'activated'}
  <div class="weft-refresh-outcome weft-refresh-outcome--success" role="status">
    <CircleCheck aria-hidden="true" size={16} />
    <div>
      <Badge variant="success">Activated</Badge>
      <p>Activated revision "{outcome.revision}" (generation {outcome.generation}).</p>
    </div>
  </div>
{:else if outcome.kind === 'installed'}
  <div class="weft-refresh-outcome weft-refresh-outcome--success" role="status">
    <CircleCheck aria-hidden="true" size={16} />
    <div>
      <Badge variant="success">Installed</Badge>
      <p>
        {outcome.revision === undefined
          ? 'The candidate'
          : `Candidate revision "${outcome.revision}"`} is installed and warmed. The active revision did
        not change.
      </p>
    </div>
  </div>
{:else if outcome.kind === 'not-modified'}
  <div class="weft-refresh-outcome weft-refresh-outcome--neutral" role="status">
    <CircleMinus aria-hidden="true" size={16} />
    <div>
      <Badge variant="neutral">Not modified</Badge>
      <p>
        The source answered 304: nothing changed since the last check{outcome.etag === undefined
          ? '.'
          : ` (ETag ${outcome.etag}).`}
      </p>
    </div>
  </div>
{:else if outcome.kind === 'not-activated'}
  {@const lines = refusalReasonLines(outcome.refusal)}
  <div class="weft-refresh-outcome weft-refresh-outcome--warning" role="alert">
    <RefreshCw aria-hidden="true" size={16} />
    <div>
      <Badge variant="warning">
        {outcome.refusal.reason === 'incompatible' ? 'Incompatible' : 'Not activated'}
      </Badge>
      <p>
        {outcome.revision === undefined
          ? 'The candidate'
          : `Candidate revision "${outcome.revision}"`}
        is installed. {notActivatedMessage(outcome.refusal)}
      </p>
      {#if lines.length > 0}
        <ul>
          {#each lines as line, index (index)}
            <li>{line}</li>
          {/each}
        </ul>
      {/if}
      <Button size="sm" variant="secondary" label="Refresh" onclick={onRefresh} />
    </div>
  </div>
{:else if outcome.kind === 'refused'}
  <div class="weft-refresh-outcome weft-refresh-outcome--danger" role="alert">
    <Ban aria-hidden="true" size={16} />
    <div>
      <Badge variant="danger">Refused</Badge>
      <p>{outcome.message} Nothing was installed.</p>
    </div>
  </div>
{:else}
  {@const label =
    outcome.kind === 'denied'
      ? 'Not authorized'
      : outcome.kind === 'source-unavailable'
        ? 'Source unavailable'
        : outcome.kind === 'no-source'
          ? 'No source'
          : outcome.kind === 'revision-removed'
            ? 'Revision removed'
            : outcome.kind === 'catalog-conflict'
              ? 'Conflict'
              : outcome.kind === 'invalid'
                ? 'Invalid request'
                : outcome.kind === 'malformed'
                  ? 'Malformed response'
                  : 'Failed'}
  <div class="weft-refresh-outcome weft-refresh-outcome--danger" role="alert">
    <CircleAlert aria-hidden="true" size={16} />
    <div>
      <Badge variant="danger">{label}</Badge>
      <p>{outcome.message}</p>
    </div>
  </div>
{/if}

<style>
  .weft-refresh-outcome {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: var(--cinder-density-pad-block) var(--cinder-density-pad-inline);
    border-radius: var(--cinder-radius-lg);
    border: 1px solid var(--cinder-border);
  }

  .weft-refresh-outcome p {
    margin: 6px 0 0;
    font-size: var(--cinder-text-sm);
  }

  .weft-refresh-outcome ul {
    margin: 6px 0 0;
    padding-inline-start: 1.1rem;
    font-size: var(--cinder-text-sm);
  }

  .weft-refresh-outcome--success {
    background: var(--cinder-status-success-background);
    border-color: var(--cinder-status-success-border);
  }

  .weft-refresh-outcome--warning {
    background: var(--cinder-status-warning-background);
    border-color: var(--cinder-status-warning-border);
  }

  .weft-refresh-outcome--danger {
    background: var(--cinder-status-danger-background);
    border-color: var(--cinder-status-danger-border);
  }

  .weft-refresh-outcome--neutral {
    background: var(--cinder-surface-raised);
  }
</style>
