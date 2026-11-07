<script lang="ts">
  /**
   * What the person sees while the host restarts, drawn by Cinder's `RestartState`: the steps while
   * the host still answers, the reconnect attempts once it stops (with Retry now), and, when it
   * never answers, what to check and the exact command to start it again, with Keep waiting as the
   * one way on. It cannot be dismissed while the restart runs, because the host does not answer and
   * the page behind it would show nothing true. When the host answers again it closes and the page
   * says what applied (`restart-back-banner.svelte`).
   *
   * A page that keeps its content on screen while the host restarts (a chat) shows the progress as
   * Cinder's restart banner and sets `failedOnly`, so this opens only for a restart that never came
   * back.
   */
  import { RestartState } from '@lostgradient/cinder';

  import { RESTART_COPY } from '../copy.ts';
  import type { RestartIntent, RestartPhase } from './host-restart-flow.svelte.ts';

  /** What the dialog reads from a restart flow, whatever it watches the host through. */
  interface Props {
    flow: {
      readonly phase: RestartPhase;
      readonly open: boolean;
      readonly intent: RestartIntent;
      readonly attempt: number;
      readonly retryInSeconds: number | undefined;
      readonly launchCommand: string | undefined;
      readonly lastError: string | undefined;
      retryNow(): void;
      keepWaiting(): void;
    };
    /** Draw only the failed state, because the page shows the progress itself. */
    failedOnly?: boolean;
  }

  let { flow, failedOnly = false }: Props = $props();

  const phase = $derived(
    flow.phase === 'failed' ? 'failed' : flow.phase === 'starting' ? 'reconnecting' : 'restarting',
  );
  const description = $derived.by(() => {
    const { changes, disabling } = flow.intent;
    if (flow.phase === 'failed') {
      return RESTART_COPY.failed.description(changes.length, disabling?.title);
    }
    if (phase === 'restarting') {
      return disabling === undefined
        ? RESTART_COPY.restarting.description
        : RESTART_COPY.restarting.unloading(disabling.title);
    }
    return undefined;
  });
  // The saved choice is done before the request; the stop is under way until the host stops answering.
  const doneSteps = $derived(flow.phase === 'saving' ? 0 : 1);
</script>

<RestartState
  open={flow.open && (!failedOnly || flow.phase === 'failed')}
  {phase}
  {description}
  steps={RESTART_COPY.steps}
  currentStep={doneSteps}
  attempt={flow.attempt === 0 ? undefined : flow.attempt}
  retryInSeconds={flow.retryInSeconds}
  onRetry={() => flow.retryNow()}
  check={RESTART_COPY.failed.check}
  command={flow.launchCommand}
  onKeepWaiting={() => flow.keepWaiting()}
>
  {#snippet details()}
    <code class="ib-restart-details" data-testid="restart-error-details"
      >{flow.lastError ?? 'No answer.'}</code
    >
  {/snippet}
</RestartState>

<style>
  .ib-restart-details {
    font-family: var(--cinder-font-mono);
    overflow-wrap: anywhere;
  }
</style>
