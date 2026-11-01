<script lang="ts">
  /**
   * The popover on an agent's reply (COR-1983): why the reply ran on its model, what the model saw,
   * and the tokens its run used. The first two come from `bureau.tasks.inspect` for the reply's step,
   * read when the popover opens; the third from the run's terminal event, which the page holds only
   * for a run it watched end. A part with no source is left out, never estimated: the model's name,
   * the effort, the cost and the time are not carried by either.
   */
  import { Button, EmptyState, ErrorState, Popover, Skeleton } from '@lostgradient/cinder';
  import { Info } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';

  import { CHAT_COPY } from '../../app/copy.ts';
  import { inspectTaskStep } from '../../lib/bureau-tasks.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { isEmptyDetails, replyDetailsOf } from './reply-details.ts';
  import type { RunUsage } from './run-wiring.ts';

  interface ReplyDetailsProps {
    /** The reply's run: the task `bureau.tasks.inspect` takes. */
    runId: string;
    /** The reply's step in that run. */
    step: number;
    /** What the run's terminal event reported, when the page watched it end. */
    usage?: RunUsage | undefined;
  }

  let { runId, step, usage }: ReplyDetailsProps = $props();

  const COPY = CHAT_COPY.replyDetails;
  let open = $state(false);

  // Read when the popover opens, and kept for the next time; a failed read is tried again on demand.
  const inspected = createQuery(
    () => ({
      queryKey: queryKeys.bureauTasks.step(runId, step),
      queryFn: ({ signal }) => inspectTaskStep(runId, step, { signal }),
      enabled: open,
      retry: false,
    }),
    undefined,
  );
  const details = $derived(replyDetailsOf(inspected.data, usage));
</script>

<Popover bind:open placement="bottom-start" label={COPY.action} focusManagement="preserve">
  {#snippet trigger()}
    <Button
      type="button"
      class="chat-message-action-button"
      size="xs"
      variant="ghost"
      iconOnly
      label={COPY.action}
      onclick={() => (open = !open)}
    >
      <Info class="cinder-icon-xs" />
    </Button>
  {/snippet}
  <div class="weft-reply-details" data-testid="reply-details">
    {#if inspected.isPending && open}
      <div role="status" aria-busy="true" aria-label={COPY.loading}>
        <Skeleton height="1.25rem" />
        <Skeleton height="1.25rem" />
      </div>
    {:else if inspected.isError}
      <ErrorState
        variant="flat"
        title={COPY.failed.title}
        description={COPY.failed.description}
        headingLevel={3}
        retryLabel={COPY.retry}
        onRetry={() => void inspected.refetch()}
      />
    {:else if isEmptyDetails(details)}
      <EmptyState
        kind="first-use"
        size="compact"
        headingLevel={3}
        title={COPY.empty.title}
        description={COPY.empty.description}
      />
    {:else}
      {#if details.why !== undefined}
        <section class="weft-reply-details__part" data-part="why">
          <h3 class="weft-reply-details__heading">{COPY.why}</h3>
          <p class="weft-reply-details__lead">{details.why.reason}</p>
          <p class="weft-reply-details__note">{details.why.detail}</p>
          {#if details.why.passedOver.length > 0}
            <h4 class="weft-reply-details__subheading">{COPY.passedOver}</h4>
            <ul class="weft-reply-details__list">
              {#each details.why.passedOver as line (line)}
                <li>{line}</li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
      {#if details.saw !== undefined}
        <section class="weft-reply-details__part" data-part="saw">
          <h3 class="weft-reply-details__heading">{COPY.saw}</h3>
          <p class="weft-reply-details__lead">{details.saw.messages}</p>
          {#if details.saw.truncated}
            <p class="weft-reply-details__note">{COPY.truncated}</p>
          {/if}
          {#if details.saw.sources.length > 0}
            <h4 class="weft-reply-details__subheading">{COPY.sources}</h4>
            <ul class="weft-reply-details__list">
              {#each details.saw.sources as line (line)}
                <li>{line}</li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
      {#if details.usage.length > 0}
        <section class="weft-reply-details__part" data-part="usage">
          <h3 class="weft-reply-details__heading">{COPY.usage}</h3>
          <dl class="weft-reply-details__usage">
            {#each details.usage as entry (entry.kind)}
              <dt>{entry.kind}</dt>
              <dd>{entry.tokens}</dd>
            {/each}
          </dl>
          <p class="weft-reply-details__note">{COPY.usageNote}</p>
        </section>
      {/if}
    {/if}
  </div>
</Popover>
