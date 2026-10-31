<script lang="ts">
  /**
   * What the person sees while the host restarts: the steps (saving the changes, asking for the
   * restart, waiting for the host to stop and to answer again), and then how it ended. It cannot be
   * dismissed while the restart runs, because the host does not answer and the page would show
   * nothing true. When the host answers again it says how many plugins are running; when the host
   * keeps answering with the old plugins loaded, it says it did not restart.
   */
  import { Button, Modal, Steps } from '@lostgradient/cinder';

  import { PLUGINS_COPY } from '../../../app/copy.ts';
  import { standingCounts } from './plugin-presentation.ts';
  import type { RestartFlow, RestartPhase } from './restart-flow.svelte.ts';

  interface Props {
    flow: RestartFlow;
  }

  let { flow }: Props = $props();

  const copy = PLUGINS_COPY.restart;
  const STEPS: readonly { phase: RestartPhase; label: string }[] = [
    { phase: 'saving', label: copy.steps.saving },
    { phase: 'requesting', label: copy.steps.requesting },
    { phase: 'stopping', label: copy.steps.stopping },
    { phase: 'starting', label: copy.steps.starting },
  ];

  const open = $derived(flow.phase !== 'idle');
  const current = $derived(STEPS.findIndex((step) => step.phase === flow.phase));
  const counts = $derived(flow.result === undefined ? undefined : standingCounts(flow.result));
  const title = $derived(
    flow.phase === 'back'
      ? copy.back.title
      : flow.phase === 'unconfirmed'
        ? copy.unconfirmed.title
        : copy.title,
  );
</script>

<Modal
  {open}
  {title}
  dismissOnEscape={!flow.running}
  dismissOnBackdropClick={false}
  closeButtonVisible={!flow.running}
  onDismiss={() => flow.close()}
>
  {#snippet children()}
    <div class="ib-restart" data-testid="plugins-restart" data-phase={flow.phase}>
      {#if flow.phase === 'back' && counts !== undefined}
        <p class="ib-restart__text" role="status">
          {copy.back.summary(counts.running, counts.needSetup, counts.disabled)}
        </p>
        <div class="ib-restart__actions">
          <Button variant="secondary" onclick={() => flow.close()}>{copy.back.close}</Button>
        </div>
      {:else if flow.phase === 'unconfirmed'}
        <p class="ib-restart__text" role="status">{copy.unconfirmed.description}</p>
        <div class="ib-restart__actions">
          <Button variant="secondary" onclick={() => flow.close()}>{copy.unconfirmed.close}</Button>
        </div>
      {:else}
        <Steps
          orientation="vertical"
          label={copy.title}
          steps={STEPS.map((step) => ({ id: step.phase, label: step.label }))}
          currentStep={Math.max(current, 0)}
        />
      {/if}
    </div>
  {/snippet}
</Modal>

<style>
  .ib-restart {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-restart__actions {
    display: flex;
  }

  .ib-restart__text {
    margin: 0;
  }
</style>
