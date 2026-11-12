<script lang="ts">
  /**
   * What one tab of an agent's page shows in its body while its read has nothing to show (board
   * PageAgent, "Loading" and "Error" frames, rows 39e to 39g). The header, its actions and the tab
   * bar stay live above it in every state.
   *
   * - Still reading with nothing to show: nothing for 300 ms, then placeholders in the tab's own
   *   shape (rows of a list, or the fields of a form), and after 10 s a "Still loading" line.
   * - The read failed with nothing to show: the error state in the tab body, with Try again.
   * - A later read failed while the tab shows data: a warning banner over the data, which stays at
   *   full contrast, saying when it was read; the page holds back Edit meanwhile
   *   (`agent-tab-stale.ts`). Never both the banner and the error state.
   */
  import type { Snippet } from 'svelte';

  import { Banner, ErrorState, Skeleton } from '@lostgradient/cinder';
  import { HttpClientError } from '@lostgradient/weft';

  import { AGENT_PAGE_COPY } from '../../app/copy/agents.ts';
  import { RETRY_LABEL } from '../../app/copy/views.ts';
  import { useAgentTabStale } from './agent-tab-stale.ts';

  interface Props {
    /** The tab's name, as the tab bar shows it, for the name of the loading region. */
    tab: string;
    /** The shape the placeholders take: rows of a list, or the fields of a form. */
    shape: 'rows' | 'form';
    /** Whether the tab's read is in flight. */
    pending: boolean;
    /** The tab's last read failure, or `null` when the last read succeeded. */
    error: unknown;
    /** When the data the tab shows was read, in epoch milliseconds, or `0` while it has none. */
    updatedAt: number;
    /** Reads the tab again. */
    onRetry: () => void;
    /** The tab's body, drawn once there is data to show. */
    children: Snippet;
  }

  let { tab, shape, pending, error, updatedAt, onRetry, children }: Props = $props();

  const copy = AGENT_PAGE_COPY.tabState;
  const failed = $derived(error !== null && error !== undefined);
  const hasData = $derived(updatedAt > 0);
  const stale = $derived(failed && hasData);
  /** The status the server answered the failed read with, when it answered. */
  const status = $derived(error instanceof HttpClientError ? error.status : undefined);

  const markStale = useAgentTabStale();
  $effect(() => {
    if (!stale) return;
    return markStale();
  });
</script>

{#if failed && !hasData}
  <div class="ib-agent-tab-state" data-testid="agent-tab-failed">
    <ErrorState
      variant="flat"
      title={copy.failedTitle}
      description={copy.failedDescription(status)}
      headingLevel={2}
      retryLabel={RETRY_LABEL}
      {onRetry}
    />
  </div>
{:else if !hasData && pending}
  <div class="ib-agent-tab-state" data-testid="agent-tab-loading">
    <Skeleton
      variant={shape === 'rows' ? 'list' : 'form'}
      rows={3}
      statusMarker="dot"
      delay={300}
      stillLoadingAfter={10_000}
      stillLoadingLabel={copy.stillLoading}
      label={copy.loading(tab)}
    />
  </div>
{:else}
  {#if stale}
    <Banner
      preset="refresh-failed"
      title={copy.staleTitle}
      subject={copy.staleSubject}
      dataUpdatedAt={updatedAt}
      retryLabel={RETRY_LABEL}
      {onRetry}
      data-testid="agent-tab-stale"
    />
  {/if}
  {@render children()}
{/if}

<style>
  .ib-agent-tab-state {
    padding-block: var(--cinder-space-4);
  }
</style>
