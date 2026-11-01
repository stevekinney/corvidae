<script lang="ts">
  /**
   * What Sources offers while a saved source is not running yet: a notice with Restart Interborough,
   * then the restart's progress and how it ended. The restart asks the host to restart
   * (`POST /host/restart`) and waits for it to answer again (`restart-flow.svelte.ts`); the tools of
   * the sources it loaded are then in Capabilities, so the lists are read again. A host nothing
   * supervises does not come back, and the notice says so instead of waiting for it.
   */
  import { Alert, Button, InlineLoading } from '@lostgradient/cinder';
  import { useQueryClient } from '@tanstack/svelte-query';

  import { CAPABILITIES_COPY } from '../../app/copy.ts';
  import { queryKeys } from '../../lib/query.ts';
  import type { SourcesRestartFlow } from './restart-flow.svelte.ts';

  interface Props {
    /** The restart this banner drives; the panel owns it so it outlives the sources that were waiting. */
    flow: SourcesRestartFlow;
    /** How many saved sources wait for a restart. */
    waiting: number;
    /** Whether the host refuses changes because it keeps its configuration in its deployment. */
    locked: boolean;
  }

  let { flow, waiting, locked }: Props = $props();

  const copy = CAPABILITIES_COPY.source.restart;
  const queryClient = useQueryClient();

  const progressLabel = $derived(
    flow.phase === 'stopping'
      ? copy.progress.stopping
      : flow.phase === 'starting'
        ? copy.progress.starting
        : copy.progress.requesting,
  );

  async function restart(): Promise<void> {
    await flow.run();
    if (flow.phase !== 'back') return;
    // The host runs the sources it loaded: their standing and their tools are new.
    await queryClient.invalidateQueries({ queryKey: queryKeys.toolSources.list() });
    await queryClient.invalidateQueries({ queryKey: queryKeys.agents.catalog() });
  }
</script>

{#if flow.running}
  <div class="ib-restart" role="status" data-testid="sources-restart-progress">
    <InlineLoading description={progressLabel} />
  </div>
{:else if flow.phase === 'back'}
  <Alert
    variant="success"
    dismissible
    onDismiss={() => flow.close()}
    data-testid="sources-restart-back"
  >
    <p class="ib-capabilities__alert-title">{copy.back}</p>
  </Alert>
{:else if flow.phase === 'unconfirmed'}
  <Alert
    variant="warning"
    dismissible
    onDismiss={() => flow.close()}
    data-testid="sources-restart-unconfirmed"
  >
    <p class="ib-capabilities__alert-title">{copy.unconfirmed}</p>
  </Alert>
{:else if waiting > 0}
  <Alert variant="info" data-testid="sources-restart">
    <p class="ib-capabilities__alert-title">{copy.title(waiting)}</p>
    <p>{copy.description}</p>
    {#if flow.refusal !== undefined}
      <p class="ib-restart__refusal" data-testid="sources-restart-refusal">
        {copy.refusal[flow.refusal]}
      </p>
    {/if}
    <Button
      data-changes
      variant="primary"
      size="sm"
      disabled={locked}
      onclick={() => void restart()}>{copy.action}</Button
    >
  </Alert>
{/if}

<style>
  .ib-restart {
    padding-block: var(--cinder-space-2);
  }

  .ib-restart__refusal {
    margin: 0;
    color: var(--cinder-text-danger);
  }
</style>
