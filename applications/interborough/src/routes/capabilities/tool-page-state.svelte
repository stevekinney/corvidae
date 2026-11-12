<script lang="ts">
  /**
   * The states of one tool's page that nothing old can fill (board SchemaAndJson, frames d, e and
   * f). While the tool loads, skeleton placeholders in the page's layout, then after 10 seconds
   * Cinder's own "still loading" line with a Cancel (never a banner). A tool that fails to load is
   * the full error state with a primary Try again, since nothing old can show. A tool that is not
   * in the catalog is a not-found state that names what is missing and offers one way back, and
   * the breadcrumb reads "Not found" in place of the identifier.
   */
  import { Button, EmptyState, ErrorState, Skeleton } from '@lostgradient/cinder';

  import { usePageLeaf } from '../../app/breadcrumbs.svelte.ts';
  import { CAPABILITIES_COPY } from '../../app/copy/capabilities.ts';
  import { NOT_FOUND_COPY, RETRY_LABEL } from '../../app/copy/views.ts';
  import { router } from '../../lib/router.svelte.ts';

  interface Props {
    /** Which state to draw: the tool is loading, it failed to load, or it is not in the catalog. */
    kind: 'loading' | 'failed' | 'not-found';
    /** Stops waiting for the tool; the Cancel of the slow-loading line. */
    onCancel?: (() => void) | undefined;
    /** Asks for the tool again; the primary Try again of the error state. */
    onRetry?: (() => void) | undefined;
  }

  let { kind, onCancel, onRetry }: Props = $props();

  const copy = CAPABILITIES_COPY.tool.page;
  const CAPABILITIES_PATH = '/capabilities';

  usePageLeaf(() => ({
    path: CAPABILITIES_PATH,
    label: kind === 'not-found' ? NOT_FOUND_COPY.breadcrumb : undefined,
  }));

  /** Goes back to the list, unless the person asked for a new tab or window. */
  function back(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(CAPABILITIES_PATH);
  }
</script>

{#if kind === 'loading'}
  <div data-testid="tool-loading">
    <Skeleton
      variant="card"
      lines={5}
      delay={300}
      stillLoadingAfter={10_000}
      stillLoadingLabel={copy.loading.stillLoading}
      label={copy.loading.label}
      {...onCancel === undefined ? {} : { onCancel }}
    />
  </div>
{:else if kind === 'failed'}
  <ErrorState
    title={copy.failed.title}
    description={copy.failed.description}
    headingLevel={3}
    retryLabel={RETRY_LABEL}
    {...onRetry === undefined ? {} : { onRetry }}
    data-testid="tool-load-failed"
  />
{:else}
  <EmptyState
    kind="not-found"
    headingLevel={3}
    title={copy.notFound.title}
    description={copy.notFound.description}
    data-testid="tool-not-found"
  >
    {#snippet action()}
      <Button variant="secondary" href={router.href(CAPABILITIES_PATH)} onclick={back}
        >{copy.notFound.back}</Button
      >
    {/snippet}
  </EmptyState>
{/if}
