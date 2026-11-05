<script lang="ts">
  /**
   * Recent activity: the latest nine things that happened, one line each with the time at the right,
   * under a heading that names the zone ("Recent activity · Central time") and a link to the whole
   * audit log with the number of events it holds. A line is a run, a schedule, a provider key, the
   * server or a chat (`recent-activity.ts`); step noise is the run's own timeline.
   */
  import { Button, Skeleton } from '@lostgradient/cinder';

  import { router } from '../../lib/router.svelte.ts';
  import { HEALTH_ACTIVITY_COPY as copy } from './health-copy.ts';
  import type { ActivityLine } from './recent-activity.ts';

  interface Props {
    /** The lines, or `undefined` while they have not been read. */
    lines: readonly ActivityLine[] | undefined;
    /** How many events the audit log holds, once it is known. */
    total: number | undefined;
    /** Whether the lines could not be read. */
    failed?: boolean;
    onRetry?: (() => void) | undefined;
  }

  let { lines, total, failed = false, onRetry = undefined }: Props = $props();

  const AUDIT_PATH = '/health/audit';

  function openAudit(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(AUDIT_PATH);
  }
</script>

<section class="ib-recent-activity" aria-labelledby="ib-recent-activity-title">
  <div class="ib-recent-activity__heading-row">
    <h2 id="ib-recent-activity-title" class="ib-recent-activity__title">
      {copy.title}<span class="ib-recent-activity__zone"> · {copy.zone}</span>
    </h2>
    <a class="ib-recent-activity__audit" href={router.href(AUDIT_PATH)} onclick={openAudit}>
      {copy.auditLink(total)} ›
    </a>
  </div>

  {#if failed}
    <div class="ib-recent-activity__note" role="alert">
      <p>{copy.unavailable}</p>
      {#if onRetry !== undefined}
        <Button variant="secondary" size="sm" label={copy.retry} onclick={onRetry} />
      {/if}
    </div>
  {:else if lines === undefined}
    <div role="status" aria-busy="true" aria-label={`Loading ${copy.title.toLowerCase()}`}>
      {#each [0, 1, 2, 3] as placeholder (placeholder)}
        <div class="ib-recent-activity__skeleton"><Skeleton height="1rem" width="70%" /></div>
      {/each}
    </div>
  {:else if lines.length === 0}
    <p class="ib-recent-activity__note">{copy.empty}</p>
  {:else}
    <!-- A plain log line, not a list row: the text in regular weight and the time at the right.
         Cinder has no component for it, and a row's bold title is for something a person opens. -->
    <ul class="ib-recent-activity__list" aria-label={copy.listLabel}>
      {#each lines as line (line.id)}
        <li class="ib-recent-activity__line" data-activity={line.id}>
          <span class="ib-recent-activity__text">{line.text}</span>
          <span class="ib-recent-activity__time">{line.time}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .ib-recent-activity {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .ib-recent-activity__heading-row {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--cinder-space-1) var(--cinder-space-4);
  }

  .ib-recent-activity__title {
    margin: 0;
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .ib-recent-activity__zone {
    margin-inline-start: 0.35em;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    font-weight: 400;
  }

  .ib-recent-activity__audit {
    display: inline-flex;
    align-items: center;
    gap: var(--cinder-space-1);
    color: var(--cinder-accent-text);
    font-size: var(--cinder-text-sm);
    font-weight: 600;
    text-decoration: none;
  }

  .ib-recent-activity__audit:hover {
    text-decoration: underline;
  }

  .ib-recent-activity__list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .ib-recent-activity__line {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--cinder-space-4);
    min-block-size: 2.25rem;
    padding-block: var(--cinder-space-2);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  .ib-recent-activity__text {
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .ib-recent-activity__time {
    flex: none;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .ib-recent-activity__note {
    margin: 0;
    color: var(--cinder-text-muted);
  }

  .ib-recent-activity__skeleton {
    padding-block: var(--cinder-space-2);
  }
</style>
